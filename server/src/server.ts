import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { resolveAppPaths, repoRootDir, resolveRepoPath } from "./config/paths.js";

// Loads <repo-root>/.env before anything below reads process.env - both `npm
// run dev` and `npm start` run with cwd inside server/, so this can't just be
// dotenv's own process.cwd() default. A missing .env is not an error (dotenv
// resolves it silently); see .env.example for what it's for.
loadDotenv({ path: path.join(repoRootDir, ".env"), quiet: true });

import { openDatabase } from "./db/connection.js";
import { runMigrations } from "./db/migrate.js";
import { SettingsRepo } from "./db/settings-repo.js";
import { SessionStore } from "./auth/sessions.js";
import { ScannerService } from "./scanner/scanner-service.js";
import { SqliteRandomSelectionService } from "./media/random-selection-service.js";
import { TranscodeWorker } from "./media/transcode-worker.js";
import { AnalysisWorker } from "./analysis/analysis-worker.js";
import { createAnalyzers } from "./analysis/registry.js";
import { StackService } from "./stacks/stack-service.js";
import { PluginAiProvider } from "./providers/plugin-ai-provider.js";
import { PluginVectorIndex } from "./vectors/plugin-vector-index.js";
import { EmbeddingRepo } from "./vectors/embedding-repo.js";
import { spaceFor } from "./vectors/vector-index.js";
import { PersonService } from "./persons/person-service.js";
import { FaceRepo } from "./persons/face-repo.js";
import { buildApp } from "./app.js";
import type { AppContext } from "./context.js";
import { APP_VERSION } from "./version.js";
import { currentPluginPlatform } from "@memorylane/plugin-sdk";
import { PluginManager } from "./plugin-platform/manager.js";
import { scanDevPlugins } from "./plugin-platform/dev-catalog.js";
import { resolvePluginPlatformPaths } from "./plugin-platform/paths.js";
import { PluginCatalogLoader } from "./plugin-platform/catalog-loader.js";
import fs from "node:fs";
import { PLUGIN_RELEASE_PUBLIC_KEY } from "./plugin-platform/release-public-key.js";
import { NativeMediaToolCapabilities } from "./capabilities/native-media-tools.js";
import { checkExifToolAvailable, shutdownExifTool } from "./media/exiftool-client.js";
import { checkFfmpegAvailable } from "./media/video-client.js";
import { PluginUpdateCoordinator } from "./plugin-platform/update-coordinator.js";

async function main(): Promise<void> {
  // macOS may terminate and relaunch the tray after a privacy-permission
  // change. If the tray is killed rather than allowed to shut down normally,
  // its Node child would otherwise keep port 4280 open and make the relaunched
  // app fail with EADDRINUSE. Exit when our owning tray process disappears.
  const desktopParentPid = Number(process.env.MEMORYLANE_DESKTOP_PARENT_PID);
  if (Number.isInteger(desktopParentPid) && desktopParentPid > 1) {
    let exitRequested = false;
    setInterval(() => {
      try { process.kill(desktopParentPid, 0); }
      catch {
        if (!exitRequested) {
          exitRequested = true;
          process.kill(process.pid, "SIGTERM");
        }
      }
    }, 1000).unref();
  }

  const paths = resolveAppPaths();
  const db = openDatabase(paths.dbPath);

  // A minimal bootstrap logger for pre-app startup steps (migrations, tool
  // detection) - the full pino instance lives on the Fastify app once built.
  const bootstrapLogger = {
    info: (obj: unknown, msg?: string) => console.log(msg ?? "", obj ?? ""),
    warn: (obj: unknown, msg?: string) => console.warn(msg ?? "", obj ?? ""),
    error: (obj: unknown, msg?: string) => console.error(msg ?? "", obj ?? ""),
  } as unknown as import("pino").Logger;

  await runMigrations(db, paths.dbPath, bootstrapLogger);

  const settingsRepo = new SettingsRepo(db);
  const settings = settingsRepo.getAll();

  const sessions = new SessionStore(db);
  sessions.destroyAllExpired();

  const pluginPlatform = currentPluginPlatform();
  const configuredPluginKey = process.env.MEMORYLANE_PLUGIN_PUBLIC_KEY;
  let pluginPublicKey = PLUGIN_RELEASE_PUBLIC_KEY;
  if (configuredPluginKey) {
    try { pluginPublicKey = configuredPluginKey.includes("BEGIN PUBLIC KEY") ? configuredPluginKey : fs.readFileSync(resolveRepoPath(configuredPluginKey), "utf8"); }
    catch (error) { bootstrapLogger.warn({ err: error }, "Could not read the configured plugin public key"); }
  }
  const pluginCatalogUrl = process.env.MEMORYLANE_PLUGIN_CATALOG_URL;
  const bundledPluginRepository = process.env.MEMORYLANE_BUNDLED_PLUGIN_REPOSITORY ? resolveRepoPath(process.env.MEMORYLANE_BUNDLED_PLUGIN_REPOSITORY) : undefined;
  // Dev-catalog mode: when neither a real catalog nor a signed local build is
  // configured, load plugins straight from plugins/optional/ in the
  // repo - no zip, no signing, no network. This is what makes a plain
  // `npm run dev`/`npm start` from a source checkout work out of the box,
  // without falling into the dead middle ground of "no catalog configured at
  // all" that a from-source run used to land in. A packaged desktop build
  // always compiles MEMORYLANE_PLUGIN_CATALOG_URL in, so it never reaches here.
  const devPlugins = !pluginCatalogUrl && !bundledPluginRepository && pluginPlatform
    ? scanDevPlugins(path.join(repoRootDir, "plugins"), pluginPlatform)
    : undefined;
  const pluginManager = pluginPlatform ? new PluginManager({
    paths: resolvePluginPlatformPaths(), dataDir: paths.dataDir, coreVersion: APP_VERSION, platform: pluginPlatform, publicKey: pluginPublicKey,
    onOutput: (pluginId, stream, text) => bootstrapLogger.info({ pluginId, stream, text: text.trimEnd() }, "Plugin output"),
    devPlugins,
  }) : undefined;
  if (pluginManager && bundledPluginRepository && pluginPublicKey) {
    try { const catalog = new PluginCatalogLoader({ publicKey: pluginPublicKey }).loadDirectory(bundledPluginRepository); pluginManager.setCatalog(catalog); await pluginManager.installRequiredFromDirectory(bundledPluginRepository, catalog); }
    catch (error) { bootstrapLogger.warn({ err: error }, "Bundled plugin repository could not be installed"); }
  }
  let pluginCatalogReady: Promise<void> = Promise.resolve();
  if (pluginManager && pluginCatalogUrl && pluginPublicKey) {
    // A slow or unavailable catalog must not hold the whole desktop app at
    // the splash/starting state. Installed plugins do not need the catalog
    // to boot, so fetch it alongside core startup and make it available to
    // the Plugins page and update coordinator when it arrives.
    pluginCatalogReady = new PluginCatalogLoader({ publicKey: pluginPublicKey, allowHttp: process.env.MEMORYLANE_PLUGIN_ALLOW_HTTP === "1" })
      .load(pluginCatalogUrl)
      .then((catalog) => { pluginManager.setCatalog(catalog); })
      .catch((error) => { bootstrapLogger.warn({ err: error }, "Plugin catalog is unavailable; installed plugins can still start"); });
  }
  // Sidecars such as the Python AI runtime have a noticeable cold-start on
  // some Windows machines. Start them now, but let the core HTTP server bind
  // independently so the tray can open a usable library immediately.
  const enabledPluginsReady = pluginManager?.startEnabled() ?? Promise.resolve();

  await Promise.all([checkExifToolAvailable(bootstrapLogger), checkFfmpegAvailable(bootstrapLogger)]);
  const mediaTools = new NativeMediaToolCapabilities();
  const scanner = new ScannerService(db, paths, bootstrapLogger, mediaTools);
  const randomSelection = new SqliteRandomSelectionService(db);
  const transcodeWorker = new TranscodeWorker(db, paths, bootstrapLogger, scanner, mediaTools);
  const pluginUpdates = pluginManager && pluginCatalogUrl ? new PluginUpdateCoordinator(pluginManager, {
    catalogUrl: pluginCatalogUrl, publicKey: pluginPublicKey,
    allowHttp: process.env.MEMORYLANE_PLUGIN_ALLOW_HTTP === "1",
    rootDir: resolvePluginPlatformPaths().rootDir,
    canActivate: () => !scanner.isRunning() && !(db.prepare("SELECT 1 FROM video_transcode_jobs WHERE status IN ('pending','transcoding') LIMIT 1").get()),
  }) : undefined;

  // The AI sidecar is optional: without it (or with it down) every feature
  // that needs vectors reports "unavailable" and the rest of the app is unchanged.
  const provider = pluginManager ? new PluginAiProvider(pluginManager, process.env.MEMORYLANE_AI_MODEL) : null;
  if (!pluginManager) throw new Error("Plugin platform is unavailable on this system");
  const vectorIndex = new PluginVectorIndex(pluginManager);
  const embeddings = new EmbeddingRepo(db);
  const stacks = new StackService(db, bootstrapLogger, settingsRepo, () => provider?.expectedModel ?? null);
  const persons = new PersonService(db, bootstrapLogger, settingsRepo, () => provider, vectorIndex, paths.facesDir);
  const analyzers = createAnalyzers(db, bootstrapLogger, { paths, settings: settingsRepo, provider, vectorIndex, persons, mediaTools });
  const analysisWorker = new AnalysisWorker(db, bootstrapLogger, analyzers, () => scanner.isRunning(), {
    // Idle work runs only once every analyzer is drained and no scan is
    // running: stack recompute (hashes/embeddings first), then person discovery.
    onIdle: async () => (scanner.isRunning() ? 0 : stacks.recomputeDirty(5) + (await persons.discoverIfNeeded())),
    provider,
  });

  const ctx: AppContext = {
    db, paths, sessions, scanner, randomSelection, transcodeWorker, analysisWorker, stacks, provider, vectorIndex, embeddings, persons, pluginManager, pluginUpdates,
  };
  const app = await buildApp(ctx);

  // Reconcile any video transcode job left mid-flight by a previous process
  // exit (crash, restart) and resume anything that was merely queued - see
  // TranscodeWorker.reconcileAndResume for why those two cases are handled
  // differently.
  transcodeWorker.reconcileAndResume();

  scanner.onScanFinished(() => analysisWorker.kick());
  if (stacks.hasStaleAutoStacks()) {
    bootstrapLogger.info("Stacking rule changed - queueing every folder for recompute");
    stacks.markAllDirty();
  }

  const startPluginDependentWork = async () => {
    await Promise.all([pluginCatalogReady, enabledPluginsReady]);

    // Background analysis can call AI plugin capabilities immediately, so
    // start it only after enabled sidecars have finished their health checks.
    analysisWorker.start();

    // The vector index is a cache over media_embeddings - rebuild it if the
    // two disagree (deleted vectors/ folder, crash mid-write).
    if (provider) {
    const model = provider.expectedModel;
    const space = spaceFor("media", model);
    vectorIndex
      .ensureSynced(space, embeddings.count(model), () => embeddings.iterate(model), embeddings.dim(model))
      .then((r) => {
        if (r === "rebuilt") bootstrapLogger.info({ space, count: embeddings.count(model) }, "Rebuilt vector index from media_embeddings");
      })
      .catch((err) => bootstrapLogger.error({ err }, "Vector index sync failed"));
    const faceModel = settings.faceModel === "buffalo_l" ? "buffalo_l@1" : "yunet-sface@1";
    const faceSpace = spaceFor("faces", faceModel);
    const faceCount = (db.prepare("SELECT COUNT(*) AS c FROM faces WHERE model = ?").get(faceModel) as { c: number }).c;
    vectorIndex
      .ensureSynced(
        faceSpace,
        faceCount,
        () => new FaceRepo(db).iterateVectors(faceModel),
        null,
      )
      .then((r) => {
        if (r === "rebuilt") bootstrapLogger.info({ space: faceSpace, count: faceCount }, "Rebuilt face vector index");
      })
      .catch((err) => bootstrapLogger.error({ err }, "Face index sync failed"));
    }

    pluginUpdates?.start();
    if (pluginUpdates) setTimeout(() => void pluginUpdates.checkNow().catch((error)=>bootstrapLogger.warn({err:error},"Plugin update check failed")), 30_000).unref();
  }

  scanner.scheduleFromSettings(settings.scanIntervalDays, settings.scanScheduleEnabled);

  const bindAddress = process.env.MEMORYLANE_BIND_ADDRESS ?? settings.bindAddress;
  const port = Number(process.env.MEMORYLANE_PORT ?? settings.port);

  await app.listen({ host: bindAddress, port });
  app.log.info({ bindAddress, port, dataDir: paths.dataDir }, "MemoryLane server started");
  const pluginDependentStartup = startPluginDependentWork().catch((error) => bootstrapLogger.error({ err: error }, "Plugin-dependent startup failed"));

  // 0.0.0.0 (listen on every interface) always includes loopback too, so
  // http://127.0.0.1 is reachable there just as much as an explicit
  // 127.0.0.1/localhost bind - only skip auto-open for some other specific
  // non-loopback interface a user deliberately bound to.
  //
  // Also skip it under `npm run dev`: tsx watch restarts this whole process
  // on every file save, and re-popping a browser tab on every restart during
  // active development is disruptive rather than helpful - npm sets
  // npm_lifecycle_event to the script name for the life of the process tsx
  // watch keeps respawning, so this stays off across every restart in a dev
  // session, not just the first one.
  const isDevWatch = process.env.npm_lifecycle_event === "dev";
  if (
    !process.env.MEMORYLANE_NO_OPEN &&
    !isDevWatch &&
    (bindAddress === "127.0.0.1" || bindAddress === "localhost" || bindAddress === "0.0.0.0")
  ) {
    const url = `http://127.0.0.1:${port}`;
    try {
      const open = (await import("open")).default;
      await open(url);
    } catch (err) {
      app.log.warn({ err }, "Could not automatically open the browser - open it manually");
    }
  }

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "Shutting down");
    pluginUpdates?.stop();
    await pluginDependentStartup;
    await pluginManager?.shutdown();
    await analysisWorker.stop();
    await app.close();
    await shutdownExifTool();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
