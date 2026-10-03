import type { FastifyInstance } from "fastify";
import type { MediaDto, MomentDetailDto, MomentDto, MomentsSummaryDto } from "@memorylane/shared";
import type { AppContext } from "../context.js";
import { detectMoments, momentDetectionLevel, type ActiveDay, type DetectedMoment } from "../moments/detect.js";
import { buildMediaQuery } from "../query/media-query.js";
import { decorateMedia } from "./decorate-media.js";
import { toMediaDto, type MediaRow } from "./mappers.js";

const VALID_EXIF_DATE_SQL =
  "datetime(mx.captured_at_precise) >= datetime('1990-01-01') AND datetime(mx.captured_at_precise) <= datetime('now')";

interface DaySampleRow extends MediaRow { moment_date: string; }

function loadMomentData(ctx: AppContext): { days: ActiveDay[]; samples: Map<string, MediaDto[]> } {
  const listing = buildMediaQuery({ requireExifJoin: true });
  const days = ctx.db.prepare(`${listing.cte}
    SELECT date(mx.captured_at_precise) AS date, COUNT(*) AS mediaCount
    FROM media ${listing.joins}
    WHERE ${listing.where} AND ${VALID_EXIF_DATE_SQL}
    GROUP BY date ORDER BY date`)
    .all(...listing.bindings) as ActiveDay[];

  const sampleListing = buildMediaQuery({ requireExifJoin: true, thumbnailDone: true });
  const rows = ctx.db.prepare(`WITH qualified AS (
      SELECT media.*, date(mx.captured_at_precise) AS moment_date,
             mx.captured_at_precise AS moment_captured,
             NTILE(5) OVER (PARTITION BY date(mx.captured_at_precise) ORDER BY mx.captured_at_precise, media.id) AS sample_bucket
      FROM media ${sampleListing.joins}
      WHERE ${sampleListing.where} AND ${VALID_EXIF_DATE_SQL}
    ), sampled AS (
      SELECT qualified.*,
             ROW_NUMBER() OVER (PARTITION BY moment_date, sample_bucket ORDER BY moment_captured, id) AS bucket_rank
      FROM qualified
    )
    SELECT * FROM sampled WHERE bucket_rank = 1 ORDER BY moment_date, sample_bucket`)
    .all(...sampleListing.bindings) as DaySampleRow[];
  const media = decorateMedia(ctx, rows.map(toMediaDto));
  const samples = new Map<string, MediaDto[]>();
  rows.forEach((row, index) => samples.set(row.moment_date, [...(samples.get(row.moment_date) ?? []), media[index]]));
  return { days, samples };
}

function evenlySpaced(items: MediaDto[], limit = 5): MediaDto[] {
  if (items.length <= limit) return items;
  return Array.from({ length: limit }, (_, index) => items[Math.round(index * (items.length - 1) / (limit - 1))]);
}

function toDto(moment: DetectedMoment, samples: Map<string, MediaDto[]>): MomentDto {
  const candidates = moment.activeDays.flatMap((day) => samples.get(day.date) ?? []);
  return { ...moment, samples: evenlySpaced(candidates) };
}

export async function registerMomentsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/api/moments", { preHandler: app.requireAuth }, async (request, reply) => {
    const detection = momentDetectionLevel((request.query as { detection?: string }).detection);
    const data = loadMomentData(ctx);
    const moments = detectMoments(data.days, detection).map((moment) => toDto(moment, data.samples));
    const years = new Map<number, MomentsSummaryDto["years"][number]>();
    for (const moment of moments) {
      const year = Number(moment.endDate.slice(0, 4));
      const entry = years.get(year) ?? { year, mediaCount: 0, eventCount: 0, multiDayCount: 0, moments: [] };
      entry.mediaCount += moment.mediaCount;
      if (moment.kind === "event") entry.eventCount += 1; else entry.multiDayCount += 1;
      entry.moments.push(moment);
      years.set(year, entry);
    }
    const result: MomentsSummaryDto = { detection, years: [...years.values()] };
    return reply.send(result);
  });

  app.get("/api/moments/:start/:end", { preHandler: app.requireAuth }, async (request, reply) => {
    const { start, end } = request.params as { start: string; end: string };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return reply.code(400).send({ error: "Invalid moment dates" });
    const detection = momentDetectionLevel((request.query as { detection?: string }).detection);
    const data = loadMomentData(ctx);
    const moment = detectMoments(data.days, detection).find((candidate) => candidate.startDate === start && candidate.endDate === end);
    if (!moment) return reply.code(404).send({ error: "Moment not found" });
    const dto = toDto(moment, data.samples);
    const result: MomentDetailDto = {
      ...dto,
      detection,
      days: moment.activeDays.map((day) => ({ ...day, samples: data.samples.get(day.date) ?? [] })),
    };
    return reply.send(result);
  });
}
