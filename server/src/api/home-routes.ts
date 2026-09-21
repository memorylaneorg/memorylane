import type { FastifyInstance } from "fastify";
import type { HomeSummaryDto } from "@memorylane/shared";
import type { AppContext } from "../context.js";
import { toMediaDto, type MediaRow } from "./mappers.js";
import { buildMediaQuery, ACTIVE_SOURCE_SQL, UNMARKED_MEDIA_SQL } from "../query/media-query.js";
import { decorateMedia } from "./decorate-media.js";
import { SettingsRepo } from "../db/settings-repo.js";

// Backs the Home page's hero card: library-wide totals plus a randomly
// picked photo to use as the hero background (re-rolled on every page load).
export async function registerHomeRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db } = ctx;

  app.get("/api/home/summary", { preHandler: app.requireAuth }, async (_request, reply) => {
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

    const hero = buildMediaQuery({ type: "photo", thumbnailDone: true, collapseStacks: true });
    const heroRow = db
      .prepare(`SELECT media.* FROM media WHERE ${hero.where} ORDER BY RANDOM() LIMIT 1`)
      .get(...hero.bindings) as MediaRow | undefined;

    const heroMedia = heroRow ? decorateMedia(ctx, [toMediaDto(heroRow)])[0] : null;

    const summary: HomeSummaryDto = {
      archiveTitle: new SettingsRepo(db).getAll().archiveTitle,
      mediaCount,
      folderCount,
      totalSizeBytes,
      yearSpan,
      heroMedia,
    };
    return reply.send(summary);
  });
}
