import type { FastifyInstance } from "fastify";
import type { TimelineMonthDto, TimelineSummaryDto } from "@memorylane/shared";
import type { AppContext } from "../context.js";
import { buildMediaQuery } from "../query/media-query.js";
import { browseCache } from "./browse-cache.js";
import { decorateMedia } from "./decorate-media.js";
import { toMediaDto, type MediaRow } from "./mappers.js";

const VALID_EXIF_DATE_SQL =
  "datetime(mx.captured_at_precise) >= datetime('1990-01-01') AND datetime(mx.captured_at_precise) <= datetime('now')";

interface TimelineCountRow {
  year: string;
  month: string;
  mediaCount: number;
}

interface TimelineSampleRow extends MediaRow {
  timeline_year: string;
  timeline_month: string;
  sample_rank: number;
}

function loadCounts(ctx: AppContext): TimelineCountRow[] {
  const listing = buildMediaQuery({ requireExifJoin: true });
  return ctx.db.prepare(`${listing.cte}
      SELECT substr(mx.captured_at_precise, 1, 4) AS year,
             substr(mx.captured_at_precise, 6, 2) AS month,
             COUNT(*) AS mediaCount
      FROM media ${listing.joins}
      WHERE ${listing.where} AND ${VALID_EXIF_DATE_SQL}
      GROUP BY year, month
      ORDER BY year DESC, month DESC`)
    .all(...listing.bindings) as TimelineCountRow[];
}

// Five photos per month, one from each fifth of the month (the first by
// default, a random one after a manual refresh).
function querySampleRows(ctx: AppContext, random: boolean): TimelineSampleRow[] {
  const samplesListing = buildMediaQuery({ requireExifJoin: true, thumbnailDone: true });
  // Windows carry only ids and dates; full rows are joined back for the winners.
  return ctx.db.prepare(`WITH qualified AS (
      SELECT media.id AS id,
             substr(mx.captured_at_precise, 1, 4) AS timeline_year,
             substr(mx.captured_at_precise, 6, 2) AS timeline_month,
             mx.captured_at_precise AS timeline_captured,
             NTILE(5) OVER (
               PARTITION BY substr(mx.captured_at_precise, 1, 7)
               ORDER BY mx.captured_at_precise, media.id
             ) AS sample_bucket
      FROM media ${samplesListing.joins}
      WHERE ${samplesListing.where} AND ${VALID_EXIF_DATE_SQL}
    ), sampled AS (
      SELECT id, timeline_year, timeline_month, sample_bucket,
             ROW_NUMBER() OVER (
               PARTITION BY timeline_year, timeline_month, sample_bucket
               ORDER BY ${random ? "random()" : "timeline_captured, id"}
             ) AS sample_rank
      FROM qualified
    )
    SELECT media.*, sampled.timeline_year AS timeline_year, sampled.timeline_month AS timeline_month, sampled.sample_rank AS sample_rank
    FROM sampled JOIN media ON media.id = sampled.id
    WHERE sampled.sample_rank = 1
    ORDER BY sampled.timeline_year DESC, sampled.timeline_month DESC, sampled.sample_bucket`)
    .all(...samplesListing.bindings) as TimelineSampleRow[];
}

export async function registerTimelineRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const cache = browseCache(ctx.db);

  app.get("/api/timeline", { preHandler: app.requireAuth }, async (request, reply) => {
    const refresh = (request.query as { refresh?: string }).refresh === "1";
    if (refresh) cache.clearPrefix("timeline:");
    const t0 = performance.now();
    const fingerprint = cache.fingerprint();
    const counts = cache.getOrCompute("timeline:counts", fingerprint, () => loadCounts(ctx));
    const t1 = performance.now();
    const sampleRows = cache.getOrCompute("timeline:samples", fingerprint, () => querySampleRows(ctx, refresh));
    // Favorites and stacks are applied per request so they stay live over cached rows.
    const decorated = decorateMedia(ctx, sampleRows.map(toMediaDto));
    request.log.info({ refresh, countsMs: Math.round(t1 - t0), samplesMs: Math.round(performance.now() - t1) }, "timeline timing");
    const samplesByMonth = new Map<string, typeof decorated>();
    sampleRows.forEach((row, index) => {
      const key = `${row.timeline_year}-${row.timeline_month}`;
      const samples = samplesByMonth.get(key) ?? [];
      samples.push(decorated[index]);
      samplesByMonth.set(key, samples);
    });

    const years = new Map<number, { year: number; mediaCount: number; months: TimelineMonthDto[] }>();
    for (const row of counts) {
      const year = Number(row.year);
      const month = Number(row.month);
      const entry = years.get(year) ?? { year, mediaCount: 0, months: [] };
      entry.mediaCount += row.mediaCount;
      entry.months.push({ year, month, mediaCount: row.mediaCount, samples: samplesByMonth.get(`${row.year}-${row.month}`) ?? [] });
      years.set(year, entry);
    }

    const result: TimelineSummaryDto = { years: [...years.values()] };
    return reply.send(result);
  });
}
