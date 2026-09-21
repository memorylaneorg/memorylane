import fs from "node:fs";
import path from "node:path";
import {
  checkPluginCompatibility,
  coreVersionSatisfies,
  PluginManifestSchema,
  type PluginCatalog,
  type PluginCatalogRelease,
  type PluginInventoryItem,
  type PluginManifest,
  type PluginPlatform,
} from "@memorylane/plugin-sdk";
import type { KeyLike } from "node:crypto";
import { PluginInstaller, type PluginInstallOptions } from "./installer.js";
import { pluginVersionDir, type PluginPlatformPaths } from "./paths.js";
import { PluginServiceSupervisor } from "./service-supervisor.js";
import { PluginModuleHost } from "./module-host-client.js";
import { PluginStateStore } from "./state-store.js";

export interface PluginManagerOptions {
  paths: PluginPlatformPaths;
  dataDir: string;
  coreVersion: string;
  platform: PluginPlatform;
  publicKey: KeyLike;
  onOutput?: (pluginId: string, stream: "stdout" | "stderr", text: string) => void;
  // Dev-catalog mode (see dev-catalog.ts) - plugins loaded straight from
  // their source directory, bypassing PluginInstaller/PluginStateStore
  // entirely. Only ever populated by server.ts when neither a real catalog
  // URL nor a signed bundled directory is configured.
  devPlugins?: Map<string, { manifest: PluginManifest; sourceDir: string }>;
}

const FIRST_PARTY_PLUGINS = [
  { id: "com.memorylane.ai-runtime", name: "AI Runtime", description: "Shared local inference and vector runtime for MemoryLane AI features.", required: false, infra: true, capabilities: ["ai.image-embedding", "ai.text-embedding", "people.faces", "vector.store"] },
  { id: "com.memorylane.ai-search", name: "AI Search & Similar", description: "Semantic search, image embeddings, and visually similar photos.", required: false, infra: false, capabilities: ["ai.image-embedding", "ai.text-embedding"] },
  { id: "com.memorylane.people", name: "People", description: "Face detection, clustering, and person organization.", required: false, infra: false, capabilities: ["people.faces"] },
] as const;

// Folded directly into core (see server/src/media/exiftool-client.ts,
// video-client.ts) - no longer part of the plugin platform at all. An
// existing install's plugins-state.json can still have these recorded as
// installed/enabled from before that migration; left alone, startEnabled()
// would keep spawning their old service.mjs as a redundant subprocess
// alongside the new in-process implementation, and inventory() would keep
// showing them as phantom "Required" entries with no source to reinstall
// from. retireLegacyPlugins() cleans that up once, the first time this
// runs against an install that still has them.
const RETIRED_PLUGIN_IDS = ["com.memorylane.metadata-raw", "com.memorylane.video-tools"];

export class PluginManager {
  readonly state: PluginStateStore;
  readonly installer: PluginInstaller;
  readonly supervisor: PluginServiceSupervisor;
  readonly moduleHost: PluginModuleHost;
  private catalog: PluginCatalog | null = null;
  private readonly output = new Map<string, string[]>();
  private shuttingDown = false;
  private readonly operations = new Set<string>();
  private readonly devPlugins: Map<string, { manifest: PluginManifest; sourceDir: string }>;
  private readonly devEnabled = new Set<string>();
  private readonly devErrors = new Map<string, string>();

  constructor(private readonly options: PluginManagerOptions) {
    this.state = new PluginStateStore(options.paths);
    this.installer = new PluginInstaller(options.paths, this.state);
    this.supervisor = new PluginServiceSupervisor({
      coreVersion: options.coreVersion,
      dataDirFor: (id) => ensureDirectory(path.join(options.dataDir, "plugin-data", id)),
      logDirFor: (id) => ensureDirectory(path.join(options.dataDir, "logs", "plugins", id)),
      onOutput: (id, stream, text) => { const lines=this.output.get(id)??[]; lines.push(`[${stream}] ${text}`); this.output.set(id,lines.slice(-200)); options.onOutput?.(id,stream,text); },
    });
    this.moduleHost = new PluginModuleHost((id) => ensureDirectory(path.join(options.dataDir, "plugin-data", id)));
    this.devPlugins = options.devPlugins ?? new Map();
    this.state.reconcile(new Set(this.devPlugins.keys()));
  }

  isDevPlugin(pluginId: string): boolean { return this.devPlugins.has(pluginId); }

  setCatalog(catalog: PluginCatalog): void { this.catalog = catalog; }

  catalogSnapshot(): PluginCatalog | null { return this.catalog ? structuredClone(this.catalog) : null; }
  logs(pluginId: string): string[] { return [...(this.output.get(pluginId) ?? [])]; }
  isBusy(): boolean { return this.operations.size > 0; }

  availableUpdates(): Array<{ id: string; version: string }> {
    if (!this.catalog) return [];
    const state=this.state.snapshot();
    const updates:Array<{id:string;version:string}>=[];
    for(const [id,installed] of Object.entries(state.plugins)){
      if(!installed.activeVersion)continue;
      const currentVersion=installed.activeVersion;
      const release=this.catalog.releases.filter(item=>item.manifest.id===id&&item.manifest.platform===this.options.platform&&compareVersions(item.manifest.version,currentVersion)>0&&!this.catalog!.revoked.some(revoked=>revoked.id===id&&revoked.version===item.manifest.version))
        .sort((a,b)=>compareVersions(b.manifest.version,a.manifest.version))[0];
      if(release)updates.push({id,version:release.manifest.version});
    }
    return updates;
  }
  // Dev-catalog plugins never write to the persisted state store (see
  // devPlugins/devEnabled above) - checked first so callers like
  // PluginAiProvider.requireFeature() see them as enabled correctly instead
  // of always reporting "not installed or enabled" regardless of real state.
  isEnabled(pluginId: string): boolean {
    if (this.devPlugins.has(pluginId)) return this.devEnabled.has(pluginId);
    const item = this.state.snapshot().plugins[pluginId];
    return !!item?.enabled && !!item.activeVersion;
  }

  inventory(): PluginInventoryItem[] {
    const state = this.state.snapshot();
    const known = new Map<string, (typeof FIRST_PARTY_PLUGINS)[number]>(FIRST_PARTY_PLUGINS.map((item) => [item.id, item]));
    const ids = new Set([...known.keys(), ...Object.keys(state.plugins), ...(this.catalog?.releases.map((item) => item.manifest.id) ?? []), ...this.devPlugins.keys()]);
    // Dependencies are stored as ids on the manifest - resolve them to the
    // display name the UI already shows for that plugin, so "Requires: AI
    // Runtime" reads naturally instead of exposing the raw package id.
    const nameFor = (dependencyId: string): string =>
      known.get(dependencyId)?.name
      ?? this.catalog?.releases.find((item) => item.manifest.id === dependencyId)?.manifest.name
      ?? this.devPlugins.get(dependencyId)?.manifest.name
      ?? dependencyId;
    return [...ids].sort().flatMap((id) => {
      const dev = this.devPlugins.get(id);
      if (dev) {
        // Same pre-install exclusion as the catalog path below - a pure
        // dependency like AI Runtime isn't a standalone install choice, it
        // just gets pulled in transparently (now via enable()'s own
        // dev-dependency auto-enable) by whatever actually needs it. Checked
        // against "ever installed" (state.plugins has an entry), not
        // "currently enabled" - the exclusion is meant to apply only
        // pre-install, same as the catalog path's own comment says; using
        // devEnabled here instead would make AI Runtime vanish from the list
        // every time you disable it, with no way to see or re-enable it
        // directly again.
        if (!state.plugins[id] && dev.manifest.infra) return [];
        return [{
          id,
          name: dev.manifest.name,
          description: dev.manifest.description,
          version: dev.manifest.version,
          // "disabled" (installed, currently off) vs "available" (never
          // installed) - same distinction the catalog path below makes, so
          // the UI shows "Enable" rather than "Install" for something you've
          // already used once and just toggled off.
          state: this.devEnabled.has(id) ? "ready" : state.plugins[id] ? "disabled" : "available",
          required: dev.manifest.required,
          capabilities: dev.manifest.capabilities,
          dependsOn: dev.manifest.dependencies.map((dependency) => nameFor(dependency.id)),
          error: this.devErrors.get(id) ?? null,
        }] satisfies PluginInventoryItem[];
      }
      const installed = state.plugins[id];
      const fallback = known.get(id);
      const releases = this.catalog?.releases.filter((item) => item.manifest.id === id && item.manifest.platform === this.options.platform && !this.catalog?.revoked.some((revoked)=>revoked.id===id&&revoked.version===item.manifest.version)) ?? [];
      const activeRelease = releases.find((item) => item.manifest.version === installed?.activeVersion);
      const latestRelease = [...releases].sort((a,b)=>compareVersions(b.manifest.version,a.manifest.version))[0];
      const display = activeRelease?.manifest ?? latestRelease?.manifest ?? this.readActiveManifest(id);
      const compatibility = display ? checkPluginCompatibility(display, {
        coreVersion: this.options.coreVersion,
        platform: this.options.platform,
      }) : null;
      const running = this.supervisor.get(id);
      const newer = installed?.activeVersion && latestRelease && compareVersions(latestRelease.manifest.version,installed.activeVersion)>0;
      const stateName = compatibility && !compatibility.compatible ? "incompatible"
        : newer ? "update-available"
        : running ? "ready"
        : installed?.enabled && installed.lastError ? "failed"
        : installed?.enabled ? "installed"
        : installed ? "disabled"
        : "available";
      // infra plugins (pure dependencies with no user-facing capability of
      // their own, e.g. AI Runtime) are never offered as a standalone install
      // choice - installing a feature that needs one still pulls it in
      // transparently via installFromCatalog/installFromDirectory's own
      // dependency walk, which reads the catalog directly rather than going
      // through inventory(). Once actually installed (as a side effect of
      // that), it's a normal plugin like any other - visible, manageable,
      // with the same controls - so the exclusion only applies pre-install.
      if (stateName === "available" && (display?.infra ?? fallback?.infra ?? false)) return [];
      return [{
        id,
        name: display?.name ?? fallback?.name ?? id,
        description: display?.description ?? fallback?.description ?? "",
        version: newer ? latestRelease.manifest.version : installed?.activeVersion ?? display?.version ?? null,
        state: stateName,
        required: display?.required ?? fallback?.required ?? false,
        capabilities: display?.capabilities ?? [...(fallback?.capabilities ?? [])],
        dependsOn: (display?.dependencies ?? []).map((dependency) => nameFor(dependency.id)),
        error: installed?.lastError ?? (!installed && releases.length === 0 ? (this.catalog ? "No compatible release is available" : "Plugin catalog is not configured") : null),
      }];
    });
  }

  async install(release: PluginCatalogRelease, artifactBaseUrl: string, extra: Partial<PluginInstallOptions> = {}): Promise<void> {
    if (this.shuttingDown) throw new Error("Plugin manager is shutting down");
    if (this.operations.has(release.manifest.id)) throw new Error("Another operation is already running for this plugin");
    this.operations.add(release.manifest.id);
    try {
    if (this.catalog?.revoked.some((item) => item.id === release.manifest.id && item.version === release.manifest.version)) throw new Error("Plugin version has been revoked");
    const compatibility = checkPluginCompatibility(release.manifest, {
      coreVersion: this.options.coreVersion,
      platform: this.options.platform,
    });
    if (!compatibility.compatible) throw new Error(`Plugin is incompatible: ${compatibility.reason}`);
    await this.installer.install(release, { artifactBaseUrl, publicKey: this.options.publicKey, ...extra });
    } finally { this.operations.delete(release.manifest.id); }
  }

  // Shared by installFromCatalog (remote HTTPS) and installFromDirectory
  // (local disk, used for the bundled required plugins at boot and for the
  // dev-mode local-catalog install/update flow - see plugin-routes.ts). Both
  // resolve dependencies identically against the already-loaded catalog;
  // they only differ in how the leaf release's artifact bytes get located,
  // which `resolveInstallOptions` decides.
  private async installReleaseWithDependencies(
    pluginId: string,
    version: string,
    resolveInstallOptions: (release: PluginCatalogRelease) => { artifactBaseUrl: string; extra?: Partial<PluginInstallOptions> },
  ): Promise<void> {
    const release = this.catalog?.releases.find((item) => item.manifest.id === pluginId && item.manifest.version === version && item.manifest.platform === this.options.platform);
    if (!release) throw new Error("Plugin release is not present in the loaded catalog");
    for (const dependency of release.manifest.dependencies) {
      const state = this.state.snapshot().plugins[dependency.id];
      if (state?.activeVersion && state.enabled && coreVersionSatisfies(state.activeVersion, dependency.version)) continue;
      const dependencyRelease = this.catalog?.releases
        .filter((item) => item.manifest.id === dependency.id && item.manifest.platform === this.options.platform && coreVersionSatisfies(item.manifest.version, dependency.version))
        .sort((a, b) => b.manifest.version.localeCompare(a.manifest.version))[0];
      if (!dependencyRelease) throw new Error(`Required dependency is unavailable: ${dependency.id} ${dependency.version}`);
      if (!state?.installedVersions.includes(dependencyRelease.manifest.version)) {
        await this.installReleaseWithDependencies(dependency.id, dependencyRelease.manifest.version, resolveInstallOptions);
      }
      await this.enable(dependency.id, dependencyRelease.manifest.version);
    }
    const { artifactBaseUrl, extra } = resolveInstallOptions(release);
    await this.install(release, artifactBaseUrl, extra);
  }

  async installFromCatalog(pluginId: string, version: string, catalogUrl: string, extra: Partial<PluginInstallOptions> = {}): Promise<void> {
    await this.installReleaseWithDependencies(pluginId, version, () => ({ artifactBaseUrl: catalogUrl, extra }));
  }

  // Local-disk counterpart to installFromCatalog, for a catalog that was
  // loaded via PluginCatalogLoader.loadDirectory (MEMORYLANE_BUNDLED_PLUGIN_REPOSITORY)
  // rather than fetched over HTTPS - same artifact-path resolution and
  // traversal guard as installRequiredFromDirectory below, generalized to
  // any single release (with its dependencies) instead of only required ones.
  async installFromDirectory(pluginId: string, version: string, directory: string): Promise<void> {
    await this.installReleaseWithDependencies(pluginId, version, (release) => {
      const artifactPath = path.resolve(directory, ...release.artifact.url.split("/"));
      if (!artifactPath.startsWith(path.resolve(directory) + path.sep)) throw new Error("Bundled artifact escapes its repository");
      return { artifactBaseUrl: "https://bundled.invalid/", extra: { artifactPath } };
    });
  }

  async updateFromCatalog(pluginId: string, version: string, catalogUrl: string, extra: Partial<PluginInstallOptions> = {}): Promise<void> {
    const previous = this.state.snapshot().plugins[pluginId];
    const previousVersion = previous?.activeVersion ?? null;
    if (previousVersion && compareVersions(version, previousVersion) <= 0) throw new Error("Plugin updates must use a newer version");
    if (!previous?.installedVersions.includes(version)) await this.installFromCatalog(pluginId, version, catalogUrl, extra);
    await this.activateInstalledUpdate(pluginId, version);
  }

  async updateFromDirectory(pluginId: string, version: string, directory: string): Promise<void> {
    const previous = this.state.snapshot().plugins[pluginId];
    const previousVersion = previous?.activeVersion ?? null;
    if (previousVersion && compareVersions(version, previousVersion) <= 0) throw new Error("Plugin updates must use a newer version");
    if (!previous?.installedVersions.includes(version)) await this.installFromDirectory(pluginId, version, directory);
    await this.activateInstalledUpdate(pluginId, version);
  }

  async activateInstalledUpdate(pluginId:string,version:string):Promise<void>{
    const previous=this.state.snapshot().plugins[pluginId];
    const previousVersion=previous?.activeVersion??null;
    if(previousVersion&&compareVersions(version,previousVersion)<=0)throw new Error("Plugin updates must use a newer version");
    const wasEnabled = previous?.enabled ?? false;
    try {
      if (wasEnabled) await this.disable(pluginId);
      await this.enable(pluginId, version);
      this.pruneVersions(pluginId, 2);
    } catch (error) {
      try {
        await this.disable(pluginId);
        if (wasEnabled && previousVersion) await this.enable(pluginId, previousVersion);
      } catch { /* preserve the original update error */ }
      throw error;
    }
  }

  async enable(pluginId: string, version: string): Promise<void> {
    const dev = this.devPlugins.get(pluginId);
    if (dev) {
      if (dev.manifest.version !== version) throw new Error("Plugin version is not installed");
      for (const dependency of dev.manifest.dependencies) {
        if (this.devEnabled.has(dependency.id)) continue;
        const dependencyDev = this.devPlugins.get(dependency.id);
        // A dev-catalog dependency is also loaded straight from source, same
        // as the leaf plugin - auto-enable it first, mirroring how a real
        // catalog install pulls in its dependencies via
        // installReleaseWithDependencies rather than making the person
        // enable them by hand one at a time.
        if (dependencyDev) {
          if (!coreVersionSatisfies(dependencyDev.manifest.version, dependency.version)) {
            throw new Error(`Dependency ${dependency.id} ${dependencyDev.manifest.version} does not satisfy required range ${dependency.version}`);
          }
          await this.enable(dependency.id, dependencyDev.manifest.version);
          continue;
        }
        const dependencyState = this.state.snapshot().plugins[dependency.id];
        const satisfied = !!dependencyState?.enabled && !!dependencyState.activeVersion && coreVersionSatisfies(dependencyState.activeVersion, dependency.version);
        if (!satisfied) throw new Error(`Enable dependency ${dependency.id} ${dependency.version} first`);
      }
      try {
        if (dev.manifest.entry.kind === "service") await this.supervisor.start(dev.manifest, dev.sourceDir);
        if (dev.manifest.entry.kind === "module") await this.moduleHost.load(dev.manifest, dev.sourceDir);
        this.devEnabled.add(pluginId);
        this.devErrors.delete(pluginId);
        // Persisted through the same store a real install uses (with no
        // actual installed/<id>/<version>/ directory behind it - enable()'s
        // dev branch above is what makes that harmless) purely so
        // startEnabled()'s existing state.plugins loop re-enables this dev
        // plugin on the next boot too. Without this, restarting the dev
        // server silently dropped every optional dev plugin back to
        // "available" - fine for something you install once in production,
        // not for a dev inner loop that restarts constantly.
        this.state.update((draft) => {
          draft.plugins[pluginId] = { activeVersion: version, enabled: true, installedVersions: [version], lastError: null };
        });
      } catch (error) {
        this.devErrors.set(pluginId, error instanceof Error ? error.message : String(error));
        throw error;
      }
      return;
    }
    const installed = this.state.snapshot().plugins[pluginId];
    if (!installed?.installedVersions.includes(version)) throw new Error("Plugin version is not installed");
    const manifest = this.readManifest(pluginId, version);
    if (this.catalog?.revoked.some((item) => item.id === pluginId && item.version === version)) throw new Error("Plugin version has been revoked");
    const compatibility = checkPluginCompatibility(manifest, { coreVersion: this.options.coreVersion, platform: this.options.platform });
    if (!compatibility.compatible) throw new Error(`Plugin is incompatible: ${compatibility.reason}`);
    for (const dependency of manifest.dependencies) {
      const installedDependency = this.state.snapshot().plugins[dependency.id];
      if (!installedDependency?.enabled || !installedDependency.activeVersion || !coreVersionSatisfies(installedDependency.activeVersion, dependency.version)) {
        throw new Error(`Enable dependency ${dependency.id} ${dependency.version} first`);
      }
    }
    const pluginDir = pluginVersionDir(this.options.paths, pluginId, version);
    try {
      if (manifest.entry.kind === "service") await this.supervisor.start(manifest, pluginDir);
      if (manifest.entry.kind === "module") await this.moduleHost.load(manifest, pluginDir);
      this.installer.activate(manifest);
    } catch (error) {
      this.state.update((draft) => {
        const plugin = draft.plugins[pluginId];
        if (plugin) plugin.lastError = error instanceof Error ? error.message : String(error);
      });
      throw error;
    }
  }

  async disable(pluginId: string): Promise<void> {
    if (this.devPlugins.has(pluginId)) {
      await this.supervisor.stop(pluginId);
      try { await this.moduleHost.unload(pluginId); } catch { /* plugin may not be a loaded module */ }
      this.devEnabled.delete(pluginId);
      // Marked disabled, not deleted - mirrors the catalog branch below
      // exactly. Deleting the entry made a disabled dev plugin
      // indistinguishable from one that was never installed, which (via the
      // infra pre-install exclusion in inventory() above) made AI Runtime
      // vanish from the Plugins list the moment you turned it off, with no
      // way to see or re-enable it directly again.
      this.state.update((draft) => {
        const plugin = draft.plugins[pluginId];
        if (plugin) { plugin.enabled = false; plugin.lastError = null; }
      });
      return;
    }
    await this.supervisor.stop(pluginId);
    try { await this.moduleHost.unload(pluginId); } catch { /* plugin may not be a loaded module */ }
    this.state.update((draft) => {
      const plugin = draft.plugins[pluginId];
      if (plugin) { plugin.enabled = false; plugin.lastError = null; }
    });
  }

  async uninstall(pluginId: string, version: string): Promise<void> {
    let manifest: PluginManifest | undefined;
    try { manifest = this.readManifest(pluginId, version); } catch { /* fall through to the dependents check below */ }
    if (manifest?.required) throw new Error("Required plugins cannot be removed");
    const dependents = this.installedDependents(pluginId);
    if (dependents.length > 0) throw new Error(`Cannot remove - still needed by ${dependents.join(", ")}`);
    const active = this.state.snapshot().plugins[pluginId]?.activeVersion === version;
    if (active) await this.disable(pluginId);
    this.installer.uninstall(pluginId, version);
  }

  async uninstallAll(pluginId: string): Promise<void> {
    const versions = [...(this.state.snapshot().plugins[pluginId]?.installedVersions ?? [])];
    if (versions.length === 0) throw new Error("Plugin is not installed");
    for (const version of versions) await this.uninstall(pluginId, version);
  }

  // Names of installed plugins that declare pluginId as a dependency -
  // checked regardless of whether they're currently enabled, since enable()
  // doesn't re-run dependency installation (only install/update do), so a
  // disabled dependent re-enabled later would find nothing waiting for it.
  // Deliberately no cascade in the other direction: nothing here auto-removes
  // or auto-disables a dependency once its last dependent is gone - it just
  // stays installed until a person decides to do something about it.
  private installedDependents(pluginId: string): string[] {
    const state = this.state.snapshot();
    const dependents: string[] = [];
    for (const [id, entry] of Object.entries(state.plugins)) {
      if (id === pluginId) continue;
      const version = entry.activeVersion ?? entry.installedVersions[entry.installedVersions.length - 1];
      if (!version) continue;
      let manifest: PluginManifest;
      try { manifest = this.readManifest(id, version); } catch { continue; }
      if (manifest.dependencies.some((dependency) => dependency.id === pluginId)) dependents.push(manifest.name);
    }
    return dependents;
  }

  // Names of *enabled* plugins that declare pluginId as a dependency - unlike
  // installedDependents() above (used by uninstall(), which cares about any
  // installed dependent regardless of enabled state, since removing files a
  // disabled-but-installed dependent would need if re-enabled later is still
  // unsafe), disable() only needs to worry about something actively using
  // pluginId right now. Deliberately not enforced inside disable() itself -
  // activateInstalledUpdate() disables a plugin internally as part of a
  // normal version update, which must not be blocked by this; the check
  // belongs at the user-facing HTTP layer, same reasoning as the existing
  // "required plugins cannot be disabled" guard in plugin-routes.ts.
  enabledDependents(pluginId: string): string[] {
    const dependents: string[] = [];
    for (const id of new Set([...Object.keys(this.state.snapshot().plugins), ...this.devPlugins.keys()])) {
      if (id === pluginId || !this.isEnabled(id)) continue;
      const manifest = this.readActiveManifest(id);
      if (manifest?.dependencies.some((dependency) => dependency.id === pluginId)) dependents.push(manifest.name);
    }
    return dependents;
  }

  // Stops and uninstalls any RETIRED_PLUGIN_IDS still recorded as installed
  // from before they were folded into core. Bypasses the normal uninstall()
  // path deliberately - it refuses to remove a plugin whose manifest says
  // required: true, which theirs still does (the leftover manifest.json on
  // disk predates this migration and was never rewritten).
  private async retireLegacyPlugins(): Promise<void> {
    for (const id of RETIRED_PLUGIN_IDS) {
      const installed = this.state.snapshot().plugins[id];
      if (!installed) continue;
      if (installed.enabled) {
        await this.supervisor.stop(id);
        try { await this.moduleHost.unload(id); } catch { /* not a loaded module */ }
      }
      // installer.uninstall() already drops the state entry once its last
      // installedVersion is gone - no separate state cleanup needed here.
      for (const version of installed.installedVersions) this.installer.uninstall(id, version);
    }
  }

  async startEnabled(): Promise<void> {
    await this.retireLegacyPlugins();
    // Mirrors installRequiredFromDirectory's auto-enable for the signed
    // bundled-directory path - required dev plugins should just work the
    // moment the server boots, same as a packaged install's required plugins do.
    for (const [id, dev] of this.devPlugins) {
      if (dev.manifest.required && !this.devEnabled.has(id)) {
        try { await this.enable(id, dev.manifest.version); } catch { /* recorded in devErrors, visible via inventory() */ }
      }
    }
    for (const [id, plugin] of Object.entries(this.state.snapshot().plugins)) {
      if (!plugin.enabled || !plugin.activeVersion) continue;
      if (this.supervisor.get(id)) continue;
      try { await this.enable(id, plugin.activeVersion); }
      catch { /* enable records the error; other plugins still start */ }
    }
  }

  async installRequiredFromDirectory(directory: string, catalog: PluginCatalog): Promise<number> {
    let installed = 0;
    for (const release of catalog.releases) {
      if (!release.manifest.required || release.manifest.platform !== this.options.platform) continue;
      const state = this.state.snapshot().plugins[release.manifest.id];
      if (state?.installedVersions.includes(release.manifest.version)) continue;
      await this.installFromDirectory(release.manifest.id, release.manifest.version, directory);
      await this.enable(release.manifest.id, release.manifest.version);
      installed++;
    }
    return installed;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.operations.size > 0) throw new Error("Cannot shut down while a plugin operation is active");
    await Promise.all([this.supervisor.stopAll(), this.moduleHost.shutdown()]);
  }

  private pruneVersions(pluginId:string,keep:number):void{const state=this.state.snapshot().plugins[pluginId];if(!state)return;const retained=new Set([state.activeVersion,...state.installedVersions.slice().sort((a,b)=>compareVersions(b,a)).slice(0,keep)].filter((item):item is string=>!!item));for(const version of state.installedVersions)if(!retained.has(version))this.installer.uninstall(pluginId,version);}

  private readActiveManifest(pluginId: string): PluginManifest | undefined {
    const version = this.state.snapshot().plugins[pluginId]?.activeVersion;
    if (!version) return undefined;
    try { return this.readManifest(pluginId, version); } catch { return undefined; }
  }

  private readManifest(pluginId: string, version: string): PluginManifest {
    // A dev-catalog plugin has no installed/<id>/<version>/manifest.json on
    // disk at all (see devPlugins) - without this, every caller here
    // (installedDependents, readActiveManifest) would silently fail to see
    // one, e.g. missing it as a real dependent when deciding whether
    // something else is safe to disable.
    const dev = this.devPlugins.get(pluginId);
    if (dev && dev.manifest.version === version) return dev.manifest;
    return PluginManifestSchema.parse(JSON.parse(fs.readFileSync(path.join(pluginVersionDir(this.options.paths, pluginId, version), "manifest.json"), "utf8")));
  }
}

function ensureDirectory(directory: string): string {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function compareVersions(a:string,b:string):number{const left=a.split(".").map(Number),right=b.split(".").map(Number);for(let i=0;i<Math.max(left.length,right.length);i++){const delta=(left[i]||0)-(right[i]||0);if(delta)return delta;}return 0;}
