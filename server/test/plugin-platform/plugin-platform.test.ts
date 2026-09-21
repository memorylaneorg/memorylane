import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { PluginCatalogSchema, sha256Hex, type PluginManifest } from "@memorylane/plugin-sdk";
import { PluginCatalogLoader } from "../../src/plugin-platform/catalog-loader.js";
import { PluginInstaller } from "../../src/plugin-platform/installer.js";
import { resolvePluginPlatformPaths } from "../../src/plugin-platform/paths.js";
import { PluginServiceSupervisor } from "../../src/plugin-platform/service-supervisor.js";
import { PluginModuleHost } from "../../src/plugin-platform/module-host-client.js";
import { PluginCommandRunner } from "../../src/plugin-platform/command-runner.js";
import { PluginStateStore } from "../../src/plugin-platform/state-store.js";
import { PluginManager } from "../../src/plugin-platform/manager.js";

const scratchDirs: string[] = [];
afterEach(() => {
  for (const directory of scratchDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function scratch() {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-platform-"));
  scratchDirs.push(result);
  return result;
}

function serviceManifest(executable: string, args: string[] = []): PluginManifest {
  return {
    id: "com.memorylane.fixture",
    name: "Fixture",
    description: "Lifecycle test fixture.",
    version: "1.0.0",
    pluginApi: 1,
    requiresCore: ">=0.1.0 <1.0.0",
    platform: process.platform === "win32" ? "win32-x64" : process.platform === "darwin" ? "darwin-x64" : "linux-x64",
    required: false,
    infra: false,
    entry: { kind: "service", executable, args },
    capabilities: ["fixture.health"],
    dependencies: [],
    health: { path: "/health", timeoutSeconds: 5 },
    restart: { policy: "never", maxAttempts: 0 },
    licenseFiles: ["licenses/test.txt"],
  };
}

describe("PluginStateStore", () => {
  it("writes atomically and reconciles installed folders", () => {
    const paths = resolvePluginPlatformPaths(scratch());
    const state = new PluginStateStore(paths);
    const manifest = serviceManifest("bin/fixture.exe");
    const versionDir = path.join(paths.versionsDir, manifest.id, manifest.version);
    fs.mkdirSync(versionDir, { recursive: true });
    fs.writeFileSync(path.join(versionDir, "manifest.json"), JSON.stringify(manifest));
    state.reconcile();
    state.update((draft) => {
      draft.plugins[manifest.id].activeVersion = manifest.version;
      draft.plugins[manifest.id].enabled = true;
    });
    expect(new PluginStateStore(paths).snapshot().plugins[manifest.id]).toMatchObject({
      activeVersion: "1.0.0", enabled: true, installedVersions: ["1.0.0"],
    });
    expect(fs.readdirSync(paths.rootDir).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("quarantines invalid state and reconstructs from disk", () => {
    const paths = resolvePluginPlatformPaths(scratch());
    fs.writeFileSync(paths.statePath, "not-json");
    const state = new PluginStateStore(paths);
    expect(state.snapshot().plugins).toEqual({});
    expect(fs.readdirSync(paths.rootDir).some((name) => name.includes(".invalid-"))).toBe(true);
  });
});

describe("plugin update policy", () => {
  it("lists first-party optional plugins before a catalog is configured", async () => {
    const paths = resolvePluginPlatformPaths(scratch()), { publicKey } = generateKeyPairSync("ed25519");
    const manager = new PluginManager({ paths, dataDir: scratch(), coreVersion: "0.2.0", platform: serviceManifest("node").platform, publicKey });
    const inventory = manager.inventory();
    // Metadata/RAW and video are core dependencies now, not plugins - no
    // first-party plugin is required anymore, only the optional AI ones.
    expect(inventory).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "com.memorylane.people", name: "People", required: false, version: null }),
    ]));
    expect(inventory.every((item) => !item.required)).toBe(true);
    // AI Runtime is infra (pure dependency, no capability a user benefits
    // from directly) - it never appears on its own, even though other
    // plugins depend on it and installing one still pulls it in transparently.
    expect(inventory.some((item) => item.id === "com.memorylane.ai-runtime")).toBe(false);
    await manager.shutdown();
  });

  it("isEnabled() reflects a dev-catalog plugin's real enabled state, not the (always-empty) persisted state store", async () => {
    const paths = resolvePluginPlatformPaths(scratch()), { publicKey } = generateKeyPairSync("ed25519");
    // A real, minimal health server on a fixed port - the noop dev-service
    // lifecycle (manifest.entry.devPort) health-checks it instead of
    // spawning anything, so this is enough to exercise a real enable()
    // without a module-host child process (which module-host.js can't
    // resolve when running from unbuilt TS, a separate pre-existing gap).
    const devPort = 41780 + Math.floor(Math.random() * 500);
    const health = http.createServer((req, res) => {
      if (req.headers.authorization !== "Bearer memorylane-dev") { res.writeHead(401); return res.end(); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ready", pluginId: "com.memorylane.dev-fixture", version: "1.0.0", pluginApi: 1 }));
    }).listen(devPort, "127.0.0.1");
    try {
      const manifest: PluginManifest = {
        ...serviceManifest("unused"),
        id: "com.memorylane.dev-fixture",
        name: "Dev Fixture",
        entry: { kind: "service", executable: "unused", args: [], devPort },
      };
      const devPlugins = new Map([[manifest.id, { manifest, sourceDir: "" }]]);
      const manager = new PluginManager({ paths, dataDir: scratch(), coreVersion: "0.2.0", platform: manifest.platform, publicKey, devPlugins });
      // This is the exact bug PluginAiProvider.requireFeature() hit for
      // AI Search/People: isEnabled() only ever checked the persisted state
      // store, which a dev-catalog plugin never writes to - so it always
      // reported "not enabled" regardless of the real (devEnabled) state.
      expect(manager.isEnabled(manifest.id)).toBe(false);
      await manager.enable(manifest.id, manifest.version);
      expect(manager.isEnabled(manifest.id)).toBe(true);
      await manager.disable(manifest.id);
      expect(manager.isEnabled(manifest.id)).toBe(false);
      await manager.shutdown();
    } finally { health.close(); }
  });

  it("hides an infra release from inventory but resolves it as a human-readable dependency name on its dependent", async () => {
    const paths = resolvePluginPlatformPaths(scratch()), { publicKey } = generateKeyPairSync("ed25519");
    const manager = new PluginManager({ paths, dataDir: scratch(), coreVersion: "0.2.0", platform: serviceManifest("node").platform, publicKey });
    const infra: PluginManifest = { ...serviceManifest("bin/infra.exe"), id: "com.memorylane.test-infra", name: "Test Infra", infra: true };
    const dependent: PluginManifest = {
      ...serviceManifest("bin/dependent.exe"),
      id: "com.memorylane.test-dependent",
      name: "Test Dependent",
      dependencies: [{ id: infra.id, version: ">=1.0.0 <2.0.0" }],
    };
    const releaseFor = (manifest: PluginManifest) => ({
      manifest,
      artifact: { url: `${manifest.id}.mlplugin`, size: 0, installedSize: 0, sha256: "0".repeat(64), signature: "AAAA" },
      releaseNotes: "", mandatory: false,
    });
    manager.setCatalog(PluginCatalogSchema.parse({
      formatVersion: 1, channel: "stable", generatedAt: new Date().toISOString(),
      releases: [releaseFor(infra), releaseFor(dependent)],
    }));
    const inventory = manager.inventory();
    expect(inventory.some((item) => item.id === infra.id)).toBe(false);
    expect(inventory).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: dependent.id, name: "Test Dependent", dependsOn: ["Test Infra"] }),
    ]));
    await manager.shutdown();
  });

  it("shows an infra plugin normally once installed, and refuses to remove it while a dependent is still installed", async () => {
    const paths = resolvePluginPlatformPaths(scratch()), { publicKey } = generateKeyPairSync("ed25519");
    const infra: PluginManifest = { ...serviceManifest("bin/infra.exe"), id: "com.memorylane.test-infra", name: "Test Infra", infra: true };
    const dependent: PluginManifest = {
      ...serviceManifest("bin/dependent.exe"),
      id: "com.memorylane.test-dependent",
      name: "Test Dependent",
      dependencies: [{ id: infra.id, version: ">=1.0.0 <2.0.0" }],
    };
    for (const manifest of [infra, dependent]) {
      const dir = path.join(paths.versionsDir, manifest.id, manifest.version);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
    }
    const manager = new PluginManager({ paths, dataDir: scratch(), coreVersion: "0.2.0", platform: infra.platform, publicKey });
    manager.state.update((draft) => {
      draft.plugins[infra.id] = { activeVersion: infra.version, enabled: false, installedVersions: [infra.version], lastError: null };
      draft.plugins[dependent.id] = { activeVersion: dependent.version, enabled: false, installedVersions: [dependent.version], lastError: null };
    });

    // Installed but disabled still counts - enable() never re-runs
    // dependency installation, so a disabled dependent re-enabled later
    // would find nothing there if this were allowed through.
    expect(manager.inventory()).toEqual(expect.arrayContaining([expect.objectContaining({ id: infra.id, name: "Test Infra" })]));
    await expect(manager.uninstall(infra.id, infra.version)).rejects.toThrow(/Test Dependent/);

    await manager.uninstall(dependent.id, dependent.version);
    await expect(manager.uninstall(infra.id, infra.version)).resolves.toBeUndefined();
    await manager.shutdown();
  });

  it("enabledDependents() only counts a dependent that's actually enabled, not merely installed", async () => {
    const paths = resolvePluginPlatformPaths(scratch()), { publicKey } = generateKeyPairSync("ed25519");
    const infra: PluginManifest = { ...serviceManifest("bin/infra.exe"), id: "com.memorylane.test-infra", name: "Test Infra", infra: true };
    const dependent: PluginManifest = {
      ...serviceManifest("bin/dependent.exe"),
      id: "com.memorylane.test-dependent",
      name: "Test Dependent",
      dependencies: [{ id: infra.id, version: ">=1.0.0 <2.0.0" }],
    };
    for (const manifest of [infra, dependent]) {
      const dir = path.join(paths.versionsDir, manifest.id, manifest.version);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
    }
    const manager = new PluginManager({ paths, dataDir: scratch(), coreVersion: "0.2.0", platform: infra.platform, publicKey });
    manager.state.update((draft) => {
      draft.plugins[infra.id] = { activeVersion: infra.version, enabled: true, installedVersions: [infra.version], lastError: null };
      draft.plugins[dependent.id] = { activeVersion: dependent.version, enabled: false, installedVersions: [dependent.version], lastError: null };
    });
    // Dependent is installed but not enabled - safe to disable the dependency.
    expect(manager.enabledDependents(infra.id)).toEqual([]);
    manager.state.update((draft) => { draft.plugins[dependent.id].enabled = true; });
    // Now it's actively in use - this is the check plugin-routes.ts's PUT
    // handler uses to refuse a disable request with a 409, the same
    // situation as disabling AI Runtime while AI Search is still enabled.
    expect(manager.enabledDependents(infra.id)).toEqual(["Test Dependent"]);
    await manager.shutdown();
  });

  it("offers only newer non-revoked versions and rejects downgrades", async () => {
    const paths=resolvePluginPlatformPaths(scratch()),{publicKey}=generateKeyPairSync("ed25519");
    const current={...serviceManifest("bin/fixture.exe"),version:"2.0.0"};
    const versionDir=path.join(paths.versionsDir,current.id,current.version);fs.mkdirSync(versionDir,{recursive:true});fs.writeFileSync(path.join(versionDir,"manifest.json"),JSON.stringify(current));
    const manager=new PluginManager({paths,dataDir:scratch(),coreVersion:"0.2.0",platform:current.platform,publicKey});
    manager.state.update(draft=>{draft.plugins[current.id].activeVersion=current.version;draft.plugins[current.id].enabled=false;});
    const release=(version:string)=>({manifest:{...current,version},artifact:{url:`${version}.mlplugin`,size:0,installedSize:0,sha256:"0".repeat(64),signature:"AAAA"},releaseNotes:"",mandatory:false});
    manager.setCatalog(PluginCatalogSchema.parse({formatVersion:1,channel:"stable",generatedAt:new Date().toISOString(),revoked:[{id:current.id,version:"4.0.0",reason:"withdrawn"}],releases:[release("1.0.0"),release("3.0.0"),release("4.0.0")]}));
    expect(manager.availableUpdates()).toEqual([{id:current.id,version:"3.0.0"}]);
    await expect(manager.updateFromCatalog(current.id,"1.0.0","https://plugins.test/")).rejects.toThrow(/newer/);
    await expect(manager.installFromCatalog(current.id,"4.0.0","https://plugins.test/")).rejects.toThrow(/revoked/);
    await manager.shutdown();
  });

  it("rolls back to the prior healthy service when activation fails", async () => {
    const paths=resolvePluginPlatformPaths(scratch()),dataDir=scratch(),{publicKey}=generateKeyPairSync("ed25519"),executable=process.platform==="win32"?"node.exe":"node";
    for(const version of ["1.0.0","2.0.0"]){const dir=path.join(paths.versionsDir,"com.memorylane.fixture",version);fs.mkdirSync(dir,{recursive:true});fs.copyFileSync(process.execPath,path.join(dir,executable));if(process.platform!=="win32")fs.chmodSync(path.join(dir,executable),0o755);const manifest={...serviceManifest(executable,["service.cjs"]),version,health:{path:"/health",timeoutSeconds:1}};fs.writeFileSync(path.join(dir,"manifest.json"),JSON.stringify(manifest));fs.writeFileSync(path.join(dir,"service.cjs"),version==="1.0.0"?`const http=require('node:http'),p=+process.env.MEMORYLANE_PLUGIN_PORT,t=process.env.MEMORYLANE_PLUGIN_TOKEN,s=http.createServer((r,w)=>{if(r.headers.authorization!=='Bearer '+t){w.statusCode=401;return w.end()}if(r.url==='/health')return w.end(JSON.stringify({status:'ready',pluginId:process.env.MEMORYLANE_PLUGIN_ID,version:process.env.MEMORYLANE_PLUGIN_VERSION,pluginApi:1}));if(r.url==='/shutdown'){w.end();return s.close(()=>process.exit(0))}});s.listen(p,'127.0.0.1')`:`process.exit(1)`);}
    const manager=new PluginManager({paths,dataDir,coreVersion:"0.2.0",platform:serviceManifest(executable).platform,publicKey});
    await manager.enable("com.memorylane.fixture","1.0.0");
    await expect(manager.activateInstalledUpdate("com.memorylane.fixture","2.0.0")).rejects.toThrow();
    expect(manager.state.snapshot().plugins["com.memorylane.fixture"]).toMatchObject({activeVersion:"1.0.0",enabled:true});
    expect(manager.supervisor.get("com.memorylane.fixture")?.manifest.version).toBe("1.0.0");
    await manager.shutdown();
  },20_000);
});

describe("PluginCatalogLoader", () => {
  it("verifies exact catalog bytes before parsing", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const bytes = Buffer.from(JSON.stringify({ formatVersion: 1, channel: "stable", generatedAt: new Date().toISOString(), releases: [] }));
    const signature = sign(null, bytes, privateKey).toString("base64");
    const loader = new PluginCatalogLoader({ publicKey, fetchImpl: async (input) =>
      new Response(String(input).endsWith(".sig") ? signature : bytes) });
    expect((await loader.load("https://plugins.test/catalog.json")).channel).toBe("stable");
    const badLoader = new PluginCatalogLoader({ publicKey, fetchImpl: async (input) =>
      new Response(String(input).endsWith(".sig") ? signature : Buffer.from("{}")) });
    await expect(badLoader.load("https://plugins.test/catalog.json")).rejects.toThrow(/signature/i);
  });

  it("rejects insecure production catalogs", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    await expect(new PluginCatalogLoader({ publicKey }).load("http://plugins.test/catalog.json")).rejects.toThrow(/HTTPS/);
  });
});

describe("PluginInstaller", () => {
  it("cleans partial downloads and staging folders left by an interrupted install", () => {
    const paths = resolvePluginPlatformPaths(scratch());
    fs.writeFileSync(path.join(paths.downloadsDir, "old.partial"), "partial");
    fs.mkdirSync(path.join(paths.stagingDir, "old-stage"));
    new PluginInstaller(paths, new PluginStateStore(paths));
    expect(fs.readdirSync(paths.downloadsDir)).toEqual([]);
    expect(fs.readdirSync(paths.stagingDir)).toEqual([]);
  });

  it("downloads, verifies, extracts, activates, and uninstalls an immutable package", async () => {
    const root = scratch();
    const paths = resolvePluginPlatformPaths(path.join(root, "plugins"));
    const state = new PluginStateStore(paths);
    const installer = new PluginInstaller(paths, state);
    const manifest = serviceManifest("bin/fixture.exe");
    const zip = createZip({
      "manifest.json": JSON.stringify(manifest),
      "bin/fixture.exe": "fixture",
      "licenses/test.txt": "test license",
    });
    const installedSize = Buffer.byteLength(JSON.stringify(manifest)) + Buffer.byteLength("fixture") + Buffer.byteLength("test license");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const release = PluginCatalogSchema.parse({
      formatVersion: 1,
      channel: "stable",
      generatedAt: new Date().toISOString(),
      releases: [{
        manifest,
        artifact: {
          url: "fixture.mlplugin",
          size: zip.length,
          installedSize,
          sha256: sha256Hex(zip),
          signature: sign(null, Buffer.from(sha256Hex(zip), "hex"), privateKey).toString("base64"),
        },
        releaseNotes: "",
        mandatory: false,
      }],
    }).releases[0];
    const server = http.createServer((_request, response) => { response.end(zip); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    try {
      if (!address || typeof address === "string") throw new Error("Missing fixture port");
      await installer.install(release, { artifactBaseUrl: `http://127.0.0.1:${address.port}/`, publicKey });
      installer.activate(manifest);
      expect(state.snapshot().plugins[manifest.id]).toMatchObject({ activeVersion: "1.0.0", enabled: true });
      installer.uninstall(manifest.id, manifest.version);
      expect(state.snapshot().plugins[manifest.id]).toBeUndefined();
    } finally { server.close(); }
  });

  it("rejects an archive whose manifest differs from the signed catalog", async () => {
    const paths = resolvePluginPlatformPaths(scratch());
    const state = new PluginStateStore(paths);
    const installer = new PluginInstaller(paths, state);
    const manifest = serviceManifest("bin/fixture.exe");
    const zip = createZip({ "manifest.json": JSON.stringify({ ...manifest, name: "Tampered" }) });
    const installedSize = Buffer.byteLength(JSON.stringify({ ...manifest, name: "Tampered" }));
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const release = {
      manifest,
      artifact: { url: "fixture.mlplugin", size: zip.length, installedSize, sha256: sha256Hex(zip), signature: sign(null, Buffer.from(sha256Hex(zip), "hex"), privateKey).toString("base64") },
      releaseNotes: "", mandatory: false,
    };
    const server = http.createServer((_request, response) => response.end(zip));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    try {
      if (!address || typeof address === "string") throw new Error("Missing fixture port");
      await expect(installer.install(release, { artifactBaseUrl: `http://127.0.0.1:${address.port}/`, publicKey })).rejects.toThrow(/manifest/i);
    } finally { server.close(); }
  });
});

describe("PluginServiceSupervisor", () => {
  it("uses a random loopback port and token for health and graceful shutdown", async () => {
    const pluginDir = scratch();
    const service = `const http=require('node:http');const port=+process.env.MEMORYLANE_PLUGIN_PORT;const token=process.env.MEMORYLANE_PLUGIN_TOKEN;const auth=r=>r.headers.authorization==='Bearer '+token;const s=http.createServer((r,w)=>{if(!auth(r)){w.statusCode=401;return w.end()}if(r.url==='/health'){w.setHeader('content-type','application/json');return w.end(JSON.stringify({status:'ready',pluginId:process.env.MEMORYLANE_PLUGIN_ID,version:process.env.MEMORYLANE_PLUGIN_VERSION,pluginApi:+process.env.MEMORYLANE_PLUGIN_API}))}if(r.url==='/shutdown'){w.end();return s.close(()=>process.exit(0))}w.statusCode=404;w.end()});s.listen(port,'127.0.0.1');`;
    fs.writeFileSync(path.join(pluginDir, "service.cjs"), service);
    const executable = process.platform === "win32" ? "fixture-node.exe" : "fixture-node";
    fs.copyFileSync(process.execPath, path.join(pluginDir, executable));
    if (process.platform !== "win32") fs.chmodSync(path.join(pluginDir, executable), 0o755);
    const supervisor = new PluginServiceSupervisor({ coreVersion: "0.2.0", dataDirFor: () => pluginDir, logDirFor: () => pluginDir });
    const instance = await supervisor.start(serviceManifest(executable, ["service.cjs"]), pluginDir);
    expect(instance.port).toBeGreaterThan(0);
    expect(instance.token.length).toBeGreaterThan(32);
    expect((await fetch(`http://127.0.0.1:${instance.port}/health`)).status).toBe(401);
    await supervisor.stop(instance.manifest.id);
    expect(supervisor.get(instance.manifest.id)).toBeUndefined();
  });
});

describe("PluginModuleHost", () => {
  it("loads multiple TypeScript-style modules in the shared host and calls them over IPC", async () => {
    const pluginDir = scratch();
    fs.writeFileSync(path.join(pluginDir, "plugin.mjs"), `export async function activate(context){return{call(method,payload){return{method,payload,pluginId:context.pluginId}},stop(){}}}`);
    const manifest: PluginManifest = {
      ...serviceManifest("unused"),
      entry: { kind: "module", script: "plugin.mjs" },
      health: undefined,
      restart: undefined,
    };
    const host = new PluginModuleHost(
      () => pluginDir,
      new URL("../../src/plugin-platform/module-host.ts", import.meta.url),
      ["--import", "tsx"],
    );
    try {
      await host.load(manifest, pluginDir);
      await expect(host.call(manifest.id, "echo", { value: 42 })).resolves.toEqual({
        method: "echo", payload: { value: 42 }, pluginId: manifest.id,
      });
      await host.unload(manifest.id);
    } finally { await host.shutdown(); }
  });
});

describe("PluginCommandRunner", () => {
  it("runs only a declared executable inside the plugin directory", async () => {
    const pluginDir = scratch();
    const executable = process.platform === "win32" ? "node.exe" : "node";
    fs.copyFileSync(process.execPath, path.join(pluginDir, executable));
    if (process.platform !== "win32") fs.chmodSync(path.join(pluginDir, executable), 0o755);
    const manifest: PluginManifest = {
      ...serviceManifest("unused"),
      entry: { kind: "command", commands: { echo: executable } },
      health: undefined,
      restart: undefined,
    };
    const result = await new PluginCommandRunner().run(manifest, pluginDir, "echo", ["-e", "process.stdout.write('ok')"], {});
    expect(result.stdout).toBe("ok");
    await expect(new PluginCommandRunner().run(manifest, pluginDir, "missing", [], {})).rejects.toThrow(/Unknown/);
  });
});

function createZip(files: Record<string, string>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, contents] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const input = Buffer.from(contents);
    const compressed = deflateRawSync(input);
    const crc = crc32(input);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 6); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(input.length, 22); header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(8, 8); directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(input.length, 24); directory.writeUInt16LE(nameBytes.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, nameBytes);
    offset += header.length + nameBytes.length + compressed.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
