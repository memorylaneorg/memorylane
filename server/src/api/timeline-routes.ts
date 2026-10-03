import type { FastifyInstance } from "fastify";
import type { TimelineMonthDto, TimelineSummaryDto } from "@memorylane/shared";
import type { AppContext } from "../context.js";
import { buildMediaQuery } from "../query/media-query.js";
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

export async function registerTimelineRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/api/timeline", { preHandler: app.requireAuth }, async (_request, reply) => {
    const listing = buildMediaQuery({ requireExifJoin: true });
    const counts = ctx.db.prepare(`${listing.cte}
      SELECT substr(mx.captured_at_precise, 1, 4) AS year,
             substr(mx.captured_at_precise, 6, 2) AS month,
             COUNT(*) AS mediaCount
      FROM media ${listing.joins}
      WHERE ${listing.where} AND ${VALID_EXIF_DATE_SQL}
      GROUP BY year, month
      ORDER BY year DESC, month DESC`)
      .all(...listing.bindings) as TimelineCountRow[];

    const samplesListing = buildMediaQuery({ requireExifJoin: true, thumbnailDone: true });
    const sampleRows = ctx.db.prepare(`WITH qualified AS (
        SELECT media.*,
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
        SELECT qualified.*,
               ROW_NUMBER() OVER (
                 PARTITION BY timeline_year, timeline_month, sample_bucket
                 ORDER BY timeline_captured, id
               ) AS sample_rank
        FROM qualified
      )
      SELECT * FROM sampled WHERE sample_rank = 1
      ORDER BY timeline_year DESC, timeline_month DESC, sample_bucket`)
      .all(...samplesListing.bindings) as TimelineSampleRow[];

    const decorated = decorateMedia(ctx, sampleRows.map(toMediaDto));
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
