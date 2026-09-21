import type { FastifyInstance } from "fastify";
import { similarQuerySchema, type SimilarResultDto, type MediaDto } from "@memorylane/shared";
import type { AppContext } from "../context.js";
import { toMediaDto, type MediaRow } from "./mappers.js";
import { decorateMedia } from "./decorate-media.js";
import { buildMediaQuery, mediaSelectSql } from "../query/media-query.js";
import { spaceFor } from "../vectors/vector-index.js";
import { isMediaSourceVisible } from "../plugins/registry.js";

export const AI_UNAVAILABLE = "AI features are not available - the memorylane-ai sidecar isn't configured or running";

// Loads media rows for a ranked id list, keeping the ranking. Companions are
// hidden by the builder; stacks are not collapsed (a burst sibling is a
// legitimate "similar" answer).
export function loadRanked(ctx: AppContext, hits: { id: number; score: number }[]): { media: MediaDto; score: number }[] {
  if (hits.length === 0) return [];
  const q = buildMediaQuery({ scope: { kind: "ids", ids: hits.map((h) => h.id) } });
  const rows = ctx.db.prepare(mediaSelectSql(q, "media.id")).all(...q.bindings, hits.length, 0) as MediaRow[];
  const byId = new Map(decorateMedia(ctx, rows.map(toMediaDto)).map((m) => [m.id, m]));
  return hits.flatMap((h) => {
    const media = byId.get(h.id);
    return media ? [{ media, score: Math.max(0, Math.min(1, h.score)) }] : [];
  });
}

export async function registerSimilarRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/api/media/:id/similar", { preHandler: app.requireAuth }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = similarQuerySchema.safeParse(request.query);
    if (!parsed.success || Number.isNaN(id)) return reply.code(400).send({ error: "Invalid query" });
    const row = ctx.db.prepare("SELECT * FROM media WHERE id = ?").get(id) as MediaRow | undefined;
    if (!row || !isMediaSourceVisible(ctx.db, id)) return reply.code(404).send({ error: "Media not found" });
    if (!ctx.provider) return reply.code(503).send({ error: AI_UNAVAILABLE });

    const model = ctx.provider.expectedModel;
    const vector = ctx.embeddings.get(id, model);
    if (!vector) return reply.code(409).send({ error: "This photo hasn't been analysed yet - the AI queue is still working through your library" });

    // Over-fetch so hidden companions/missing rows don't leave the page short.
    const hits = await ctx.vectorIndex.search(spaceFor("media", model), vector, parsed.data.limit + 20, { excludeIds: [id] });
    const items = loadRanked(ctx, hits).slice(0, parsed.data.limit);
    const [source] = decorateMedia(ctx, [toMediaDto(row)]);
    const dto: SimilarResultDto = { source, items };
    return reply.send(dto);
  });
}
