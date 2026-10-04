import { describe, expect, it } from "vitest";
import { createTestApp } from "../helpers/app.js";
import { seedFolder, seedMedia, seedScanRoot } from "../helpers/db.js";

describe("moments routes", () => {
  it("returns detected multi-day moments and their active-day detail", async () => {
    const t = await createTestApp();
    try {
      const root = seedScanRoot(t.db);
      const folder = seedFolder(t.db, root, "/library");
      const exif = t.db.prepare("INSERT INTO media_exif (media_id, captured_at_precise, tags_json, exiftool_version) VALUES (?, ?, '{}', 'test')");
      for (const date of ["2024-04-01", "2024-04-02", "2024-04-04"]) {
        for (let index = 0; index < 4; index += 1) {
          const id = seedMedia(t.db, folder, root, { filename: `${date}-${index}.jpg` });
          exif.run(id, `${date}T${String(10 + index).padStart(2, "0")}:00:00`);
        }
      }
      const headers = { cookie: t.cookie };
      const summaryResponse = await t.app.inject({ method: "GET", url: "/api/moments?detection=detailed", headers });
      expect(summaryResponse.statusCode).toBe(200);
      const summary = summaryResponse.json();
      expect(summary.years[0]).toMatchObject({ year: 2024, mediaCount: 12, eventCount: 0, multiDayCount: 1 });
      expect(summary.years[0].moments[0]).toMatchObject({ kind: "multi-day", startDate: "2024-04-01", endDate: "2024-04-04", calendarDays: 4, mediaCount: 12 });
      expect(summary.years[0].moments[0].samples).toHaveLength(5);

      const detailResponse = await t.app.inject({ method: "GET", url: "/api/moments/2024-04-01/2024-04-04?detection=detailed", headers });
      expect(detailResponse.statusCode).toBe(200);
      expect(detailResponse.json().days.map((day: { date: string }) => day.date)).toEqual(["2024-04-01", "2024-04-02", "2024-04-04"]);
    } finally {
      await t.close();
    }
  });

  it("caches the scan, rebuilds when the library changes, and re-rolls samples on refresh", async () => {
    const t = await createTestApp();
    try {
      const root = seedScanRoot(t.db);
      const folder = seedFolder(t.db, root, "/library");
      const exif = t.db.prepare("INSERT INTO media_exif (media_id, captured_at_precise, tags_json, exiftool_version) VALUES (?, ?, '{}', 'test')");
      const add = (date: string, index: number) => exif.run(seedMedia(t.db, folder, root, { filename: `${date}-${index}.jpg` }), `${date}T${String(10 + index).padStart(2, "0")}:00:00`);
      for (let index = 0; index < 10; index += 1) add("2024-05-01", index);
      const headers = { cookie: t.cookie };
      const get = async (url: string) => (await t.app.inject({ method: "GET", url, headers })).json();
      const ids = (summary: { years: { moments: { samples: { id: number }[] }[] }[] }) => summary.years[0].moments[0].samples.map((s) => s.id);

      const first = await get("/api/moments");
      expect(first.years[0].mediaCount).toBe(10);
      expect(ids(await get("/api/moments"))).toEqual(ids(first));

      add("2024-05-01", 10);
      expect((await get("/api/moments")).years[0].mediaCount).toBe(11);

      const refreshed = await get("/api/moments?refresh=1");
      expect(refreshed.years[0].mediaCount).toBe(11);
      expect(ids(refreshed)).toHaveLength(5);

      const timeline = await get("/api/timeline?refresh=1");
      expect(timeline.years[0].months[0].mediaCount).toBe(11);
    } finally {
      await t.close();
    }
  });
});
