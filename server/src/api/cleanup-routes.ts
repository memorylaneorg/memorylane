import type { FastifyInstance } from "fastify";
import { markForDeletionRequestSchema, paginationQuerySchema } from "@memorylane/shared";
import type { AppContext } from "../context.js";
import { buildMediaQuery, mediaCountSql } from "../query/media-query.js";
import { toMediaDto, type MediaRow } from "./mappers.js";
import { decorateMedia } from "./decorate-media.js";
import { TrashService } from "../cleanup/trash-service.js";

export async function registerCleanupRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const db = ctx.db;
  const trash = new TrashService(db, () => ctx.scanner.isRunning());
  const repairStackCovers = (mediaIds: number[]) => {
    if (mediaIds.length === 0) return;
    const placeholders = mediaIds.map(() => "?").join(",");
    const stacks = db.prepare(`SELECT s.id, s.cover_media_id AS coverId,
      (SELECT sm.media_id FROM stack_members sm WHERE sm.stack_id = s.id
        AND sm.media_id NOT IN (SELECT media_id FROM deletion_marks) ORDER BY sm.position LIMIT 1) AS replacementId
      FROM stacks s WHERE s.cover_media_id IN (SELECT media_id FROM deletion_marks)
      AND s.id IN (SELECT stack_id FROM stack_members WHERE media_id IN (${placeholders}))`).all(...mediaIds) as
      { id: number; coverId: number; replacementId: number | null }[];
    for (const stack of stacks) {
      if (stack.replacementId === null) continue;
      db.prepare("UPDATE deletion_marks SET original_cover_stack_id = ?, replacement_cover_media_id = ? WHERE media_id = ? AND original_cover_stack_id IS NULL")
        .run(stack.id, stack.replacementId, stack.coverId);
      db.prepare("UPDATE stacks SET cover_media_id = ?, user_modified = 1 WHERE id = ?").run(stack.replacementId, stack.id);
    }
  };

  app.post("/api/cleanup/marks", { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = markForDeletionRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid media IDs" });
    const ids = [...new Set(parsed.data.mediaIds)];
    const q = buildMediaQuery({ scope: { kind: "ids", ids }, includeMarked: true });
    const eligible = db.prepare(`${q.cte} SELECT media.id FROM media JOIN scan_roots sr ON sr.id = media.scan_root_id ${q.joins} WHERE ${q.where} AND media.status = 'active' AND sr.enabled = 1`)
      .all(...q.bindings) as { id: number }[];
    if (eligible.length !== ids.length) return reply.code(400).send({ error: "Selection contains an unavailable or companion item" });
    const insert = db.prepare("INSERT OR IGNORE INTO deletion_marks (media_id, reason) VALUES (?, 'user')");
    db.transaction(() => { for (const id of ids) insert.run(id); repairStackCovers(ids); })();
    return reply.send({ marked: ids.length });
  });

  app.delete("/api/cleanup/marks/:id", { preHandler: app.requireAuth }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isSafeInteger(id) || id < 1) return reply.code(400).send({ error: "Invalid media ID" });
    if (db.prepare("SELECT 1 FROM trash_entries WHERE media_id = ?").get(id)) return reply.code(409).send({ error: "Restore the file from trash first" });
    const result = db.transaction(() => {
      const prior = db.prepare("SELECT original_cover_stack_id AS stackId, replacement_cover_media_id AS replacementId FROM deletion_marks WHERE media_id = ?")
        .get(id) as { stackId: number | null; replacementId: number | null } | undefined;
      const deleted = db.prepare("DELETE FROM deletion_marks WHERE media_id = ?").run(id);
      if (deleted.changes) {
        if (prior?.stackId !== null && prior?.replacementId !== null && prior?.stackId !== undefined) {
          db.prepare(`UPDATE stacks SET cover_media_id = ? WHERE id = ? AND cover_media_id = ?
            AND EXISTS (SELECT 1 FROM stack_members WHERE stack_id = ? AND media_id = ?)`)
            .run(id, prior.stackId, prior.replacementId, prior.stackId, id);
        }
        repairStackCovers([id]);
      }
      return deleted;
    })();
    if (result.changes === 0) return reply.code(404).send({ error: "Mark not found" });
    return reply.send({ ok: true });
  });

  app.get("/api/cleanup/marks", { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = paginationQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid pagination" });
    const { offset, limit } = parsed.data;
    const q = buildMediaQuery({ includeMarked: true, includeCompanions: true });
    const join = `JOIN deletion_marks dm ON dm.media_id = media.id`;
    const total = (db.prepare(mediaCountSql({ ...q, joins: `${q.joins} ${join}` })).get(...q.bindings) as { c: number }).c;
    const rows = db.prepare(`${q.cte} SELECT media.*, dm.marked_at, dm.reason, te.status AS trash_status FROM media ${q.joins} ${join}
      LEFT JOIN trash_entries te ON te.media_id = media.id WHERE ${q.where} ORDER BY dm.marked_at DESC, media.id DESC LIMIT ? OFFSET ?`)
      .all(...q.bindings, limit, offset) as (MediaRow & { marked_at: string; reason: string; trash_status: "moving" | "trashed" | null })[];
    const decorated = decorateMedia(ctx, rows.map(toMediaDto));
    return reply.send({ items: rows.map((row, i) => ({ media: decorated[i], markedAt: row.marked_at, reason: row.reason, trashStatus: row.trash_status })), total, offset, limit });
  });

  app.post("/api/cleanup/trash", { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = markForDeletionRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid media IDs" });
    if (ctx.scanner.isRunning()) return reply.code(409).send({ error: "Wait for the current scan to finish" });
    const results: { mediaId: number; ok: boolean; error?: string }[] = [];
    for (const id of new Set(parsed.data.mediaIds)) {
      try { await trash.move(id); results.push({ mediaId: id, ok: true }); }
      catch (cause) { results.push({ mediaId: id, ok: false, error: cause instanceof Error ? cause.message : "Could not move file" }); }
    }
    return reply.send({ results });
  });

  app.post("/api/cleanup/trash/:id/restore", { preHandler: app.requireAuth }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isSafeInteger(id) || id < 1) return reply.code(400).send({ error: "Invalid media ID" });
    try { await trash.restore(id); return reply.send({ ok: true }); }
    catch (cause) { return reply.code(409).send({ error: cause instanceof Error ? cause.message : "Could not restore" }); }
  });

  app.delete("/api/cleanup/trash/:id", { preHandler: app.requireAuth }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isSafeInteger(id) || id < 1 || (request.body as { confirm?: unknown } | undefined)?.confirm !== true) {
      return reply.code(400).send({ error: "Explicit confirmation required" });
    }
    try { await trash.empty(id); return reply.send({ ok: true }); }
    catch (cause) { return reply.code(409).send({ error: cause instanceof Error ? cause.message : "Could not empty trash" }); }
  });
}
