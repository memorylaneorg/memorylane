import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID, type KeyLike } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import extract from "extract-zip";
import {
  PluginManifestSchema,
  isSafePluginRelativePath,
  verifyEd25519Signature,
  type PluginCatalogRelease,
  type PluginManifest,
} from "@memorylane/plugin-sdk";
import type { PluginPlatformPaths } from "./paths.js";
import { pluginVersionDir } from "./paths.js";
import type { PluginStateStore } from "./state-store.js";

export interface PluginInstallOptions {
  artifactBaseUrl: string;
  publicKey: KeyLike;
  maxDownloadBytes?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (downloaded: number, total: number | null) => void;
  artifactPath?: string;
}

export class PluginInstaller {
  constructor(private readonly paths: PluginPlatformPaths, private readonly state: PluginStateStore) {
    this.recoverInterrupted();
  }

  recoverInterrupted(): void {
    for (const directory of [this.paths.downloadsDir, this.paths.stagingDir]) {
      for (const entry of fs.readdirSync(directory)) fs.rmSync(path.join(directory, entry), { recursive: true, force: true });
    }
  }

  async install(release: PluginCatalogRelease, options: PluginInstallOptions): Promise<string> {
    const { manifest, artifact } = release;
    const finalDir = pluginVersionDir(this.paths, manifest.id, manifest.version);
    if (fs.existsSync(finalDir)) throw new Error(`${manifest.id} ${manifest.version} is already installed`);

    const partial = path.join(this.paths.downloadsDir, `${manifest.id}-${manifest.version}-${randomUUID()}.partial`);
    const staging = path.join(this.paths.stagingDir, `${manifest.id}-${manifest.version}-${randomUUID()}`);
    try {
      if (options.artifactPath) fs.copyFileSync(options.artifactPath, partial);
      else await this.download(new URL(artifact.url, options.artifactBaseUrl), partial, artifact.size, options);
      if (fs.statSync(partial).size !== artifact.size) throw new Error("Plugin artifact size mismatch");
      if (await sha256File(partial) !== artifact.sha256) throw new Error("Plugin artifact SHA-256 does not match the catalog");
      if (!verifyEd25519Signature(Buffer.from(artifact.sha256, "hex"), artifact.signature, options.publicKey)) {
        throw new Error("Plugin artifact signature is invalid");
      }

      fs.mkdirSync(staging, { recursive: true });
      let declaredInstalledBytes = 0;
      await extract(partial, {
        dir: staging,
        onEntry: (entry: { fileName: string; externalFileAttributes: number; uncompressedSize: number }) => {
          const entryPath = entry.fileName.replace(/\/$/, "");
          if (entryPath && !isSafePluginRelativePath(entryPath)) throw new Error(`Unsafe plugin archive path: ${entry.fileName}`);
          const fileType = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (fileType === 0o120000) throw new Error(`Plugin archives cannot contain symbolic links: ${entry.fileName}`);
          declaredInstalledBytes += entry.uncompressedSize;
          if (declaredInstalledBytes > artifact.installedSize) throw new Error("Plugin archive expands beyond its declared installed size");
        },
      });
      assertTreeContainsNoLinks(staging);
      if (treeFileBytes(staging) !== artifact.installedSize) throw new Error("Plugin installed size does not match the catalog");
      const installedManifest = PluginManifestSchema.parse(JSON.parse(fs.readFileSync(path.join(staging, "manifest.json"), "utf8")));
      if (JSON.stringify(installedManifest) !== JSON.stringify(manifest)) throw new Error("Plugin archive manifest does not match the signed catalog");

      fs.mkdirSync(path.dirname(finalDir), { recursive: true });
      fs.renameSync(staging, finalDir);
      this.state.update((draft) => {
        const existing = draft.plugins[manifest.id];
        draft.plugins[manifest.id] = {
          activeVersion: existing?.activeVersion ?? null,
          enabled: existing?.enabled ?? false,
          installedVersions: [...new Set([...(existing?.installedVersions ?? []), manifest.version])].sort(),
          lastError: null,
        };
      });
      return finalDir;
    } finally {
      fs.rmSync(partial, { force: true });
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  activate(manifest: PluginManifest): void {
    const directory = pluginVersionDir(this.paths, manifest.id, manifest.version);
    if (!fs.existsSync(path.join(directory, "manifest.json"))) throw new Error("Plugin version is not installed");
    this.state.update((draft) => {
      const plugin = draft.plugins[manifest.id];
      if (!plugin?.installedVersions.includes(manifest.version)) throw new Error("Plugin version is not registered");
      plugin.activeVersion = manifest.version;
      plugin.enabled = true;
      plugin.lastError = null;
    });
  }

  uninstall(pluginId: string, version: string): void {
    const target = pluginVersionDir(this.paths, pluginId, version);
    if (!path.resolve(target).startsWith(path.resolve(this.paths.versionsDir) + path.sep)) throw new Error("Invalid plugin path");
    // For a service-kind plugin, this runs right after disable() confirms
    // its process has exited - but Windows can hold the file lock on a
    // just-exited executable (and any DLLs it loaded, e.g. numpy's for the
    // AI runtime) open for a brief moment longer than the process itself
    // survives. maxRetries/retryDelay is Node's own documented answer to
    // exactly this race, not a custom workaround.
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    this.state.update((draft) => {
      const plugin = draft.plugins[pluginId];
      if (!plugin) return;
      plugin.installedVersions = plugin.installedVersions.filter((item) => item !== version);
      if (plugin.activeVersion === version) {
        plugin.activeVersion = null;
        plugin.enabled = false;
      }
      if (plugin.installedVersions.length === 0) delete draft.plugins[pluginId];
    });
  }

  private async download(url: URL, destination: string, expectedSize: number, options: PluginInstallOptions): Promise<void> {
    if (url.protocol !== "https:" && !(url.protocol === "http:" && /^(127\.0\.0\.1|localhost)$/.test(url.hostname))) {
      throw new Error("Plugin artifacts require HTTPS");
    }
    const response = await (options.fetchImpl ?? fetch)(url, { signal: options.signal, redirect: "error" });
    if (!response.ok || !response.body) throw new Error(`Plugin download returned HTTP ${response.status}`);
    const maximum = options.maxDownloadBytes ?? 2 * 1024 * 1024 * 1024;
    if (expectedSize > maximum) throw new Error("Plugin artifact exceeds the download size limit");
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > maximum) throw new Error("Plugin artifact exceeds the download size limit");
    let downloaded = 0;
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        downloaded += chunk.length;
        if (downloaded > maximum) return callback(new Error("Plugin artifact exceeds the download size limit"));
        options.onProgress?.(downloaded, declared || null);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body as never), counter, fs.createWriteStream(destination, { flags: "wx", mode: 0o600 }));
    if (downloaded !== expectedSize) throw new Error(`Plugin artifact size mismatch: expected ${expectedSize}, received ${downloaded}`);
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function assertTreeContainsNoLinks(root: string): void {
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) throw new Error(`Plugin archive contains a symbolic link: ${entry.name}`);
      if (stat.isDirectory()) walk(entryPath);
    }
  };
  walk(root);
}

function treeFileBytes(root: string): number {
  let bytes = 0;
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else bytes += fs.statSync(entryPath).size;
    }
  };
  walk(root);
  return bytes;
}
