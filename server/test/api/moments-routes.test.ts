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
});
