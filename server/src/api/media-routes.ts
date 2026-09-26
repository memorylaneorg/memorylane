import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { updateFavoriteRequestSchema, mediaListQuerySchema } from "@memorylane/shared";
import type { AppContext } from "../context.js";
import { toMediaDto, type MediaRow } from "./mappers.js";
import { thumbnailPathForMediaId, previewPathForMediaId } from "../config/paths.js";
import { streamFile, mimeTypeForExtension } from "./file-streaming.js";
import { EngagementRepo } from "../db/engagement-repo.js";
import { decorateMedia } from "./decorate-media.js";
import { buildMediaQuery, mediaCountSql, mediaSelectSql } from "../query/media-query.js";
import { toMediaQueryParams } from "./reports-routes.js";
import { isApplePhotosEnabled } from "../plugins/registry.js";

interface MediaWithRootRow extends MediaRow {
  scan_root_path: string;
  scan_root_enabled: number;
}

// Central safe-lookup: resolves a media id to a verified, on-disk, enabled-root
// path. Never trusts a path from the request - only the database. See spec
// section 24 (Safe File Serving).
function resolveVerifiedMedia(ctx: AppContext, id: number, allowMarkedMissing = false): MediaWithRootRow | null {
  const row = ctx.db
    .prepare(
      `SELECT media.*, scan_roots.path as scan_root_path, scan_roots.enabled as scan_root_enabled
       FROM media JOIN scan_roots ON scan_roots.id = media.scan_root_id
       WHERE media.id = ?`,
    )
    .get(id) as MediaWithRootRow | undefined;
  if (!row) return null;
  if (!row.scan_root_enabled) return null;
  if (row.status !== "active" && !(allowMarkedMissing && ctx.db.prepare("SELECT 1 FROM deletion_marks WHERE media_id = ?").get(id))) return null;
  if (row.source_kind === "apple-photos" && !isApplePhotosEnabled(ctx.db)) return null;

  const resolvedPath = path.resolve(row.absolute_path);
  const resolvedRoot = path.resolve(row.scan_root_path);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null; // defense in depth

  return row;
}

export async function registerMediaRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db, paths } = ctx;
  const engagement = new EngagementRepo(db);
  const visibleById = (id: number): MediaRow | undefined => {
    const row = db.prepare("SELECT * FROM media WHERE id = ? AND status = 'active'").get(id) as MediaRow | undefined;
    if (row?.source_kind === "apple-photos" && !isApplePhotosEnabled(db)) return undefined;
    return row;
  };
  const visibleSourceById = (id: number): { source_kind: string } | undefined => {
    const row = db.prepare("SELECT source_kind FROM media WHERE id = ? AND status = 'active'").get(id) as
      | { source_kind: string }
      | undefined;
    if (row?.source_kind === "apple-photos" && !isApplePhotosEnabled(db)) return undefined;
    return row;
  };

  // Library-wide filtered listing - backs the Reports grid. Same filter
  // vocabulary as /api/reports/facets and export.csv (see reports-routes.ts).
  app.get("/api/media", { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = mediaListQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid query" });
    const { offset, limit, ...filters } = parsed.data;
    const q = buildMediaQuery(toMediaQueryParams(filters));
    const total = (db.prepare(mediaCountSql(q)).get(...q.bindings) as { c: number }).c;
    const rows = db.prepare(mediaSelectSql(q)).all(...q.bindings, limit, offset) as MediaRow[];
    return reply.send({ items: decorateMedia(ctx, rows.map(toMediaDto)), total, offset, limit });
  });

  app.get("/api/media/:id", { preHandler: app.requireAuth }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const row = visibleById(id);
    if (!row) return reply.code(404).send({ error: "Media not found" });
    const [dto] = decorateMedia(ctx, [toMediaDto(row)]);
    return reply.send(dto);
  });

  app.put("/api/media/:id/favorite", { preHandler: app.requireAuth }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = updateFavoriteRequestSchema.safeParse(request.body);
    if (!parsed.success || Number.isNaN(id)) {
      return reply.code(400).send({ error: "Invalid input" });
    }
    const exists = visibleSourceById(id);
    if (!exists) return reply.code(404).send({ error: "Media not found" });

    return reply.send(engagement.setFavorite(id, parsed.data.favorite));
  });

  // Shown/viewed are fire-and-forget engagement signals from the photo
  // viewer (Surprise Me, slideshows, fullscreen) - never from grid/search
  // thumbnails. The client is responsible for not spamming these (one
  // "shown" per photo transition, one "viewed" per ~2s dwell) - see
  // Viewer.tsx / InlineSlideshow.tsx.
  app.post("/api/media/:id/shown", { preHandler: app.requireAuth }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (Number.isNaN(id)) return reply.code(400).send({ error: "Invalid id" });
    const exists = visibleSourceById(id);
    if (!exists) return reply.code(404).send({ error: "Media not found" });
    engagement.recordShown(id);
    return reply.send({ ok: true });
  });

  app.post("/api/media/:id/viewed", { preHandler: app.requireAuth }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (Number.isNaN(id)) return reply.code(400).send({ error: "Invalid id" });
    const exists = visibleSourceById(id);
    if (!exists) return reply.code(404).send({ error: "Media not found" });
    engagement.recordViewed(id);
    return reply.send({ ok: true });
  });

  app.get("/api/media/:id/file", { preHandler: app.requireAuth }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const media = resolveVerifiedMedia(ctx, id);
    if (!media) return reply.code(404).send({ error: "Media not found" });
    if (!fs.existsSync(media.absolute_path)) return reply.code(404).send({ error: "File missing on disk" });

    if (media.source_kind === "apple-photos") {
      reply.header("Cache-Control", "no-store");
      if (media.original_available === 0) reply.header("X-MemoryLane-Source", "derivative");
    }

    return streamFile(request, reply, media.absolute_path, mimeTypeForExtension(media.extension));
  });

  app.get("/api/media/:id/thumbnail", { preHandler: app.requireAuth }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const media = resolveVerifiedMedia(ctx, id, true);
    if (!media) return reply.code(404).send({ error: "Media not found" });

    const thumbPath = thumbnailPathForMediaId(paths.thumbnailsDir, id);
    if (media.thumbnail_status !== "done" || !fs.existsSync(thumbPath)) {
      return reply.code(404).send({ error: "Thumbnail not available" });
    }
    reply.header("Cache-Control", media.source_kind === "apple-photos" ? "no-store" : "private, max-age=31536000, immutable");
    return streamFile(request, reply, thumbPath, "image/jpeg");
  });

  // Larger RAW-only preview for the fullscreen Viewer - see
  // media/thumbnail-generator.ts PREVIEW_LONG_EDGE. Not generated for
  // standard images (they use /file at full original resolution instead).
  app.get("/api/media/:id/preview", { preHandler: app.requireAuth }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const media = resolveVerifiedMedia(ctx, id, true);
    if (!media) return reply.code(404).send({ error: "Media not found" });

    const previewPath = previewPathForMediaId(paths.previewsDir, id);
    if (media.thumbnail_status !== "done" || !fs.existsSync(previewPath)) {
      return reply.code(404).send({ error: "Preview not available" });
    }
    reply.header("Cache-Control", media.source_kind === "apple-photos" ? "no-store" : "private, max-age=31536000, immutable");
    return streamFile(request, reply, previewPath, "image/jpeg");
  });
}
