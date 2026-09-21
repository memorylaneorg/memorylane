import type { FastifyInstance } from "fastify";
import { updateSettingsRequestSchema, moveDataDirRequestSchema, type StorageStatsDto, type VersionDto, type MoveDataDirResultDto } from "@memorylane/shared";
import { moveDataDir, pendingMoveTarget, DataDirMoveError } from "../config/data-dir-move.js";
import type { AppContext } from "../context.js";
import { SettingsRepo } from "../db/settings-repo.js";
import { getDirectorySize, getFileSize } from "../util/dir-size.js";
import { APP_VERSION } from "../version.js";

export async function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const repo = new SettingsRepo(ctx.db);

  app.get("/api/settings", { preHandler: app.requireAuth }, async (_request, reply) => {
    return reply.send(repo.getAll());
  });

  app.put("/api/settings", { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = updateSettingsRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid input", details: parsed.error.flatten() });
    }
    const updated = repo.update(parsed.data);
    // New thresholds apply on the worker's next idle pass over every folder.
    if (
      parsed.data.stackGapSeconds !== undefined ||
      parsed.data.stackMaxHamming !== undefined ||
      parsed.data.stackMinCosine !== undefined ||
      parsed.data.stackSeriesGapSeconds !== undefined
    ) {
      ctx.stacks.markAllDirty();
    }
    // A different face model means every stored detection is stale.
    if (parsed.data.faceModel !== undefined) ctx.analysisWorker.requeueStale();
    if (parsed.data.personsEnabled !== undefined || parsed.data.aiEnabled !== undefined) ctx.analysisWorker.kick();
    return reply.send(updated);
  });

  // Disk usage of MemoryLane's own disposable app-data directory (thumbnail
  // cache, database, logs) - entirely separate from the source photo library.
  app.get("/api/settings/storage", { preHandler: app.requireAuth }, async (_request, reply) => {
    const { paths } = ctx;
    const [thumbnailCacheBytes, previewsBytes, vectorsBytes, facesBytes, databaseBytes, walBytes, shmBytes, logsBytes] = await Promise.all([
      getDirectorySize(paths.thumbnailsDir),
      getDirectorySize(paths.previewsDir),
      getDirectorySize(paths.vectorsDir),
      getDirectorySize(paths.facesDir),
      getFileSize(paths.dbPath),
      getFileSize(`${paths.dbPath}-wal`),
      getFileSize(`${paths.dbPath}-shm`),
      getDirectorySize(paths.logsDir),
    ]);
    const databaseTotal = databaseBytes + walBytes + shmBytes;

    const stats: StorageStatsDto = {
      thumbnailCacheBytes,
      previewsBytes,
      vectorsBytes,
      facesBytes,
      databaseBytes: databaseTotal,
      logsBytes,
      totalBytes: thumbnailCacheBytes + previewsBytes + vectorsBytes + facesBytes + databaseTotal + logsBytes,
      dataDir: paths.dataDir,
      dataDirSource: paths.dataDirSource,
      pendingMoveTo: pendingMoveTarget(paths),
    };
    return reply.send(stats);
  });

  // Copies the whole data directory somewhere else (another disk) and makes
  // that the location for the next start. Refused while a scan is running.
  app.post("/api/settings/data-dir", { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = moveDataDirRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    if (ctx.scanner.isRunning()) return reply.code(409).send({ error: "Wait for the running scan to finish first" });
    try {
      const { copiedBytes } = await moveDataDir(ctx.db, ctx.paths, parsed.data.path, app.log, {
        pause: () => ctx.analysisWorker.stop(),
        resume: () => ctx.analysisWorker.start(),
      });
      const result: MoveDataDirResultDto = { from: ctx.paths.dataDir, to: parsed.data.path, copiedBytes, restartRequired: true };
      return reply.send(result);
    } catch (err) {
      if (err instanceof DataDirMoveError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  app.get("/api/settings/version", { preHandler: app.requireAuth }, async (_request, reply) => {
    const version: VersionDto = { version: APP_VERSION };
    return reply.send(version);
  });
}
