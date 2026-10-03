import { describe, expect, it } from "vitest";
import { createTestApp } from "../helpers/app.js";
import { seedFolder, seedMedia, seedScanRoot } from "../helpers/db.js";

describe("timeline routes", () => {
  it("groups all media types by valid EXIF month and samples across each month", async () => {
    const t = await createTestApp();
    try {
      const root = seedScanRoot(t.db);
      const folder = seedFolder(t.db, root, "/library");
      const insertExif = t.db.prepare("INSERT INTO media_exif (media_id, captured_at_precise, tags_json, exiftool_version) VALUES (?, ?, '{}', 'test')");
      const januaryIds: number[] = [];
      for (let day = 1; day <= 10; day += 1) {
        const id = seedMedia(t.db, folder, root, { filename: `january-${day}.jpg` });
        januaryIds.push(id);
        insertExif.run(id, `2024-01-${String(day).padStart(2, "0")}T12:00:00`);
      }
      const video = seedMedia(t.db, folder, root, { filename: "february.mp4", media_type: "video" });
      insertExif.run(video, "2024-02-10T12:00:00");
      const tooOld = seedMedia(t.db, folder, root, { filename: "old.jpg" });
      insertExif.run(tooOld, "1989-12-31T12:00:00");
      const future = seedMedia(t.db, folder, root, { filename: "future.jpg" });
      insertExif.run(future, "2999-01-01T12:00:00");

      const response = await t.app.inject({ method: "GET", url: "/api/timeline", headers: { cookie: t.cookie } });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.years).toHaveLength(1);
      expect(body.years[0].year).toBe(2024);
      expect(body.years[0].mediaCount).toBe(11);
      expect(body.years[0].months.map((month: { month: number }) => month.month)).toEqual([2, 1]);
      expect(body.years[0].months[0].samples).toMatchObject([{ id: video, mediaType: "video" }]);
      expect(body.years[0].months[1].mediaCount).toBe(10);
      expect(body.years[0].months[1].samples).toHaveLength(5);
      const sampleIds = body.years[0].months[1].samples.map((item: { id: number }) => item.id);
      expect(sampleIds[0]).toBe(januaryIds[0]);
      expect(sampleIds[4]).toBe(januaryIds[8]);
      expect(body.years.some((entry: { year: number }) => entry.year === 1989 || entry.year === 2999)).toBe(false);
    } finally {
      await t.close();
    }
  });
});
