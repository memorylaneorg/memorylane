import type Database from "better-sqlite3";
import type { MediaRow } from "../api/mappers.js";
import { buildMediaQuery } from "../query/media-query.js";
import type { ActiveDay } from "./detect.js";

const VALID_EXIF_DATE_SQL =
  "datetime(mx.captured_at_precise) >= datetime('1990-01-01') AND datetime(mx.captured_at_precise) <= datetime('now')";

export interface DaySampleRow extends MediaRow { moment_date: string; }

export function loadActiveDays(db: Database.Database): ActiveDay[] {
  const listing = buildMediaQuery({ requireExifJoin: true });
  return db.prepare(`${listing.cte}
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
export function querySampleRows(db: Database.Database, opts: { range?: { start: string; end: string }; random?: boolean; extraWhere?: string } = {}): DaySampleRow[] {
  const sampleListing = buildMediaQuery({ requireExifJoin: true, thumbnailDone: true });
  const { range, random = false } = opts;
  const rangeSql = range ? "AND mx.captured_at_precise >= ? AND mx.captured_at_precise < date(?, '+1 day')" : "";
  const rangeBindings = range ? [range.start, range.end] : [];
  return db.prepare(`WITH qualified AS (
      SELECT media.id AS id, date(mx.captured_at_precise) AS moment_date,
             mx.captured_at_precise AS moment_captured,
             NTILE(5) OVER (PARTITION BY date(mx.captured_at_precise) ORDER BY mx.captured_at_precise, media.id) AS sample_bucket
      FROM media ${sampleListing.joins}
      WHERE ${sampleListing.where} AND ${VALID_EXIF_DATE_SQL} ${rangeSql} ${opts.extraWhere ? `AND (${opts.extraWhere})` : ''}
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

export function evenlySpaced<T>(items: T[], limit = 5): T[] {
  if (items.length <= limit) return items;
  return Array.from({ length: limit }, (_, index) => items[Math.round(index * (items.length - 1) / (limit - 1))]);
}

