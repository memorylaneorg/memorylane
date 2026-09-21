import type { FastifyInstance } from "fastify";
import type { GearCameraEnrichmentDto, GearCameraSummaryDto, GearLensSummaryDto, GearLensTimelineDto } from "@memorylane/shared";
import type { AppContext } from "../context.js";

// Points at the memorylane-museum service (separate repo - see its own
// docs/design.md for why). Override to http://localhost:4281 in root .env
// while running that service locally; production default set once it's live.
// Read lazily (not a module-level const) - ESM hoists this module's import
// ahead of server.ts's own loadDotenv() call, so a top-level read here would
// always see process.env before .env is loaded, ignoring the override.
function museumUrl(): string {
  return process.env.MEMORYLANE_MUSEUM_URL ?? "https://memorylaneapp.org";
}

interface MuseumGear {
  brand: string | null;
  model: string;
  release_date: string | null;
  weight_g: number | null;
  length_mm: number | null;
  width_mm: number | null;
  height_mm: number | null;
  image_filename: string | null;
  image_license: string | null;
  image_attribution: string | null;
}
interface MuseumResult {
  kind: "camera" | "lens";
  label: string;
  status: string;
  gear?: MuseumGear;
}

// Best-effort: the museum service is a separate, independently-deployed
// process (design doc's whole point - it can be down without breaking the
// rest of the app), so any failure here just means every label comes back
// with no enrichment rather than a 500.
async function museumLookup(kind: "camera" | "lens", labels: string[]): Promise<Map<string, MuseumGear | null>> {
  const map = new Map<string, MuseumGear | null>();
  if (labels.length === 0) return map;
  try {
    const res = await fetch(`${museumUrl()}/gear/v1/lookup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: labels.slice(0, 100).map((label) => ({ kind, label })) }),
    });
    if (!res.ok) {
      console.error(`[gear] museum lookup at ${museumUrl()} returned ${res.status}`);
      return map;
    }
    const { results } = (await res.json()) as { results: MuseumResult[] };
    for (const r of results) map.set(r.label, r.gear ?? null);
  } catch (err) {
    console.error(`[gear] museum lookup at ${museumUrl()} failed:`, err instanceof Error ? err.message : err);
  }
  return map;
}

function imageUrl(g: MuseumGear | null | undefined): string | null {
  return g?.image_filename ? `${museumUrl()}/gear/v1/images/${g.image_filename}` : null;
}

export async function registerGearRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db } = ctx;

  const mostUsedLens = db.prepare(
    `SELECT mx.lens_id AS label, COUNT(*) AS photoCount
     FROM media_exif mx JOIN media ON media.id = mx.media_id
     WHERE mx.camera_model = ? AND mx.lens_id IS NOT NULL AND mx.lens_id != ''
     GROUP BY mx.lens_id ORDER BY photoCount DESC LIMIT 1`,
  );

  // A camera clock set wrong produces obviously-bogus captured_at values
  // (seen for real: one camera's raw MIN/MAX spanned 2007-2136). Bounding to
  // [2000-01-01, today] keeps those out of the date-based aggregates below
  // without touching photoCount itself - the photo is real, only its
  // timestamp is garbage, so it still belongs in the library total.
  const DATE_FLOOR = "2000-01-01";
  const dateBound = "mx.captured_at_precise >= ? AND mx.captured_at_precise <= date('now', '+1 day')";

  const yearBreakdown = db.prepare(
    `SELECT substr(mx.captured_at_precise, 1, 4) AS year, COUNT(*) AS photoCount
     FROM media_exif mx JOIN media ON media.id = mx.media_id
     WHERE mx.camera_model = ? AND ${dateBound}
     GROUP BY year ORDER BY photoCount DESC`,
  );

  // No reverse-geocoded place names exist anywhere in this app (only raw
  // gps_lat/gps_lon) - rounding to ~1km clusters counts distinct real
  // locations without inventing country/city names we don't have.
  const distinctLocations = db.prepare(
    `SELECT COUNT(DISTINCT ROUND(mx.gps_lat, 2) || ',' || ROUND(mx.gps_lon, 2)) AS c
     FROM media_exif mx JOIN media ON media.id = mx.media_id
     WHERE mx.camera_model = ? AND mx.gps_lat IS NOT NULL AND mx.gps_lon IS NOT NULL`,
  );

  app.get("/api/gear/cameras", { preHandler: app.requireAuth }, async (request, reply) => {
    // Filters out gear a real EXIF scan only barely touched - a stray photo
    // someone else took on a borrowed/shared device, not something the user
    // actually owned and used. Adjustable via ?minPhotos=, default 50.
    const minPhotosRaw = Number((request.query as { minPhotos?: string }).minPhotos);
    const minPhotos = Number.isFinite(minPhotosRaw) && minPhotosRaw >= 0 ? minPhotosRaw : 50;

    const rows = db
      .prepare(
        `SELECT mx.camera_model AS label, COUNT(*) AS photoCount,
                MIN(CASE WHEN ${dateBound} THEN mx.captured_at_precise END) AS firstPhoto,
                MAX(CASE WHEN ${dateBound} THEN mx.captured_at_precise END) AS lastPhoto,
                MIN(mx.iso) AS isoMin, MAX(mx.iso) AS isoMax,
                MIN(mx.aperture) AS apertureMin, MAX(mx.aperture) AS apertureMax
         FROM media_exif mx JOIN media ON media.id = mx.media_id
         WHERE mx.camera_model IS NOT NULL AND mx.camera_model != ''
         GROUP BY mx.camera_model
         HAVING COUNT(*) >= ?
         ORDER BY photoCount DESC`,
      )
      .all(DATE_FLOOR, DATE_FLOOR, minPhotos) as {
      label: string;
      photoCount: number;
      firstPhoto: string | null;
      lastPhoto: string | null;
      isoMin: number | null;
      isoMax: number | null;
      apertureMin: number | null;
      apertureMax: number | null;
    }[];

    // Museum enrichment (image/specs) is deliberately NOT fetched here - it's
    // an external service call, while everything above comes straight out of
    // the local EXIF scan and should always reflect its current state. See
    // POST /api/gear/cameras/enrich, which the client caches independently.
    const dto: GearCameraSummaryDto[] = rows.map((r) => {
      const lens = mostUsedLens.get(r.label) as { label: string; photoCount: number } | undefined;
      const years = yearBreakdown.all(r.label, DATE_FLOOR) as { year: string; photoCount: number }[];
      const locations = distinctLocations.get(r.label) as { c: number } | undefined;
      return {
        label: r.label,
        photoCount: r.photoCount,
        firstPhoto: r.firstPhoto,
        lastPhoto: r.lastPhoto,
        isoMin: r.isoMin,
        isoMax: r.isoMax,
        apertureMin: r.apertureMin,
        apertureMax: r.apertureMax,
        mostUsedLens: lens?.label ?? null,
        mostUsedLensCount: lens?.photoCount ?? null,
        yearBreakdown: years.map((y) => ({ year: y.year, count: y.photoCount })),
        distinctLocations: locations && locations.c > 0 ? locations.c : null,
        brand: null,
        model: null,
        releaseDate: null,
        weightG: null,
        lengthMm: null,
        widthMm: null,
        heightMm: null,
        imageUrl: null,
        imageLicense: null,
        imageAttribution: null,
      };
    });
    return reply.send(dto);
  });

  // Separate from /api/gear/cameras so the client can cache this part on its
  // own terms (only refetch on an explicit refresh) while the EXIF data above
  // stays always-fresh on every load.
  app.post("/api/gear/cameras/enrich", { preHandler: app.requireAuth }, async (request, reply) => {
    const { labels } = request.body as { labels?: unknown };
    if (!Array.isArray(labels) || labels.length === 0) return reply.send({});
    const validLabels = labels.filter((l): l is string => typeof l === "string");
    const museum = await museumLookup("camera", validLabels);
    const result: Record<string, GearCameraEnrichmentDto> = {};
    for (const label of validLabels) {
      const g = museum.get(label);
      result[label] = {
        brand: g?.brand ?? null,
        model: g?.model ?? null,
        releaseDate: g?.release_date ?? null,
        weightG: g?.weight_g ?? null,
        lengthMm: g?.length_mm ?? null,
        widthMm: g?.width_mm ?? null,
        heightMm: g?.height_mm ?? null,
        imageUrl: imageUrl(g),
        imageLicense: g?.image_license ?? null,
        imageAttribution: g?.image_attribution ?? null,
      };
    }
    return reply.send(result);
  });

  // Library-wide (not scoped to any one camera, not affected by minPhotos)
  // per-year photo totals - used by the timeline to show "N% of all photos
  // taken that year" on hover, which needs the true denominator, not just
  // whatever cameras happen to be currently displayed.
  app.get("/api/gear/year-totals", { preHandler: app.requireAuth }, async (_request, reply) => {
    const rows = db
      .prepare(
        `SELECT substr(mx.captured_at_precise, 1, 4) AS year, COUNT(*) AS photoCount
         FROM media_exif mx JOIN media ON media.id = mx.media_id
         WHERE mx.camera_model IS NOT NULL AND mx.camera_model != '' AND ${dateBound}
         GROUP BY year`,
      )
      .all(DATE_FLOOR) as { year: string; photoCount: number }[];
    return reply.send(rows.map((r) => ({ year: r.year, count: r.photoCount })));
  });

  app.get("/api/gear/lenses", { preHandler: app.requireAuth }, async (request, reply) => {
    const minPhotosRaw = Number((request.query as { minPhotos?: string }).minPhotos);
    const minPhotos = Number.isFinite(minPhotosRaw) && minPhotosRaw >= 0 ? minPhotosRaw : 50;
    const rows = db.prepare(
      `SELECT mx.lens_id AS label, COUNT(*) AS photoCount,
              MIN(CASE WHEN ${dateBound} THEN mx.captured_at_precise END) AS firstPhoto,
              MAX(CASE WHEN ${dateBound} THEN mx.captured_at_precise END) AS lastPhoto
       FROM media_exif mx JOIN media ON media.id = mx.media_id
       WHERE mx.lens_id IS NOT NULL AND mx.lens_id != ''
       GROUP BY mx.lens_id HAVING COUNT(*) >= ? ORDER BY photoCount DESC`,
    ).all(DATE_FLOOR, DATE_FLOOR, minPhotos) as Array<{ label: string; photoCount: number; firstPhoto: string | null; lastPhoto: string | null }>;
    const lensYears = db.prepare(
      `SELECT substr(mx.captured_at_precise, 1, 4) AS year, COUNT(*) AS photoCount
       FROM media_exif mx JOIN media ON media.id = mx.media_id
       WHERE mx.lens_id = ? AND ${dateBound} GROUP BY year ORDER BY photoCount DESC`,
    );
    const museum = await museumLookup("lens", rows.map((row) => row.label));
    const dto: GearLensTimelineDto[] = rows.map((row) => {
      const gear = museum.get(row.label);
      const breakdown = lensYears.all(row.label, DATE_FLOOR) as Array<{ year: string; photoCount: number }>;
      return {
        ...row,
        yearBreakdown: breakdown.map((entry) => ({ year: entry.year, count: entry.photoCount })),
        brand: gear?.brand ?? null,
        model: gear?.model ?? null,
        imageUrl: imageUrl(gear),
        imageLicense: gear?.image_license ?? null,
        imageAttribution: gear?.image_attribution ?? null,
      };
    });
    return reply.send(dto);
  });

  app.get("/api/gear/cameras/lenses", { preHandler: app.requireAuth }, async (request, reply) => {
    const camera = (request.query as { camera?: string }).camera;
    if (!camera) return reply.code(400).send({ error: "camera is required" });

    const rows = db
      .prepare(
        `SELECT mx.lens_id AS label, COUNT(*) AS photoCount
         FROM media_exif mx JOIN media ON media.id = mx.media_id
         WHERE mx.camera_model = ? AND mx.lens_id IS NOT NULL AND mx.lens_id != ''
         GROUP BY mx.lens_id ORDER BY photoCount DESC`,
      )
      .all(camera) as { label: string; photoCount: number }[];

    const museum = await museumLookup("lens", rows.map((r) => r.label));
    const dto: GearLensSummaryDto[] = rows.map((r) => {
      const g = museum.get(r.label);
      return {
        label: r.label,
        photoCount: r.photoCount,
        brand: g?.brand ?? null,
        model: g?.model ?? null,
        imageUrl: imageUrl(g),
        imageLicense: g?.image_license ?? null,
        imageAttribution: g?.image_attribution ?? null,
      };
    });
    return reply.send(dto);
  });
}
