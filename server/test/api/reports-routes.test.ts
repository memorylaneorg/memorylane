import { describe, it, expect } from "vitest";
import { createTestApp } from "../helpers/app.js";
import { seedScanRoot, seedFolder, seedMedia } from "../helpers/db.js";

async function seeded() {
  const t = await createTestApp();
  const root = seedScanRoot(t.db);
  const top = seedFolder(t.db, root, "/library");
  const ins = t.db.prepare(
    `INSERT INTO media_exif (media_id, lens_id, camera_model, camera_make, aperture, iso, focal_length, captured_at_precise, shutter_speed_s, tags_json, exiftool_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 't')`,
  );
  const a = seedMedia(t.db, top, root, { filename: "a.jpg" });
  const b = seedMedia(t.db, top, root, { filename: "b.jpg" });
  const c = seedMedia(t.db, top, root, { filename: "c.jpg" });
  seedMedia(t.db, top, root, { filename: "noexif.jpg" });
  ins.run(a, "RF 100-500", "Canon EOS R5", "Canon", 7.1, 3200, 500, "2024-05-12T10:31:44.250", 1 / 2000);
  ins.run(b, "RF 100-500", "Canon EOS R5", "Canon", 5.6, 800, 300, "2024-06-01T09:00:00.000", 1 / 500);
  ins.run(c, "EF 50", "Canon EOS 5D Mark IV", "Canon", 1.8, 100, 50, "2019-06-01T12:00:00.000", 1 / 125);
  return { t, a, b, c };
}
const get = (t: Awaited<ReturnType<typeof createTestApp>>, url: string) =>
  t.app.inject({ method: "GET", url, headers: { cookie: t.cookie } });

describe("reports", () => {
  it("uses the adaptive focal scale without truncating populated buckets", async () => {
    const t = await createTestApp();
    try {
      const root = seedScanRoot(t.db);
      const folder = seedFolder(t.db, root, "/library");
      const insert = t.db.prepare(`INSERT INTO media_exif
        (media_id, focal_length, tags_json, exiftool_version) VALUES (?, ?, '{}', 't')`);
      for (let focal = 10; focal < 80; focal++) insert.run(seedMedia(t.db, folder, root, { filename: `${focal}.jpg` }), focal);
      insert.run(seedMedia(t.db, folder, root, { filename: "phone.jpg" }), 4.25);
      insert.run(seedMedia(t.db, folder, root, { filename: "fisheye.jpg" }), 8);

      const response = await get(t, "/api/reports/facets");
      const focal = response.json().facets.focal as Array<{ value: string; label: string; count: number }>;
      expect(focal).toHaveLength(44);
      expect(focal[0]).toEqual({ value: "lt10", label: "< 10 mm", count: 2 });
      expect(focal.at(-1)).toEqual({ value: "70-79", label: "70–79 mm", count: 10 });
      expect((await get(t, "/api/media?focalMin=0&focalMax=9.999999999")).json().total).toBe(2);
    } finally { await t.close(); }
  });

  it("puts rounded focal lengths into the correct transition buckets", async () => {
    const t = await createTestApp();
    try {
      const root = seedScanRoot(t.db);
      const folder = seedFolder(t.db, root, "/library");
      const insert = t.db.prepare(`INSERT INTO media_exif
        (media_id, focal_length, tags_json, exiftool_version) VALUES (?, ?, '{}', 't')`);
      for (const focal of [49.49, 49.5, 199.49, 199.5, 699.49, 699.5, 999.49, 999.5]) {
        insert.run(seedMedia(t.db, folder, root, { filename: `${focal}.jpg` }), focal);
      }

      const response = await get(t, "/api/reports/facets");
      const focal = response.json().facets.focal as Array<{ value: string; label: string; count: number }>;
      expect(focal.map((bucket) => bucket.value)).toEqual([
        "49", "50-59", "190-199", "200-219", "680-699", "700-749", "950-999", "gte1000",
      ]);
      for (const bucket of focal) expect(bucket.count).toBe(1);
    } finally { await t.close(); }
  });

  it("facets: counts per field, each ignoring its own filter", async () => {
    const S = await seeded();
    try {
      const r = await get(S.t, "/api/reports/facets?lens=RF%20100-500");
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.total).toBe(2);
      // lens facet ignores the lens filter → both lenses listed
      expect(body.facets.lens).toEqual([
        { value: "RF 100-500", label: "RF 100-500", count: 2 },
        { value: "EF 50", label: "EF 50", count: 1 },
      ]);
      // other facets respect the lens filter
      expect(body.facets.camera).toEqual([{ value: "Canon EOS R5", label: "Canon EOS R5", count: 2 }]);
      expect(body.facets.aperture).toEqual([
        { value: "5.6", label: "f/5.6", count: 1 },
        { value: "7.1", label: "f/7.1", count: 1 },
      ]);
      expect(body.facets.focal).toEqual([
        { value: "300-319", label: "300–319 mm", count: 1 },
        { value: "500-519", label: "500–519 mm", count: 1 },
      ]);
      expect(body.facets.year).toEqual([{ value: "2024", label: "2024", count: 2 }]);
      expect(body.facets.iso.map((b: { value: string }) => b.value)).toEqual(["800", "3200"]);
    } finally {
      await S.t.close();
    }
  });

  it("GET /api/media applies the same filters with pagination", async () => {
    const S = await seeded();
    try {
      const r = await get(S.t, "/api/media?camera=Canon%20EOS%20R5&isoMin=1000&limit=10");
      expect(r.json().total).toBe(1);
      expect(r.json().items[0].id).toBe(S.a);
      const all = await get(S.t, "/api/media");
      expect(all.json().total).toBe(4); // no EXIF filter → no join → noexif.jpg included
    } finally {
      await S.t.close();
    }
  });

  it("export.csv streams a header plus one row per match", async () => {
    const S = await seeded();
    try {
      const r = await get(S.t, "/api/reports/export.csv?year=2024");
      expect(r.statusCode).toBe(200);
      expect(r.headers["content-type"]).toContain("text/csv");
      expect(r.headers["content-disposition"]).toContain("attachment");
      const lines = r.body.trim().split("\n");
      expect(lines.length).toBe(3);
      expect(lines[0].startsWith("id,filename,absolute_path,captured_at,camera_make,camera_model")).toBe(true);
      expect(lines[1]).toContain("RF 100-500");
    } finally {
      await S.t.close();
    }
  });

  it("rejects bad filter values", async () => {
    const S = await seeded();
    try {
      expect((await get(S.t, "/api/reports/facets?year=abc")).statusCode).toBe(400);
      expect((await get(S.t, "/api/media?from=2024-1-1")).statusCode).toBe(400);
    } finally {
      await S.t.close();
    }
  });
});
