import type { FastifyInstance } from "fastify";
import {
  startTranscodeRequestSchema,
  archiveTranscodedRequestSchema,
  transcodeCandidatesQuerySchema,
  type TranscodeCandidateDto,
  type TranscodeCandidatesResultDto,
} from "@memorylane/shared";
import type { AppContext } from "../context.js";
import { toMediaDto, toTranscodeJobDto, type MediaRow, type TranscodeJobRow } from "./mappers.js";
import { streamFile } from "./file-streaming.js";
import { transcodingPathForMediaId, transcodingThumbnailPathForMediaId } from "../config/paths.js";
import { NEEDS_TRANSCODE_SQL_CLAUSE } from "../media/video-compatibility.js";
import { isMediaSourceVisible } from "../plugins/registry.js";
import { UNMARKED_MEDIA_SQL } from "../query/media-query.js";

const WRITABLE_SOURCE_SQL = "(media.source_kind IS NULL OR media.source_kind != 'apple-photos')";

// Every video in this root still needing a transcode attempt - used both by
// the (paginated) candidates list and by "Transcode All", which targets this
// full set server-side rather than whatever page happens to be loaded.
// Excludes anything already pending/transcoding/done so "Transcode All"
// after a partial batch only picks up what's actually still untouched.
function needsTranscodeIdsSql(): string {
  return `
    SELECT media.id FROM media
    WHERE scan_root_id = ? AND media_type = 'video' AND status = 'active' AND ${WRITABLE_SOURCE_SQL} AND ${UNMARKED_MEDIA_SQL} AND ${NEEDS_TRANSCODE_SQL_CLAUSE}
      AND id NOT IN (SELECT media_id FROM video_transcode_jobs WHERE status IN ('pending', 'transcoding', 'done'))
  `;
}

function verifiedIdsSql(): string {
  return `
    SELECT vtj.media_id as id FROM video_transcode_jobs vtj
    JOIN media ON media.id = vtj.media_id
    WHERE media.scan_root_id = ? AND ${WRITABLE_SOURCE_SQL} AND ${UNMARKED_MEDIA_SQL} AND vtj.status = 'done' AND vtj.verified = 1
  `;
}

export async function registerVideoTranscodeRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db, paths, transcodeWorker } = ctx;

  app.get("/api/scan-roots/:id/transcode-candidates", { preHandler: app.requireAuth }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = transcodeCandidatesQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid query" });
    const { offset, limit } = parsed.data;

    const total = (
      db
        .prepare(
          `SELECT COUNT(*) as c FROM media WHERE scan_root_id = ? AND media_type = 'video' AND status = 'active' AND ${WRITABLE_SOURCE_SQL} AND ${UNMARKED_MEDIA_SQL} AND ${NEEDS_TRANSCODE_SQL_CLAUSE}`,
        )
        .get(id) as { c: number }
    ).c;

    const verifiedTotal = (
      db.prepare(`SELECT COUNT(*) as c FROM (${verifiedIdsSql()})`).get(id) as { c: number }
    ).c;

    const rows = db
      .prepare(
        `SELECT * FROM media WHERE scan_root_id = ? AND media_type = 'video' AND status = 'active' AND ${WRITABLE_SOURCE_SQL} AND ${UNMARKED_MEDIA_SQL} AND ${NEEDS_TRANSCODE_SQL_CLAUSE}
         ORDER BY captured_date IS NULL, captured_date, filename LIMIT ? OFFSET ?`,
      )
      .all(id, limit, offset) as MediaRow[];

    const jobRows = rows.length
      ? (db
          .prepare(
            `SELECT * FROM video_transcode_jobs WHERE media_id IN (${rows.map(() => "?").join(",")})`,
          )
          .all(...rows.map((r) => r.id)) as TranscodeJobRow[])
      : [];
    const jobsByMediaId = new Map(jobRows.map((j) => [j.media_id, j]));

    const items: TranscodeCandidateDto[] = rows.map((row) => ({
      media: toMediaDto(row),
      job: jobsByMediaId.has(row.id) ? toTranscodeJobDto(jobsByMediaId.get(row.id)!) : null,
    }));
    const result: TranscodeCandidatesResultDto = { items, total, offset, limit, verifiedTotal };
    return reply.send(result);
  });

  app.post("/api/scan-roots/:id/transcode/start", { preHandler: app.requireAuth }, async (request, reply) => {
    const scanRootId = Number((request.params as { id: string }).id);
    const parsed = startTranscodeRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });

    const mediaIds = parsed.data.all
      ? ((db.prepare(needsTranscodeIdsSql()).all(scanRootId) as { id: number }[]).map((r) => r.id))
      : parsed.data.mediaIds!.filter((id) => !!db.prepare(`SELECT media.id FROM media WHERE id = ? AND ${WRITABLE_SOURCE_SQL} AND ${UNMARKED_MEDIA_SQL}`).get(id));
    transcodeWorker.startTranscode(mediaIds, parsed.data.quality);
    return reply.send({ ok: true, count: mediaIds.length });
  });

  app.get("/api/scan-roots/:id/transcode/status", { preHandler: app.requireAuth }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const rows = db
      .prepare(
        `SELECT vtj.* FROM video_transcode_jobs vtj JOIN media ON media.id = vtj.media_id WHERE media.scan_root_id = ? AND ${WRITABLE_SOURCE_SQL} AND ${UNMARKED_MEDIA_SQL}`,
      )
      .all(id) as TranscodeJobRow[];
    return reply.send(rows.map(toTranscodeJobDto));
  });

  app.post("/api/scan-roots/:id/transcode/archive", { preHandler: app.requireAuth }, async (request, reply) => {
    const scanRootId = Number((request.params as { id: string }).id);
    const parsed = archiveTranscodedRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });

    const mediaIds = parsed.data.all
      ? ((db.prepare(verifiedIdsSql()).all(scanRootId) as { id: number }[]).map((r) => r.id))
      : parsed.data.mediaIds!.filter((id) => !!db.prepare(`SELECT media.id FROM media WHERE id = ? AND ${WRITABLE_SOURCE_SQL} AND ${UNMARKED_MEDIA_SQL}`).get(id));
    const result = await transcodeWorker.archive(mediaIds);
    return reply.send(result);
  });

  // Preview a transcode's local-cache output before deciding to archive it -
  // separate from the normal /api/media/:id/file (which serves the indexed
  // original) since the new file isn't indexed media until Archive runs.
  app.get("/api/media/:id/transcode-preview", { preHandler: app.requireAuth }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!isMediaSourceVisible(db, id)) return reply.code(404).send({ error: "No transcoded preview available" });
    const job = db.prepare(`SELECT * FROM video_transcode_jobs WHERE media_id = ? AND status = 'done'`).get(id) as
      | TranscodeJobRow
      | undefined;
    if (!job) return reply.code(404).send({ error: "No transcoded preview available" });
    return streamFile(request, reply, transcodingPathForMediaId(paths.transcodingDir, id), "video/mp4");
  });

  // Static poster frame for a done job - lets the candidates list show a
  // lightweight thumbnail per row instead of mounting a real <video> element
  // for every single one, which doesn't scale past a handful at once.
  app.get("/api/media/:id/transcode-preview-thumbnail", { preHandler: app.requireAuth }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!isMediaSourceVisible(db, id)) return reply.code(404).send({ error: "No preview thumbnail available" });
    const job = db.prepare(`SELECT * FROM video_transcode_jobs WHERE media_id = ? AND status = 'done'`).get(id) as
      | TranscodeJobRow
      | undefined;
    if (!job) return reply.code(404).send({ error: "No preview thumbnail available" });
    return streamFile(request, reply, transcodingThumbnailPathForMediaId(paths.transcodingDir, id), "image/jpeg");
  });
}
