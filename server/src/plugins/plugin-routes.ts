import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Logger } from "pino";
import type { AppContext } from "../context.js";
import { APPLE_PHOTOS_PLUGIN_ID, applePhotosPluginStatus } from "./registry.js";
import { isApplePhotosEnabled } from "./registry.js";
import { toMediaDto, type MediaRow } from "../api/mappers.js";
import { decorateMedia } from "../api/decorate-media.js";
import { resolveRepoPath } from "../config/paths.js";

const updateSchema = z.object({ enabled: z.boolean() }).strict();

export async function registerPluginRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const activeSyncs = new Set<number>();
  ctx.db.prepare("UPDATE apple_photos_sync_state SET status = 'interrupted', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE status = 'running'").run();
  const readSync = (id: number) => {
    const row = ctx.db.prepare("SELECT status, processed, total, failed, last_error AS error, started_at AS startedAt, finished_at AS finishedAt, last_success_at AS lastSuccessAt FROM apple_photos_sync_state WHERE scan_root_id = ?")
      .get(id);
    const availability = ctx.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN media_id IS NOT NULL AND original_available = 0 AND hidden = 0 AND in_trash = 0 THEN 1 ELSE 0 END), 0) AS previewOnly,
      COALESCE(SUM(CASE WHEN media_id IS NULL AND hidden = 0 AND in_trash = 0 THEN 1 ELSE 0 END), 0) AS unavailable
      FROM apple_photos_assets WHERE scan_root_id = ?`).get(id) as { previewOnly: number; unavailable: number };
    return { ...(row ?? { status: "idle", processed: 0, total: 0, failed: 0, error: null, startedAt: null, finishedAt: null, lastSuccessAt: null }), ...availability };
  };
  app.get("/api/internal/update-readiness", async (request, reply) => {
    const expected=process.env.MEMORYLANE_DESKTOP_TOKEN;
    if(!expected||request.headers["x-memorylane-desktop-token"]!==expected)return reply.code(404).send({error:"Not found"});
    const reasons:string[]=[];
    if(ctx.pluginManager?.isBusy())reasons.push("A plugin operation is running");
    if(ctx.scanner.isRunning())reasons.push("A library scan is running");
    if(ctx.db.prepare("SELECT 1 FROM video_transcode_jobs WHERE status IN ('pending','transcoding') LIMIT 1").get())reasons.push("Video processing is running");
    if(ctx.db.prepare("SELECT 1 FROM apple_photos_sync_state WHERE status='running' LIMIT 1").get())reasons.push("Apple Photos sync is running");
    return reply.send({ready:reasons.length===0,reasons});
  });
  app.get("/api/plugins", { preHandler: app.requireAuth }, async (_request, reply) =>
    reply.send([applePhotosPluginStatus(ctx.db)]));

  // Generic first-party plugin inventory. The existing /api/plugins route
  // remains stable until the Phase 3 UI moves off the legacy Apple adapter.
  app.get("/api/plugin-platform", { preHandler: app.requireAuth }, async (_request, reply) =>
    reply.send(ctx.pluginManager?.inventory() ?? []));

  app.get("/api/plugin-platform/onboarding", { preHandler: app.requireAuth }, async (_request, reply) => {
    const inventory = ctx.pluginManager?.inventory() ?? [];
    return reply.send({ complete: ctx.pluginManager?.state.snapshot().onboardingComplete ?? true, plugins: inventory });
  });

  app.get("/api/plugin-platform/updates", { preHandler: app.requireAuth }, async (_request, reply) =>
    reply.send({ available: ctx.pluginManager?.availableUpdates() ?? [], history: ctx.pluginUpdates?.history() ?? [] }));

  app.post("/api/plugin-platform/updates/check", { preHandler: app.requireAuth }, async (_request, reply) => {
    if(!ctx.pluginUpdates)return reply.code(503).send({error:"Plugin update catalog is not configured"});
    try{return reply.send(await ctx.pluginUpdates.checkNow());}catch(error){return reply.code(503).send({error:error instanceof Error?error.message:String(error)});}
  });

  app.post("/api/plugin-platform/onboarding/complete", { preHandler: app.requireAuth }, async (_request, reply) => {
    if (!ctx.pluginManager) return reply.code(503).send({ error: "Plugin platform is unavailable on this system" });
    const missing = ctx.pluginManager.inventory().filter((plugin) => plugin.required && plugin.state !== "ready");
    if (missing.length) return reply.code(409).send({ error: `Required plugins are not ready: ${missing.map((item) => item.name).join(", ")}` });
    ctx.pluginManager.state.update((draft) => { draft.onboardingComplete = true; });
    return reply.send({ complete: true });
  });

  app.put("/api/plugin-platform/:id", { preHandler: app.requireAuth }, async (request, reply) => {
    if (!ctx.pluginManager) return reply.code(503).send({ error: "Plugin platform is unavailable on this system" });
    const id = (request.params as { id: string }).id;
    const parsed = z.object({ enabled: z.boolean(), version: z.string().optional() }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    // Required plugins can still be disabled internally as part of an update
    // (activateInstalledUpdate disables the old version before enabling the
    // new one) - that's not a user turning a core feature off, so the guard
    // belongs here, on the explicit user-facing request, not inside
    // PluginManager.disable() itself.
    if (!parsed.data.enabled && ctx.pluginManager.inventory().find((plugin) => plugin.id === id)?.required) {
      return reply.code(409).send({ error: "Required plugins cannot be disabled" });
    }
    // Same reasoning as the required-plugins guard above - enforced here,
    // not inside PluginManager.disable(), so activateInstalledUpdate()'s own
    // internal disable+enable cycle during a version update is unaffected.
    if (!parsed.data.enabled) {
      const dependents = ctx.pluginManager.enabledDependents(id);
      if (dependents.length > 0) return reply.code(409).send({ error: `Cannot disable - still needed by ${dependents.join(", ")}` });
    }
    try {
      if (parsed.data.enabled) {
        const version = parsed.data.version ?? ctx.pluginManager.state.snapshot().plugins[id]?.activeVersion;
        if (!version) return reply.code(409).send({ error: "Install a plugin version before enabling it" });
        await ctx.pluginManager.enable(id, version);
      } else await ctx.pluginManager.disable(id);
      if (id === "com.memorylane.apple-photos") ctx.db.prepare(`INSERT INTO plugin_settings (id, enabled) VALUES (?, ?)
        ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
        .run(APPLE_PHOTOS_PLUGIN_ID, parsed.data.enabled ? 1 : 0);
      return reply.send(ctx.pluginManager.inventory().find((plugin) => plugin.id === id));
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/plugin-platform/:id/:version", { preHandler: app.requireAuth }, async (request, reply) => {
    if (!ctx.pluginManager) return reply.code(503).send({ error: "Plugin platform is unavailable on this system" });
    const { id, version } = request.params as { id: string; version: string };
    try { await ctx.pluginManager.uninstall(id, version); return reply.code(204).send(); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.delete("/api/plugin-platform/:id", { preHandler: app.requireAuth }, async (request, reply) => {
    if (!ctx.pluginManager) return reply.code(503).send({ error: "Plugin platform is unavailable on this system" });
    const id = (request.params as { id: string }).id;
    try { await ctx.pluginManager.uninstallAll(id); return reply.code(204).send(); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  // The dev/local-catalog fallback (MEMORYLANE_BUNDLED_PLUGIN_REPOSITORY) lets
  // install/update be exercised from Settings against a directory built with
  // `npm run plugins:build -- stable development`, without standing up a real
  // HTTPS catalog - see docs/plugin-repository-deployment.md. It only kicks
  // in when no real catalog URL is configured, so a production deployment
  // with MEMORYLANE_PLUGIN_CATALOG_URL set is unaffected.
  app.post("/api/plugin-platform/:id/install", { preHandler: app.requireAuth }, async (request, reply) => {
    if (!ctx.pluginManager) return reply.code(503).send({ error: "Plugin platform is unavailable on this system" });
    const id = (request.params as { id: string }).id;
    const parsed = z.object({ version: z.string() }).strict().safeParse(request.body);
    const catalogUrl = process.env.MEMORYLANE_PLUGIN_CATALOG_URL;
    const bundledDirectory = process.env.MEMORYLANE_BUNDLED_PLUGIN_REPOSITORY ? resolveRepoPath(process.env.MEMORYLANE_BUNDLED_PLUGIN_REPOSITORY) : undefined;
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    // Dev-catalog plugins load straight from their source directory (see
    // dev-catalog.ts) - there's nothing to download or unpack, so "install"
    // is a no-op; the enable PUT below is what actually starts/loads them.
    if (ctx.pluginManager.isDevPlugin(id)) return reply.code(201).send(ctx.pluginManager.inventory().find((plugin) => plugin.id === id));
    if (!catalogUrl && !bundledDirectory) return reply.code(503).send({ error: "Plugin catalog is not configured" });
    try {
      if (catalogUrl) await ctx.pluginManager.installFromCatalog(id, parsed.data.version, catalogUrl);
      else await ctx.pluginManager.installFromDirectory(id, parsed.data.version, bundledDirectory!);
      return reply.code(201).send(ctx.pluginManager.inventory().find((plugin) => plugin.id === id));
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/plugin-platform/:id/update", { preHandler: app.requireAuth }, async (request, reply) => {
    if (!ctx.pluginManager) return reply.code(503).send({ error: "Plugin platform is unavailable on this system" });
    const id=(request.params as {id:string}).id, parsed=z.object({version:z.string()}).strict().safeParse(request.body);
    const catalogUrl=process.env.MEMORYLANE_PLUGIN_CATALOG_URL, bundledDirectory=process.env.MEMORYLANE_BUNDLED_PLUGIN_REPOSITORY?resolveRepoPath(process.env.MEMORYLANE_BUNDLED_PLUGIN_REPOSITORY):undefined;
    if(!parsed.success)return reply.code(400).send({error:"Invalid input"});
    if(ctx.pluginManager.isDevPlugin(id))return reply.send(ctx.pluginManager.inventory().find(p=>p.id===id));
    if(!catalogUrl&&!bundledDirectory)return reply.code(400).send({error:"Plugin version or catalog is unavailable"});
    try{
      if(catalogUrl)await ctx.pluginManager.updateFromCatalog(id,parsed.data.version,catalogUrl);
      else await ctx.pluginManager.updateFromDirectory(id,parsed.data.version,bundledDirectory!);
      return reply.send(ctx.pluginManager.inventory().find(p=>p.id===id));
    }
    catch(error){return reply.code(409).send({error:error instanceof Error?error.message:String(error)});}
  });

  app.get("/api/plugin-platform/:id/logs", { preHandler: app.requireAuth }, async (request, reply) => {
    if (!ctx.pluginManager) return reply.code(503).send({ error: "Plugin platform is unavailable on this system" });
    return reply.send({ lines: ctx.pluginManager.logs((request.params as {id:string}).id) });
  });

  app.put("/api/plugins/apple-photos", { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    if (parsed.data.enabled && process.platform !== "darwin") {
      return reply.code(409).send({ error: "Apple Photos is available only on macOS" });
    }
    ctx.db.prepare(`INSERT INTO plugin_settings (id, enabled) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
      .run(APPLE_PHOTOS_PLUGIN_ID, parsed.data.enabled ? 1 : 0);
    if (parsed.data.enabled) ctx.analysisWorker.kick();
    return reply.send(applePhotosPluginStatus(ctx.db));
  });

  app.get("/api/plugins/apple-photos/health", { preHandler: app.requireAuth }, async (_request, reply) => {
    if (!isApplePhotosEnabled(ctx.db)) return reply.code(409).send({ error: "Apple Photos is disabled" });
    try {
      const { applePhotosHealth } = await import("./apple-photos/plugin-client.js");
      if (!ctx.pluginManager) throw new Error("Plugin platform unavailable");
      return reply.send(await applePhotosHealth(ctx.pluginManager));
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : "Photos helper unavailable" });
    }
  });

  app.get("/api/plugins/apple-photos/libraries", { preHandler: app.requireAuth }, async (_request, reply) => {
    if (!isApplePhotosEnabled(ctx.db)) return reply.code(409).send({ error: "Apple Photos is disabled" });
    const { detectApplePhotosLibraries } = await import("./apple-photos/plugin-client.js");
    if (!ctx.pluginManager) return reply.code(503).send({ error: "Plugin platform unavailable" });
    return reply.send(await detectApplePhotosLibraries(ctx.pluginManager));
  });

  const resolveRoot = (id: number) => ctx.db.prepare("SELECT id, path, enabled FROM scan_roots WHERE id = ? AND kind = 'apple-photos'")
    .get(id) as { id: number; path: string; enabled: number } | undefined;

  app.get("/api/plugins/apple-photos/roots/:id/preview", { preHandler: app.requireAuth }, async (request, reply) => {
    if (!isApplePhotosEnabled(ctx.db)) return reply.code(404).send({ error: "Apple Photos is disabled" });
    const id = Number((request.params as { id: string }).id);
    const root = Number.isSafeInteger(id) ? resolveRoot(id) : undefined;
    if (!root || !root.enabled) return reply.code(404).send({ error: "Apple Photos root not found" });
    const parsed = z.object({
      year: z.union([z.literal("all"), z.literal("unknown"), z.string().regex(/^\d{4}$/)]).optional(),
      month: z.string().regex(/^(0[1-9]|1[0-2])$/).optional(),
    }).strict().safeParse(request.query);
    if (!parsed.success || (parsed.data.month && (!parsed.data.year || parsed.data.year === "all" || parsed.data.year === "unknown"))) {
      return reply.code(400).send({ error: "Invalid preview query" });
    }
    const { previewApplePhotos } = await import("./apple-photos/browse.js");
    return reply.send({ items: previewApplePhotos(ctx.db, id, parsed.data.year ?? null, parsed.data.month ?? null, 6) });
  });

  app.get("/api/plugins/apple-photos/roots/:id/browse", { preHandler: app.requireAuth }, async (request, reply) => {
    if (!isApplePhotosEnabled(ctx.db)) return reply.code(404).send({ error: "Apple Photos is disabled" });
    const id = Number((request.params as { id: string }).id);
    const root = Number.isSafeInteger(id) ? resolveRoot(id) : undefined;
    if (!root || !root.enabled) return reply.code(404).send({ error: "Apple Photos root not found" });
    const parsed = z.object({
      year: z.union([z.literal("all"), z.literal("unknown"), z.string().regex(/^\d{4}$/)]).optional(),
      month: z.string().regex(/^(0[1-9]|1[0-2])$/).optional(),
      offset: z.coerce.number().int().min(0).default(0),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }).strict().safeParse(request.query);
    if (!parsed.success || (parsed.data.month && (!parsed.data.year || parsed.data.year === "all" || parsed.data.year === "unknown"))) {
      return reply.code(400).send({ error: "Invalid browse query" });
    }
    const { browseApplePhotos } = await import("./apple-photos/browse.js");
    const result = browseApplePhotos(ctx.db, id, parsed.data.year ?? null, parsed.data.month ?? null, parsed.data.offset, parsed.data.limit);
    const ids = result.items.flatMap((item) => item.mediaId === null ? [] : [item.mediaId]);
    if (ids.length === 0) return reply.send(result);
    const placeholders = ids.map(() => "?").join(",");
    const rows = ctx.db.prepare(`SELECT * FROM media WHERE id IN (${placeholders})`).all(...ids) as MediaRow[];
    const byId = new Map(decorateMedia(ctx, rows.map(toMediaDto)).map((media) => [media.id, media]));
    return reply.send({ ...result, items: result.items.map((item) => ({ ...item, media: item.mediaId === null ? null : byId.get(item.mediaId) ?? null })) });
  });

  const catalogItem = (id: number, uuid: string) => ctx.db.prepare(`SELECT uuid FROM apple_photos_assets
    WHERE scan_root_id = ? AND uuid = ? AND hidden = 0 AND in_trash = 0`).get(id, uuid) as { uuid: string } | undefined;
  const catalogActionInput = z.object({ uuid: z.string().min(1).max(200) }).strict();

  app.post("/api/plugins/apple-photos/roots/:id/items/open-in-photos", { preHandler: app.requireAuth }, async (request, reply) => {
    if (!isApplePhotosEnabled(ctx.db)) return reply.code(404).send({ error: "Apple Photos is disabled" });
    const id = Number((request.params as { id: string }).id);
    const input = catalogActionInput.safeParse(request.body);
    const root = Number.isSafeInteger(id) ? resolveRoot(id) : undefined;
    if (!root || !root.enabled || !input.success || !catalogItem(id, input.data.uuid)) {
      return reply.code(404).send({ error: "Apple Photos item not found" });
    }
    try {
      const { openInApplePhotos } = await import("./apple-photos/plugin-client.js");
      if (!ctx.pluginManager) throw new Error("Plugin platform unavailable");
      await openInApplePhotos(ctx.pluginManager, input.data.uuid);
      return reply.send({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not open Photos";
      if (message.includes("-1743") || message.toLowerCase().includes("not authorized")) {
        return reply.code(403).send({ error: "macOS denied Photos Automation access. Allow it in System Settings → Privacy & Security → Automation." });
      }
      return reply.code(503).send({ error: "Photos could not open this item. Check that this library is open in Photos." });
    }
  });

  app.post("/api/plugins/apple-photos/roots/:id/items/check-local", { preHandler: app.requireAuth }, async (request, reply) => {
    if (!isApplePhotosEnabled(ctx.db)) return reply.code(404).send({ error: "Apple Photos is disabled" });
    const id = Number((request.params as { id: string }).id);
    const input = catalogActionInput.safeParse(request.body);
    const root = Number.isSafeInteger(id) ? resolveRoot(id) : undefined;
    if (!root || !root.enabled || !input.success || !catalogItem(id, input.data.uuid)) {
      return reply.code(404).send({ error: "Apple Photos item not found" });
    }
    if (activeSyncs.has(id)) return reply.code(409).send({ error: "Sync is already running. Check again when it finishes." });
    try {
      const { fetchCatalogPage } = await import("./apple-photos/plugin-client.js");
      const { findAppleCatalogAsset, upsertAppleAsset, applyAppleMetadata } = await import("./apple-photos/sync.js");
      if (!ctx.pluginManager) throw new Error("Plugin platform unavailable");
      const asset = await findAppleCatalogAsset((cursor) => fetchCatalogPage(ctx.pluginManager!, root.path, cursor), input.data.uuid);
      if (!asset) return reply.code(404).send({ error: "Item is no longer in the Photos catalog" });
      if (!isApplePhotosEnabled(ctx.db) || !resolveRoot(id)?.enabled) return reply.code(409).send({ error: "Apple Photos is disabled" });
      const result = upsertAppleAsset(ctx.db, id, asset);
      if (result.mediaId !== null && result.changed) {
        const media = ctx.db.prepare("SELECT id, parent_folder_id, absolute_path, media_type FROM media WHERE id = ?")
          .get(result.mediaId) as { id: number; parent_folder_id: number; absolute_path: string; media_type: "image" | "raw" | "video" };
        const { processMediaItem } = await import("../media/media-processor.js");
        await processMediaItem(ctx.db, ctx.paths, app.log as unknown as Logger, media);
        applyAppleMetadata(ctx.db, result.mediaId, asset, result.preserveCapturedDate, result.preservedCapturedDate);
        ctx.analysisWorker.kick();
      }
      const indexed = result.mediaId === null ? null : ctx.db.prepare("SELECT status FROM media WHERE id = ?")
        .get(result.mediaId) as { status: string } | undefined;
      return reply.send({ available: indexed?.status === "active" });
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : "Could not check Photos catalog" });
    }
  });

  app.get("/api/plugins/apple-photos/roots/:id/sync", { preHandler: app.requireAuth }, async (request, reply) => {
    if (!isApplePhotosEnabled(ctx.db)) return reply.code(409).send({ error: "Apple Photos is disabled" });
    const id = Number((request.params as { id: string }).id);
    if (!Number.isSafeInteger(id) || !resolveRoot(id)) return reply.code(404).send({ error: "Apple Photos root not found" });
    return reply.send(readSync(id));
  });

  const startSync = async (root: { id: number; path: string; enabled: number }): Promise<{ completion: Promise<void> }> => {
    const id = root.id;
    if (!isApplePhotosEnabled(ctx.db)) throw new Error("Apple Photos is disabled");
    if (!root.enabled) throw new Error("Apple Photos root is disabled");
    if (activeSyncs.has(id)) throw new Error("Sync already running");
    activeSyncs.add(id);
    try {
      const { applePhotosHealth, fetchCatalogPage } = await import("./apple-photos/plugin-client.js");
      if (!ctx.pluginManager) throw new Error("Plugin platform unavailable");
      await applePhotosHealth(ctx.pluginManager);
      const { syncAppleRoot, shouldKickAppleAnalysis } = await import("./apple-photos/sync.js");
      ctx.db.prepare(`INSERT INTO apple_photos_sync_state (scan_root_id, status, processed, total, failed, last_error, started_at, finished_at)
        VALUES (?, 'running', 0, 0, 0, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL)
        ON CONFLICT(scan_root_id) DO UPDATE SET status = 'running', processed = 0, total = 0, failed = 0,
          last_error = NULL, started_at = excluded.started_at, finished_at = NULL`).run(id);
      const completion = syncAppleRoot(ctx.db, id,
        (cursor) => fetchCatalogPage(ctx.pluginManager!, root.path, cursor),
        () => isApplePhotosEnabled(ctx.db) && resolveRoot(id)?.enabled === 1,
        async ({ mediaId, changed, preserveCapturedDate, preservedCapturedDate }, asset) => {
          if (!changed || mediaId === null) return;
          const media = ctx.db.prepare("SELECT id, parent_folder_id, absolute_path, media_type FROM media WHERE id = ?")
            .get(mediaId) as { id: number; parent_folder_id: number; absolute_path: string; media_type: "image" | "raw" | "video" };
          const { processMediaItem } = await import("../media/media-processor.js");
          await processMediaItem(ctx.db, ctx.paths, app.log as unknown as Logger, media);
          const { applyAppleMetadata } = await import("./apple-photos/sync.js");
          applyAppleMetadata(ctx.db, mediaId, asset, preserveCapturedDate, preservedCapturedDate);
        },
        (processed, total) => {
          if (shouldKickAppleAnalysis(processed)) ctx.analysisWorker.kick();
          if (processed === 1 || processed % 25 === 0 || processed === total) {
            ctx.db.prepare("UPDATE apple_photos_sync_state SET processed = ?, total = ? WHERE scan_root_id = ?").run(processed, total, id);
          }
        },
        (error, asset) => {
          app.log.warn({ err: error, uuid: asset.uuid, scanRootId: id }, "Skipping Apple Photos asset");
          ctx.db.prepare("UPDATE apple_photos_sync_state SET failed = failed + 1, last_error = ? WHERE scan_root_id = ?")
            .run(error.message, id);
        })
        .then((result) => {
          ctx.db.prepare(`UPDATE apple_photos_sync_state SET status = ?, processed = ?, total = ?, failed = ?,
            finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            last_success_at = CASE WHEN ? = 0 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE last_success_at END
            WHERE scan_root_id = ?`).run(result.cancelled ? "cancelled" : "completed", result.processed, result.total, result.failed, result.cancelled || result.failed ? 1 : 0, id);
        })
        .catch((error: unknown) => {
          ctx.db.prepare(`UPDATE apple_photos_sync_state SET status = 'failed', last_error = ?,
            finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE scan_root_id = ?`)
            .run(error instanceof Error ? error.message : String(error), id);
          throw error;
        })
        .finally(() => { activeSyncs.delete(id); ctx.analysisWorker.kick(); });
      return { completion };
    } catch (error) {
      activeSyncs.delete(id);
      throw error;
    }
  };

  ctx.scanner.onAppleRootSync?.(async (id) => {
    const root = resolveRoot(id);
    if (!root) throw new Error("Apple Photos root not found");
    const { completion } = await startSync(root);
    await completion;
  });

  app.post("/api/plugins/apple-photos/roots/:id/sync", { preHandler: app.requireAuth }, async (request, reply) => {
    if (!isApplePhotosEnabled(ctx.db)) return reply.code(409).send({ error: "Apple Photos is disabled" });
    const id = Number((request.params as { id: string }).id);
    const root = Number.isSafeInteger(id) ? resolveRoot(id) : undefined;
    if (!root) return reply.code(404).send({ error: "Apple Photos root not found" });
    if (!root.enabled) return reply.code(409).send({ error: "Apple Photos root is disabled" });
    if (activeSyncs.has(id)) return reply.code(409).send({ error: "Sync already running" });
    try {
      const { completion } = await startSync(root);
      void completion.catch(() => {}); // Status and logs are recorded above; the browser polls it.
      return reply.code(202).send(readSync(id));
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : "Photos helper unavailable" });
    }
  });

  app.post("/api/plugins/apple-photos/open-in-photos", { preHandler: app.requireAuth }, async (request, reply) => {
    if (!isApplePhotosEnabled(ctx.db)) return reply.code(409).send({ error: "Apple Photos is disabled" });
    const parsed = z.object({ mediaId: z.number().int().positive() }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    const asset = ctx.db.prepare(`SELECT a.uuid FROM apple_photos_assets a JOIN media m ON m.id = a.media_id
      JOIN scan_roots r ON r.id = a.scan_root_id
      WHERE a.media_id = ? AND (m.status = 'active' OR m.id IN (SELECT media_id FROM deletion_marks)) AND r.enabled = 1`)
      .get(parsed.data.mediaId) as { uuid: string } | undefined;
    if (!asset) return reply.code(404).send({ error: "Apple Photos item not found" });
    try {
      const { openInApplePhotos } = await import("./apple-photos/plugin-client.js");
      if (!ctx.pluginManager) throw new Error("Plugin platform unavailable");
      await openInApplePhotos(ctx.pluginManager, asset.uuid);
      return reply.send({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not open Photos";
      if (message.includes("-1743") || message.toLowerCase().includes("not authorized")) {
        return reply.code(403).send({ error: "macOS denied Photos Automation access. Allow it in System Settings → Privacy & Security → Automation." });
      }
      return reply.code(503).send({ error: "Photos could not open this item. Check that this library is open in Photos." });
    }
  });
}
