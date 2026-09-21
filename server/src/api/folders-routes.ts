import type { FastifyInstance } from "fastify";
import { paginationQuerySchema, folderMediaQuerySchema, type FolderBreadcrumbDto } from "@memorylane/shared";
import type { AppContext } from "../context.js";
import {
  toFolderDto,
  toMediaDto,
  EXCLUDE_LIVE_PHOTO_VIDEOS,
  EXCLUDE_PAIRED_RAW,
  type FolderRow,
  type FolderCounts,
  type MediaRow,
} from "./mappers.js";
import { buildMediaQuery, mediaCountSql, mediaSelectSql, ACTIVE_SOURCE_SQL, APPLE_PLUGIN_ENABLED_SQL, UNMARKED_MEDIA_SQL } from "../query/media-query.js";
import { isApplePhotosEnabled } from "../plugins/registry.js";
import { decorateMedia } from "./decorate-media.js";

// Recursive CTE selecting a folder and every active descendant - reused by the
// "all files in this folder tree" flat view.
const DESCENDANT_FOLDERS_CTE = `
  WITH RECURSIVE descendant_folders(id) AS (
    SELECT id FROM folders WHERE id = ? AND status = 'active'
    UNION ALL
    SELECT f.id FROM folders f JOIN descendant_folders d ON f.parent_id = d.id WHERE f.status = 'active'
  )
`;

// Direct-children-only counts - callers combine this with getRecursiveFolderStats
// before passing the result to toFolderDto, which requires both.
export function getFolderCounts(
  ctx: AppContext,
  folderId: number,
): Omit<FolderCounts, "recursiveMediaCount" | "recursiveSizeBytes"> {
  const mediaCount = (
    ctx.db
      .prepare(
        `SELECT COUNT(*) as c FROM media WHERE parent_folder_id = ? AND status = 'active' AND ${ACTIVE_SOURCE_SQL} AND ${UNMARKED_MEDIA_SQL} AND ${EXCLUDE_LIVE_PHOTO_VIDEOS} AND ${EXCLUDE_PAIRED_RAW}`,
      )
      .get(folderId) as { c: number }
  ).c;
  const childFolderCount = (
    ctx.db
      .prepare("SELECT COUNT(*) as c FROM folders WHERE parent_id = ? AND status = 'active'")
      .get(folderId) as { c: number }
  ).c;
  // Randomized (not "most recent") so a folder's cover photo changes on every
  // request instead of always showing the same one - matches the Home hero's
  // "re-rolled on every load" feel.
  let thumbRow = ctx.db
    .prepare(
      `SELECT media.id, media.thumbnail_version FROM media WHERE parent_folder_id = ? AND status = 'active' AND ${ACTIVE_SOURCE_SQL} AND ${UNMARKED_MEDIA_SQL} AND thumbnail_status = 'done' AND ${EXCLUDE_LIVE_PHOTO_VIDEOS} AND ${EXCLUDE_PAIRED_RAW}
       ORDER BY RANDOM() LIMIT 1`,
    )
    .get(folderId) as { id: number; thumbnail_version: number } | undefined;

  // Folders that only contain subfolders (e.g. a year folder like "1999" with
  // no photos directly in it) would otherwise show no cover image at all -
  // fall back to a random photo anywhere in the subtree.
  if (!thumbRow) {
    thumbRow = ctx.db
      .prepare(
        `${DESCENDANT_FOLDERS_CTE}
         SELECT media.id, media.thumbnail_version FROM media
         WHERE parent_folder_id IN (SELECT id FROM descendant_folders) AND status = 'active' AND ${ACTIVE_SOURCE_SQL} AND ${UNMARKED_MEDIA_SQL} AND thumbnail_status = 'done' AND ${EXCLUDE_LIVE_PHOTO_VIDEOS} AND ${EXCLUDE_PAIRED_RAW}
         ORDER BY RANDOM() LIMIT 1`,
      )
      .get(folderId) as { id: number; thumbnail_version: number } | undefined;
  }

  return {
    mediaCount,
    childFolderCount,
    thumbnailMediaId: thumbRow?.id ?? null,
    thumbnailVersion: thumbRow?.thumbnail_version ?? 0,
  };
}

// Totals across a folder's entire subtree (not just direct children) - used
// only for the top-level "Your Library" cards on Home, where seeing "600
// items, 2.8 GB" for a whole year/scan-root folder is more useful than the
// direct-child-only counts shown elsewhere.
export function getRecursiveFolderStats(ctx: AppContext, folderId: number): { count: number; sizeBytes: number } {
  const row = ctx.db
    .prepare(
      `${DESCENDANT_FOLDERS_CTE}
       SELECT COUNT(*) as c, COALESCE(SUM(file_size), 0) as s FROM media
       WHERE parent_folder_id IN (SELECT id FROM descendant_folders) AND status = 'active' AND ${ACTIVE_SOURCE_SQL} AND ${UNMARKED_MEDIA_SQL}`,
    )
    .get(folderId) as { c: number; s: number };
  return { count: row.c, sizeBytes: row.s };
}

export async function registerFolderRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db } = ctx;

  app.get("/api/folders", { preHandler: app.requireAuth }, async (_request, reply) => {
    // Top-level folders mirror their scan root's manually-arranged order
    // (Settings > Scan Folders), not alphabetical - see scan-roots-routes.ts move endpoint.
    const rows = db
      .prepare(
        `SELECT folders.* FROM folders
         JOIN scan_roots ON scan_roots.id = folders.scan_root_id
         WHERE folders.parent_id IS NULL AND folders.status = 'active'
           AND (scan_roots.kind != 'apple-photos' OR ${APPLE_PLUGIN_ENABLED_SQL})
         ORDER BY scan_roots.sort_order, scan_roots.id`,
      )
      .all() as FolderRow[];
    return reply.send(
      rows.map((row) => {
        const recursive = getRecursiveFolderStats(ctx, row.id);
        return toFolderDto(row, {
          ...getFolderCounts(ctx, row.id),
          recursiveMediaCount: recursive.count,
          recursiveSizeBytes: recursive.sizeBytes,
        });
      }),
    );
  });

  app.get("/api/folders/:id", { preHandler: app.requireAuth }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const row = db.prepare("SELECT * FROM folders WHERE id = ?").get(id) as FolderRow | undefined;
    if (!row) return reply.code(404).send({ error: "Folder not found" });
    const source = db.prepare("SELECT kind FROM scan_roots WHERE id = ?").get(row.scan_root_id) as { kind: string } | undefined;
    if (source?.kind === "apple-photos" && !isApplePhotosEnabled(db)) return reply.code(404).send({ error: "Folder not found" });

    const breadcrumbs: FolderBreadcrumbDto[] = [];
    let cursor: FolderRow | undefined = row;
    while (cursor) {
      breadcrumbs.unshift({ id: cursor.id, name: cursor.name });
      cursor = cursor.parent_id
        ? (db.prepare("SELECT * FROM folders WHERE id = ?").get(cursor.parent_id) as FolderRow | undefined)
        : undefined;
    }

    const recursive = getRecursiveFolderStats(ctx, row.id);
    const folder = toFolderDto(row, {
      ...getFolderCounts(ctx, row.id),
      recursiveMediaCount: recursive.count,
      recursiveSizeBytes: recursive.sizeBytes,
    });
    return reply.send({ folder, breadcrumbs });
  });

  app.get("/api/folders/:id/children", { preHandler: app.requireAuth }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = paginationQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid query" });
    const { offset, limit } = parsed.data;

    const parent = db.prepare("SELECT scan_root_id FROM folders WHERE id = ?").get(id) as { scan_root_id: number } | undefined;
    if (parent) {
      const source = db.prepare("SELECT kind FROM scan_roots WHERE id = ?").get(parent.scan_root_id) as { kind: string } | undefined;
      if (source?.kind === "apple-photos" && !isApplePhotosEnabled(db)) return reply.code(404).send({ error: "Folder not found" });
    }

    const total = (
      db.prepare("SELECT COUNT(*) as c FROM folders WHERE parent_id = ? AND status = 'active'").get(id) as {
        c: number;
      }
    ).c;
    const rows = db
      .prepare("SELECT * FROM folders WHERE parent_id = ? AND status = 'active' ORDER BY name LIMIT ? OFFSET ?")
      .all(id, limit, offset) as FolderRow[];

    return reply.send({
      // Recursive stats too, not just direct counts - so a subfolder card
      // reads "600 items, 2.8 GB" the same way the top-level Home cards do,
      // instead of switching to a different (direct-count-only) summary once
      // you're a level deep.
      items: rows.map((row) => {
        const recursive = getRecursiveFolderStats(ctx, row.id);
        return toFolderDto(row, {
          ...getFolderCounts(ctx, row.id),
          recursiveMediaCount: recursive.count,
          recursiveSizeBytes: recursive.sizeBytes,
        });
      }),
      total,
      offset,
      limit,
    });
  });

  app.get("/api/folders/:id/preview", { preHandler: app.requireAuth }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isSafeInteger(id)) return reply.code(404).send({ error: "Folder not found" });
    const folder = db.prepare(`SELECT f.id, sr.kind FROM folders f JOIN scan_roots sr ON sr.id = f.scan_root_id
      WHERE f.id = ? AND f.status = 'active'`).get(id) as { id: number; kind: string } | undefined;
    if (!folder || (folder.kind === "apple-photos" && !isApplePhotosEnabled(db))) {
      return reply.code(404).send({ error: "Folder not found" });
    }
    const previewItems = (recursive: boolean) => {
      const query = buildMediaQuery({ scope: { kind: "folder", folderId: id, recursive }, type: "photo", thumbnailDone: true });
      return db.prepare(`${query.cte} SELECT media.id, media.thumbnail_version AS thumbnailVersion
        FROM media ${query.joins} WHERE ${query.where} ORDER BY media.id DESC LIMIT 6`)
        .all(...query.bindings);
    };
    const direct = previewItems(false) as Array<{ id: number; thumbnailVersion: number }>;
    // One direct photo is not enough to animate a card. Fill the small,
    // bounded preview set from descendants while keeping direct photos first.
    const recursive = direct.length < 6 ? previewItems(true) as Array<{ id: number; thumbnailVersion: number }> : [];
    const seen = new Set<number>();
    const items = [...direct, ...recursive].filter((item) => {
      if (seen.size >= 6 || seen.has(item.id)) return false;
      seen.add(item.id); return true;
    });
    return reply.send({ items });
  });

  app.get("/api/folders/:id/media", { preHandler: app.requireAuth }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = folderMediaQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid query" });
    const { offset, limit, recursive, type, expandStacks } = parsed.data;

    const q = buildMediaQuery({ scope: { kind: "folder", folderId: id, recursive }, type, collapseStacks: !expandStacks });
    const total = (db.prepare(mediaCountSql(q)).get(...q.bindings) as { c: number }).c;
    const rows = db.prepare(mediaSelectSql(q)).all(...q.bindings, limit, offset) as MediaRow[];
    return reply.send({ items: decorateMedia(ctx, rows.map(toMediaDto)), total, offset, limit });
  });
}
