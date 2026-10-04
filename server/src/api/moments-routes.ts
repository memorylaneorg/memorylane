import type { FastifyInstance } from "fastify";
import type { MediaDto, MomentDetailDto, MomentDto, MomentsSummaryDto } from "@memorylane/shared";
import type { AppContext } from "../context.js";
import { detectMoments, momentDetectionLevel, type ActiveDay, type DetectedMoment } from "../moments/detect.js";
import { buildMediaQuery } from "../query/media-query.js";
import { browseCache } from "./browse-cache.js";
import { decorateMedia } from "./decorate-media.js";
import { toMediaDto, type MediaRow } from "./mappers.js";

const VALID_EXIF_DATE_SQL =
  "datetime(mx.captured_at_precise) >= datetime('1990-01-01') AND datetime(mx.captured_at_precise) <= datetime('now')";

interface DaySampleRow extends MediaRow { moment_date: string; }

function loadActiveDays(ctx: AppContext): ActiveDay[] {
  const listing = buildMediaQuery({ requireExifJoin: true });
  return ctx.db.prepare(`${listing.cte}
    SELECT date(mx.captured_at_precise) AS date, COUNT(*) AS mediaCount
    FROM media ${listing.joins}
    WHERE ${listing.where} AND ${VALID_EXIF_DATE_SQL}
    GROUP BY date ORDER BY date`)
    .all(...listing.bindings) as ActiveDay[];
}

// Five photos per active day, one from each fifth of the day (the first by
// default, a random one after a manual refresh). The window functions only
// carry ids and dates; full media rows are joined back for the five winners,
// so sorting never drags every column of every photo through a temp b-tree.
// `range` limits the work to one moment's dates (the list page passes none).
function querySampleRows(ctx: AppContext, opts: { range?: { start: string; end: string }; random?: boolean } = {}): DaySampleRow[] {
  const sampleListing = buildMediaQuery({ requireExifJoin: true, thumbnailDone: true });
  const { range, random = false } = opts;
  const rangeSql = range ? "AND mx.captured_at_precise >= ? AND mx.captured_at_precise < date(?, '+1 day')" : "";
  const rangeBindings = range ? [range.start, range.end] : [];
  return ctx.db.prepare(`WITH qualified AS (
      SELECT media.id AS id, date(mx.captured_at_precise) AS moment_date,
             mx.captured_at_precise AS moment_captured,
             NTILE(5) OVER (PARTITION BY date(mx.captured_at_precise) ORDER BY mx.captured_at_precise, media.id) AS sample_bucket
      FROM media ${sampleListing.joins}
      WHERE ${sampleListing.where} AND ${VALID_EXIF_DATE_SQL} ${rangeSql}
    ), sampled AS (
      SELECT id, moment_date, sample_bucket,
             ROW_NUMBER() OVER (PARTITION BY moment_date, sample_bucket ORDER BY ${random ? "random()" : "moment_captured, id"}) AS bucket_rank
      FROM qualified
    )
    SELECT media.*, sampled.moment_date AS moment_date
    FROM sampled JOIN media ON media.id = sampled.id
    WHERE sampled.bucket_rank = 1 ORDER BY sampled.moment_date, sampled.sample_bucket`)
    .all(...sampleListing.bindings, ...rangeBindings) as DaySampleRow[];
}

// Favorites and stack membership are applied here, per request, so they stay
// live even when the rows themselves come from the cache.
function groupSamples(ctx: AppContext, rows: DaySampleRow[]): Map<string, MediaDto[]> {
  const media = decorateMedia(ctx, rows.map(toMediaDto));
  const samples = new Map<string, MediaDto[]>();
  rows.forEach((row, index) => {
    const day = samples.get(row.moment_date);
    if (day) day.push(media[index]); else samples.set(row.moment_date, [media[index]]);
  });
  return samples;
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
  const cache = browseCache(ctx.db);

  app.get("/api/moments", { preHandler: app.requireAuth }, async (request, reply) => {
    const query = request.query as { detection?: string; refresh?: string };
    const detection = momentDetectionLevel(query.detection);
    const refresh = query.refresh === "1";
    if (refresh) cache.clearPrefix("moments:");
    const t0 = performance.now();
    const fingerprint = cache.fingerprint();
    const activeDays = cache.getOrCompute("moments:days", fingerprint, () => loadActiveDays(ctx));
    const t1 = performance.now();
    const rows = cache.getOrCompute("moments:samples", fingerprint, () => querySampleRows(ctx, { random: refresh }));
    const samples = groupSamples(ctx, rows);
    const t2 = performance.now();
    const moments = detectMoments(activeDays, detection).map((moment) => toDto(moment, samples));
    request.log.info({ refresh, activeDays: activeDays.length, daysMs: Math.round(t1 - t0), samplesMs: Math.round(t2 - t1), detectMs: Math.round(performance.now() - t2) }, "moments list timing");
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
    const t0 = performance.now();
    const fingerprint = cache.fingerprint();
    const activeDays = cache.getOrCompute("moments:days", fingerprint, () => loadActiveDays(ctx));
    const t1 = performance.now();
    const moment = detectMoments(activeDays, detection).find((candidate) => candidate.startDate === start && candidate.endDate === end);
    if (!moment) return reply.code(404).send({ error: "Moment not found" });
    // Reuse the list page's cached picks so both pages show the same photos;
    // when nothing is cached yet, query just this moment's dates.
    const cachedRows = cache.peek<DaySampleRow[]>("moments:samples", fingerprint);
    const rows = cachedRows ? cachedRows.filter((row) => row.moment_date >= start && row.moment_date <= end) : querySampleRows(ctx, { range: { start, end } });
    const samples = groupSamples(ctx, rows);
    const dto = toDto(moment, samples);
    const result: MomentDetailDto = {
      ...dto,
      detection,
      days: moment.activeDays.map((day) => ({ ...day, samples: samples.get(day.date) ?? [] })),
    };
    request.log.info({ activeDays: activeDays.length, cachedSamples: !!cachedRows, daysMs: Math.round(t1 - t0), samplesMs: Math.round(performance.now() - t1) }, "moment detail timing");
    return reply.send(result);
  });
}
