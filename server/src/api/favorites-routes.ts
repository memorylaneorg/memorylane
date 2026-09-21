import type { FastifyInstance } from "fastify";
import { favoritesQuerySchema } from "@memorylane/shared";
import type { AppContext } from "../context.js";
import { toMediaDto, type MediaRow } from "./mappers.js";
import { EngagementRepo } from "../db/engagement-repo.js";
import { decorateMedia } from "./decorate-media.js";

export async function registerFavoritesRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db } = ctx;
  const engagement = new EngagementRepo(db);

  app.get("/api/favorites", { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = favoritesQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid query" });
    const { offset, limit, type } = parsed.data;

    const { ids, total } = engagement.listFavoriteIds(offset, limit, type);
    if (ids.length === 0) return reply.send({ items: [], total, offset, limit });

    const placeholders = ids.map(() => "?").join(",");
    const rows = db.prepare(`SELECT * FROM media WHERE id IN (${placeholders})`).all(...ids) as MediaRow[];
    const byId = new Map(rows.map((r) => [r.id, r]));

    // Preserve favorited_at DESC ordering from listFavoriteIds - a plain
    // `WHERE id IN (...)` gives no ordering guarantee.
    const items = ids.map((id) => byId.get(id)).filter((r): r is MediaRow => !!r).map(toMediaDto);
    decorateMedia(ctx, items); // favorites all true by construction; stacks attached too

    return reply.send({ items, total, offset, limit });
  });
}
