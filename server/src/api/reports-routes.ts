import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import {
  reportFacetsQuerySchema,
  REPORT_FACET_FIELDS,
  FOCAL_BUCKETS,
  type ReportFacetField,
  type ReportFacetsDto,
  type FacetBucketDto,
  type ExifFilterQuery,
  type MediaTypeFilter,
} from "@memorylane/shared";
import type { AppContext } from "../context.js";
import { buildMediaQuery, mediaCountSql, type MediaQueryParams } from "../query/media-query.js";

export interface MediaFilterQuery extends ExifFilterQuery {
  type: MediaTypeFilter;
  scanRootId?: number;
  personIds?: number[];
}

// Shared by /api/media, facets and export so all three see the same set.
export function toMediaQueryParams(q: MediaFilterQuery, extra: Partial<MediaQueryParams> = {}): MediaQueryParams {
  const { type, scanRootId, personIds, ...exif } = q;
  return {
    scope: scanRootId !== undefined ? { kind: "scanRoot", scanRootId } : undefined,
    type,
    exif,
    personIds,
    ...extra,
  };
}

// SQL expression + which filter keys the facet "owns" (removed when
// computing that facet so its full list stays visible while selected).
const FACETS: Record<
  ReportFacetField,
  { expr: string; owns: (keyof ExifFilterQuery)[]; order: string; label: (v: string) => string; unlimited?: boolean }
> = {
  lens: { expr: "mx.lens_id", owns: ["lens"], order: "count DESC, value", label: (v) => v },
  camera: { expr: "mx.camera_model", owns: ["camera"], order: "count DESC, value", label: (v) => v },
  make: { expr: "mx.camera_make", owns: ["make"], order: "count DESC, value", label: (v) => v },
  aperture: { expr: "round(mx.aperture, 1)", owns: ["apertureMin", "apertureMax"], order: "CAST(value AS REAL)", label: (v) => `f/${v}` },
  iso: { expr: "mx.iso", owns: ["isoMin", "isoMax"], order: "CAST(value AS INTEGER)", label: (v) => v },
  focal: {
    expr: "CASE WHEN mx.focal_length IS NULL THEN NULL " + FOCAL_BUCKETS.slice(0, -1).map((bucket) =>
      `WHEN mx.focal_length <= ${bucket.max} THEN '${bucket.key}'`).join(" ") + ` ELSE '${FOCAL_BUCKETS.at(-1)!.key}' END`,
    owns: ["focalMin", "focalMax"],
    order: "CASE " + FOCAL_BUCKETS.map((bucket, index) => `WHEN value = '${bucket.key}' THEN ${index}`).join(" ") + " END",
    label: (v) => FOCAL_BUCKETS.find((bucket) => bucket.key === v)?.label ?? v,
    unlimited: true,
  },
  year: { expr: "substr(mx.captured_at_precise, 1, 4)", owns: ["year"], order: "value DESC", label: (v) => v },
};

const MAX_BUCKETS = 60;

const CSV_COLUMNS = [
  "id", "filename", "absolute_path", "captured_at", "camera_make", "camera_model", "camera_serial", "lens",
  "focal_length_mm", "focal_length_35mm", "aperture", "shutter_speed_s", "iso", "exposure_compensation",
  "exposure_program", "metering_mode", "flash_fired", "white_balance", "drive_mode", "rating", "keywords",
  "gps_lat", "gps_lon", "software",
];

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function registerReportsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db } = ctx;

  app.get("/api/reports/facets", { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = reportFacetsQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid query" });
    const query = parsed.data;

    const full = buildMediaQuery(toMediaQueryParams(query, { requireExifJoin: true }));
    const total = (db.prepare(mediaCountSql(full)).get(...full.bindings) as { c: number }).c;

    const facets = {} as Record<ReportFacetField, FacetBucketDto[]>;
    for (const field of REPORT_FACET_FIELDS) {
      const def = FACETS[field];
      const without = { ...query };
      for (const k of def.owns) delete (without as Record<string, unknown>)[k];
      const q = buildMediaQuery(toMediaQueryParams(without, { requireExifJoin: true }));
      const rows = db
        .prepare(
          `${q.cte} SELECT ${def.expr} AS value, COUNT(*) AS count FROM media ${q.joins}
           WHERE ${q.where} AND ${def.expr} IS NOT NULL
           GROUP BY value ORDER BY ${def.order}${def.unlimited ? "" : ` LIMIT ${MAX_BUCKETS}`}`,
        )
        .all(...q.bindings) as { value: string | number; count: number }[];
      facets[field] = rows.map((r) => ({ value: String(r.value), label: def.label(String(r.value)), count: r.count }));
    }

    const dto: ReportFacetsDto = { total, facets };
    return reply.send(dto);
  });

  // Streams promoted EXIF columns for every match. Rows are read lazily via
  // iterate() so a 500k-row export never materialises in memory.
  app.get("/api/reports/export.csv", { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = reportFacetsQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid query" });
    const q = buildMediaQuery(toMediaQueryParams(parsed.data, { requireExifJoin: true }));
    const stmt = db.prepare(
      `${q.cte} SELECT media.id, media.filename, media.absolute_path, mx.captured_at_precise AS captured_at,
         mx.camera_make, mx.camera_model, mx.camera_serial, mx.lens_id AS lens, mx.focal_length AS focal_length_mm,
         mx.focal_length_35mm, mx.aperture, mx.shutter_speed_s, mx.iso, mx.exposure_compensation, mx.exposure_program,
         mx.metering_mode, mx.flash_fired, mx.white_balance, mx.drive_mode, mx.rating, mx.keywords_json AS keywords,
         mx.gps_lat, mx.gps_lon, mx.software
       FROM media ${q.joins} WHERE ${q.where} ORDER BY mx.captured_at_precise, media.filename`,
    );
    function* lines(): Generator<string> {
      yield CSV_COLUMNS.join(",") + "\n";
      for (const row of stmt.iterate(...q.bindings) as IterableIterator<Record<string, unknown>>) {
        const r: Record<string, unknown> = {
          ...row,
          keywords: row.keywords ? (JSON.parse(String(row.keywords)) as string[]).join("; ") : null,
        };
        yield CSV_COLUMNS.map((c) => csvCell(r[c])).join(",") + "\n";
      }
    }
    const stamp = new Date().toISOString().slice(0, 10);
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="memorylane-report-${stamp}.csv"`);
    return reply.send(Readable.from(lines()));
  });
}
