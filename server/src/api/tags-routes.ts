import type { FastifyInstance } from "fastify";
import { paginationQuerySchema } from "@memorylane/shared";
import type { AppContext } from "../context.js";
import { TagRepo } from "../tags/tag-repo.js";
import { decorateMedia } from "./decorate-media.js";
import { toMediaDto } from "./mappers.js";
import { buildMediaQuery } from "../query/media-query.js";
import { SettingsRepo } from "../db/settings-repo.js";
import { z } from "zod";

const tagFacetsQuerySchema = paginationQuerySchema.extend({ q: z.string().max(100).default("") });

export async function registerTagRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const tags = new TagRepo(ctx.db);
  const visibleMedia = (id: number): boolean => {
    const q = buildMediaQuery({ scope: { kind: "ids", ids: [id] } });
    return !!ctx.db.prepare(`${q.cte} SELECT media.id FROM media ${q.joins} WHERE ${q.where}`).get(...q.bindings);
  };

  app.get("/api/tags", { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = tagFacetsQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid tag search" });
    return reply.send(tags.facets(parsed.data.q, parsed.data.offset, parsed.data.limit));
  });

  app.get("/api/tags/:id/media", { preHandler: app.requireAuth }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = paginationQuerySchema.safeParse(request.query);
    if (!Number.isSafeInteger(id) || id < 1 || !parsed.success) return reply.code(400).send({ error: "Invalid request" });
    const result = tags.mediaForTag(id, parsed.data.offset, parsed.data.limit);
    return reply.send({ ...result, items: decorateMedia(ctx, result.items.map(toMediaDto)) });
  });

  app.get("/api/media/:id/tags", { preHandler: app.requireAuth }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isSafeInteger(id) || !visibleMedia(id)) return reply.code(404).send({ error: "Media not found" });
    return reply.send(tags.listForMedia(id));
  });

  app.post("/api/media/:id/tags", { preHandler: app.requireAuth }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const name = (request.body as { name?: unknown } | undefined)?.name;
    if (!Number.isSafeInteger(id) || !visibleMedia(id)) return reply.code(404).send({ error: "Media not found" });
    if (typeof name !== "string") return reply.code(400).send({ error: "Invalid tag" });
    try { return reply.send(tags.addUser(id, name)); }
    catch { return reply.code(400).send({ error: "Invalid tag" }); }
  });

  app.delete("/api/media/:id/tags/:tagId", { preHandler: app.requireAuth }, async (request, reply) => {
    const { id: rawId, tagId: rawTagId } = request.params as { id: string; tagId: string };
    const id = Number(rawId), tagId = Number(rawTagId);
    const source = (request.query as { source?: string }).source;
    if (!Number.isSafeInteger(id) || !visibleMedia(id)) return reply.code(404).send({ error: "Media not found" });
    if (!Number.isSafeInteger(tagId) || tagId < 1 || (source !== "user" && source !== "ai")) return reply.code(400).send({ error: "Invalid tag" });
    if (!tags.remove(id, tagId, source)) return reply.code(404).send({ error: "Tag not found" });
    return reply.send({ ok: true });
  });

  app.post("/api/tags/generate", { preHandler: app.requireAuth }, async (_request, reply) => {
    if (!ctx.provider) return reply.code(503).send({ error: "AI provider is not configured" });
    if (!new SettingsRepo(ctx.db).getAll().aiEnabled) return reply.code(409).send({ error: "Turn on AI analysis in Settings before generating tags" });
    ctx.analysisWorker.kick();
    return reply.code(202).send({ scheduled: true });
  });
}
