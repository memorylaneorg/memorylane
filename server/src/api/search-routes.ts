import type { FastifyInstance } from "fastify";
import { searchQuerySchema, type SearchResultDto } from "@memorylane/shared";
import type { AppContext } from "../context.js";
import { toFolderDto, toMediaDto, type FolderRow, type MediaRow } from "./mappers.js";
import { buildMediaQuery, APPLE_PLUGIN_ENABLED_SQL } from "../query/media-query.js";
import { ProviderUnavailableError } from "../providers/types.js";
import { spaceFor } from "../vectors/vector-index.js";
import { AI_UNAVAILABLE, loadRanked } from "./similar-routes.js";
import { getFolderCounts, getRecursiveFolderStats } from "./folders-routes.js";
import { decorateMedia } from "./decorate-media.js";

// Builds a safe FTS5 MATCH expression from free-text user input: each
// whitespace-separated term becomes a quoted prefix match, ANDed together.
// Quoting neutralizes FTS5's special query syntax (AND/OR/NOT/NEAR/*, etc.)
// so user input can never be interpreted as FTS operators.
function buildFtsQuery(q: string): string {
  const terms = q.trim().split(/\s+/).filter(Boolean);
  return terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" AND ");
}

export async function registerSearchRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db } = ctx;

  app.get("/api/search", { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = searchQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid query" });
    const { q, offset, limit, mode } = parsed.data;

    // "Describe it" search: embed the words, rank photos by cosine similarity.
    if (mode === "semantic") {
      if (!ctx.provider) return reply.code(503).send({ error: AI_UNAVAILABLE });
      let vector: Float32Array;
      try {
        vector = (await ctx.provider.embedText([q])).vectors[0];
      } catch (err) {
        if (err instanceof ProviderUnavailableError) return reply.code(503).send({ error: err.message });
        throw err;
      }
      const hits = await ctx.vectorIndex.search(spaceFor("media", ctx.provider.expectedModel), vector, offset + limit + 20);
      const ranked = loadRanked(ctx, hits).slice(offset, offset + limit);
      const items: SearchResultDto[] = ranked.map(({ media, score }) => ({ type: "media" as const, media, score }));
      return reply.send({ items, total: items.length, offset, limit });
    }

    const ftsQuery = buildFtsQuery(q);
    if (!ftsQuery) return reply.send({ items: [], total: 0, offset, limit });

    const folderLimit = Math.min(20, limit);
    const folderRows = db
      .prepare(
        `SELECT folders.* FROM folders_fts
         JOIN folders ON folders.id = folders_fts.rowid
         JOIN scan_roots ON scan_roots.id = folders.scan_root_id
         WHERE folders_fts MATCH ? AND folders.status = 'active'
           AND (scan_roots.kind != 'apple-photos' OR ${APPLE_PLUGIN_ENABLED_SQL})
         ORDER BY rank LIMIT ?`,
      )
      .all(ftsQuery, folderLimit) as FolderRow[];

    const mediaLimit = Math.max(0, limit - folderRows.length);
    const listing = buildMediaQuery({});
    const mediaRows = mediaLimit
      ? (db
          .prepare(
            `SELECT media.* FROM media_fts
             JOIN media ON media.id = media_fts.rowid ${listing.joins}
             WHERE media_fts MATCH ? AND ${listing.where}
             ORDER BY rank LIMIT ? OFFSET ?`,
          )
          .all(ftsQuery, ...listing.bindings, mediaLimit, offset) as MediaRow[])
      : [];

    const items: SearchResultDto[] = [
      // Recursive stats too, not just direct counts - so a folder result here
      // reads the same "600 items, 2.8 GB" way it would on Home or when
      // browsing into it - see folders-routes.ts.
      ...folderRows.map((row) => {
        const recursive = getRecursiveFolderStats(ctx, row.id);
        return {
          type: "folder" as const,
          folder: toFolderDto(row, {
            ...getFolderCounts(ctx, row.id),
            recursiveMediaCount: recursive.count,
            recursiveSizeBytes: recursive.sizeBytes,
          }),
        };
      }),
      ...decorateMedia(ctx, mediaRows.map(toMediaDto)).map((media) => ({ type: "media" as const, media })),
    ];

    return reply.send({ items, total: items.length, offset, limit });
  });
}
