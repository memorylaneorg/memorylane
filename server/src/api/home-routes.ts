import type { FastifyInstance } from "fastify";
import type { HomeSummaryDto } from "@memorylane/shared";
import type { AppContext } from "../context.js";
import { toMediaDto, type MediaRow } from "./mappers.js";
import { buildMediaQuery, ACTIVE_SOURCE_SQL, UNMARKED_MEDIA_SQL } from "../query/media-query.js";
import { decorateMedia } from "./decorate-media.js";
import { browseCache } from "./browse-cache.js";
import { probeRandomMediaIds } from "../query/random-pick.js";
import { SettingsRepo } from "../db/settings-repo.js";

// Backs the Home page's hero card: library-wide totals plus a randomly
// picked photo to use as the hero background (re-rolled on every page load).
export async function registerHomeRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db } = ctx;

  const cache = browseCache(db);

  app.get("/api/home/summary", { preHandler: app.requireAuth }, async (_request, reply) => {
    // Whole-library totals are cached until the library changes; favorites and
    // collections are cheap and stay live.
    const { mediaCount, folderCount, totalSizeBytes, yearSpan } = cache.getOrCompute("home:totals", cache.fingerprint(), () => {
      const mediaCount = (
        db.prepare(`SELECT COUNT(*) as c FROM media WHERE status = 'active' AND ${ACTIVE_SOURCE_SQL} AND ${UNMARKED_MEDIA_SQL}`).get() as { c: number }
      ).c;
      const folderCount = (
        db.prepare("SELECT COUNT(*) as c FROM folders WHERE status = 'active'").get() as { c: number }
      ).c;
      const totalSizeBytes = (
        db.prepare(`SELECT COALESCE(SUM(file_size), 0) as s FROM media WHERE status = 'active' AND ${ACTIVE_SOURCE_SQL} AND ${UNMARKED_MEDIA_SQL}`).get() as {
          s: number;
        }
      ).s;
      const yearRow = db
        .prepare(
          `SELECT MIN(CAST(strftime('%Y', captured_date) AS INTEGER)) as minYear,
                  MAX(CAST(strftime('%Y', captured_date) AS INTEGER)) as maxYear
           FROM media WHERE status = 'active' AND ${ACTIVE_SOURCE_SQL} AND ${UNMARKED_MEDIA_SQL} AND captured_date IS NOT NULL`,
        )
        .get() as { minYear: number | null; maxYear: number | null };
      const yearSpan =
        yearRow.minYear !== null && yearRow.maxYear !== null ? yearRow.maxYear - yearRow.minYear + 1 : 0;
      return { mediaCount, folderCount, totalSizeBytes, yearSpan };
    });
    const favoriteCount = (
      db.prepare(`SELECT COUNT(*) as c FROM media JOIN media_engagement e ON e.media_id=media.id WHERE e.favorite=1 AND media.status='active' AND ${ACTIVE_SOURCE_SQL} AND ${UNMARKED_MEDIA_SQL}`).get() as { c: number }
    ).c;
    const collectionCount = (db.prepare("SELECT COUNT(*) as c FROM collections").get() as { c: number }).c;

    const hero = buildMediaQuery({ type: "photo", thumbnailDone: true, collapseStacks: true });
    // Still a fresh random photo on every load, just without sorting the whole library.
    const heroId = probeRandomMediaIds(db, { count: 1, where: hero.where, bindings: hero.bindings })?.[0];
    const heroRow = (heroId !== undefined
      ? db.prepare("SELECT * FROM media WHERE id = ?").get(heroId)
      : db.prepare(`SELECT media.* FROM media WHERE ${hero.where} ORDER BY RANDOM() LIMIT 1`).get(...hero.bindings)) as MediaRow | undefined;

    const heroMedia = heroRow ? decorateMedia(ctx, [toMediaDto(heroRow)])[0] : null;

    const summary: HomeSummaryDto = {
      archiveTitle: new SettingsRepo(db).getAll().archiveTitle,
      mediaCount,
      folderCount,
      favoriteCount,
      collectionCount,
      totalSizeBytes,
      yearSpan,
      heroMedia,
    };
    return reply.send(summary);
  });
}
