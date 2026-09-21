import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PluginManifestSchema, type PluginManifest } from "@memorylane/plugin-sdk";
import type { PluginPlatformPaths } from "./paths.js";

const InstalledPluginStateSchema = z.object({
  activeVersion: z.string().nullable(),
  enabled: z.boolean(),
  installedVersions: z.array(z.string()),
  lastError: z.string().nullable(),
}).strict();

export const PluginStateSchema = z.object({
  formatVersion: z.literal(1),
  onboardingComplete: z.boolean(),
  plugins: z.record(InstalledPluginStateSchema),
}).strict();

export type PluginState = z.infer<typeof PluginStateSchema>;
export type InstalledPluginState = z.infer<typeof InstalledPluginStateSchema>;

const EMPTY_STATE: PluginState = { formatVersion: 1, onboardingComplete: false, plugins: {} };

export class PluginStateStore {
  private state: PluginState;

  constructor(private readonly paths: PluginPlatformPaths) {
    this.state = this.read();
  }

  snapshot(): PluginState {
    return structuredClone(this.state);
  }

  update(mutator: (draft: PluginState) => void): PluginState {
    const next = structuredClone(this.state);
    mutator(next);
    this.state = PluginStateSchema.parse(next);
    this.writeAtomic(this.state);
    return this.snapshot();
  }

  // protectedIds: ids that never have an installed/<id>/<version>/ directory
  // by design (dev-catalog plugins, loaded straight from source - see
  // PluginManager's devPlugins) and so would otherwise look exactly like a
  // stale/removed install to the pruning below and get silently deleted on
  // every boot, right before startEnabled() gets a chance to read them back.
  reconcile(protectedIds: ReadonlySet<string> = new Set()): Map<string, Map<string, PluginManifest>> {
    const discovered = new Map<string, Map<string, PluginManifest>>();
    for (const pluginEntry of safeDirectories(this.paths.versionsDir)) {
      const versions = new Map<string, PluginManifest>();
      for (const versionEntry of safeDirectories(path.join(this.paths.versionsDir, pluginEntry))) {
        try {
          const manifest = PluginManifestSchema.parse(JSON.parse(fs.readFileSync(
            path.join(this.paths.versionsDir, pluginEntry, versionEntry, "manifest.json"), "utf8",
          )));
          if (manifest.id === pluginEntry && manifest.version === versionEntry) versions.set(versionEntry, manifest);
        } catch { /* invalid or incomplete version folders are never activated */ }
      }
      if (versions.size > 0) discovered.set(pluginEntry, versions);
    }
    this.update((draft) => {
      for (const [id, versions] of discovered) {
        const existing = draft.plugins[id];
        draft.plugins[id] = {
          activeVersion: existing?.activeVersion && versions.has(existing.activeVersion) ? existing.activeVersion : null,
          enabled: existing?.enabled ?? false,
          installedVersions: [...versions.keys()].sort(),
          lastError: existing?.lastError ?? null,
        };
      }
      for (const id of Object.keys(draft.plugins)) if (!discovered.has(id) && !protectedIds.has(id)) delete draft.plugins[id];
    });
    return discovered;
  }

  private read(): PluginState {
    try {
      return PluginStateSchema.parse(JSON.parse(fs.readFileSync(this.paths.statePath, "utf8")));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return structuredClone(EMPTY_STATE);
      try { fs.renameSync(this.paths.statePath, `${this.paths.statePath}.invalid-${Date.now()}`); } catch { /* best effort */ }
      return structuredClone(EMPTY_STATE);
    }
  }

  private writeAtomic(state: PluginState): void {
    const temporary = path.join(this.paths.rootDir, `.plugins-state-${randomUUID()}.tmp`);
    const handle = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(handle, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      fs.fsyncSync(handle);
    } finally { fs.closeSync(handle); }
    try {
      fs.renameSync(temporary, this.paths.statePath);
    } catch {
      const previous = `${this.paths.statePath}.previous`;
      fs.rmSync(previous, { force: true });
      if (fs.existsSync(this.paths.statePath)) fs.renameSync(this.paths.statePath, previous);
      try {
        fs.renameSync(temporary, this.paths.statePath);
        fs.rmSync(previous, { force: true });
      } catch (replacementError) {
        if (fs.existsSync(previous) && !fs.existsSync(this.paths.statePath)) fs.renameSync(previous, this.paths.statePath);
        throw replacementError;
      }
    }
  }
}

function safeDirectories(directory: string): string[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch { return []; }
}
