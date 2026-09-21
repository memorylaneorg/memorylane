import { describe, expect, it } from "vitest";
import { createTestDb, seedFolder, seedMedia, seedScanRoot } from "../helpers/db.js";
import { LocationRepo } from "../../src/locations/location-repo.js";

describe("LocationRepo", () => {
  it("combines visible filesystem and Apple assets without duplicating linked Photos media", async () => {
    const db = await createTestDb();
    try {
      const fileRoot = seedScanRoot(db);
      const fileFolder = seedFolder(db, fileRoot, "/library");
      const local = seedMedia(db, fileFolder, fileRoot, { captured_date: "2019-05-02T12:00:00Z" });
      const marked = seedMedia(db, fileFolder, fileRoot);
      const invalid = seedMedia(db, fileFolder, fileRoot);
      db.prepare("UPDATE media SET gps_lat = ?, gps_lon = ? WHERE id = ?").run(40, -74, local);
      db.prepare("UPDATE media SET gps_lat = ?, gps_lon = ? WHERE id = ?").run(41, -75, marked);
      db.prepare("UPDATE media SET gps_lat = ?, gps_lon = ? WHERE id = ?").run(120, 2, invalid);
      db.prepare("INSERT INTO deletion_marks (media_id) VALUES (?)").run(marked);

      const appleRoot = seedScanRoot(db, "/Photos.photoslibrary");
      db.prepare("UPDATE scan_roots SET kind = 'apple-photos' WHERE id = ?").run(appleRoot);
      const appleFolder = seedFolder(db, appleRoot, "/Photos.photoslibrary");
      const linked = seedMedia(db, appleFolder, appleRoot, { captured_date: "2018-01-01T00:00:00Z" });
      db.prepare("UPDATE media SET source_kind = 'apple-photos', gps_lat = 10, gps_lon = 20 WHERE id = ?").run(linked);
      const insert = db.prepare(`INSERT INTO apple_photos_assets
        (scan_root_id, uuid, media_id, original_filename, catalog_date, catalog_gps_lat, catalog_gps_lon, hidden)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      insert.run(appleRoot, "linked", linked, "linked.jpg", "2020-06-01", 11, 21, 0);
      insert.run(appleRoot, "cloud", null, "cloud.jpg", "2021-07-01", 12, 22, 0);
      insert.run(appleRoot, "hidden", null, "hidden.jpg", "2021-07-01", 13, 23, 1);
      db.prepare("INSERT INTO plugin_settings (id, enabled) VALUES ('apple-photos', 1)").run();

      const repo = new LocationRepo(db);
      const points = [...repo.points({ source: "all" })];
      if (process.platform === "darwin") {
        expect(new Set(points.map((point) => point.key))).toEqual(new Set([`m:${local}`, `a:${appleRoot}:linked`, `a:${appleRoot}:cloud`]));
        expect(points.find((point) => point.uuid === "linked")).toMatchObject({ mediaId: linked, lat: 11, lon: 21, date: "2020-06-01" });
        expect(points.find((point) => point.uuid === "cloud")).toMatchObject({ mediaId: null, lat: 12, lon: 22 });
        expect([...repo.points({ source: "apple" }, { west: 20.5, east: 22.5, south: 10.5, north: 12.5 })].map((point) => point.uuid)).toEqual(["linked", "cloud"]);
        expect([...repo.points({ source: "apple", fromYear: 2021, toYear: 2021 })].map((point) => point.uuid)).toEqual(["cloud"]);
        expect(repo.summary({ source: "all" })).toMatchObject({ total: 3, sources: { filesystem: 1, apple: 2 } });
      } else expect(points.map((point) => point.key)).toEqual([`m:${local}`]);

      db.prepare("UPDATE plugin_settings SET enabled = 0 WHERE id = 'apple-photos'").run();
      expect([...repo.points({ source: "all" })].map((point) => point.key)).toEqual([`m:${local}`]);
      db.prepare("UPDATE plugin_settings SET enabled = 1 WHERE id = 'apple-photos'").run();
      db.prepare("UPDATE scan_roots SET enabled = 0 WHERE id = ?").run(appleRoot);
      expect([...repo.points({ source: "all" })].map((point) => point.key)).toEqual([`m:${local}`]);
    } finally { db.close(); }
  });

  it("includes unknown dates only without an active time range", async () => {
    const db = await createTestDb();
    try {
      const root = seedScanRoot(db), folder = seedFolder(db, root, "/library");
      const id = seedMedia(db, folder, root, { captured_date: null });
      db.prepare("UPDATE media SET gps_lat = 0, gps_lon = 0 WHERE id = ?").run(id);
      const repo = new LocationRepo(db);
      expect([...repo.points({ source: "all" })]).toHaveLength(1);
      expect([...repo.points({ source: "all", fromYear: 2000 })]).toHaveLength(0);
      expect(repo.summary({ source: "all" })).toMatchObject({ total: 1, undated: 1 });
    } finally { db.close(); }
  });

  it("uses complete Photos coordinate pairs instead of mixing catalog and EXIF axes", async () => {
    const db = await createTestDb();
    try {
      const root = seedScanRoot(db, "/Photos.photoslibrary");
      db.prepare("UPDATE scan_roots SET kind = 'apple-photos' WHERE id = ?").run(root);
      const folder = seedFolder(db, root, "/Photos.photoslibrary");
      const id = seedMedia(db, folder, root);
      db.prepare("UPDATE media SET source_kind = 'apple-photos', gps_lat = 10, gps_lon = 20 WHERE id = ?").run(id);
      db.prepare(`INSERT INTO apple_photos_assets (scan_root_id, uuid, media_id, catalog_gps_lat)
        VALUES (?, 'partial', ?, 11)`).run(root, id);
      db.prepare("INSERT INTO plugin_settings (id, enabled) VALUES ('apple-photos', 1)").run();
      const points = [...new LocationRepo(db).points({ source: "apple" })];
      if (process.platform === "darwin") {
        expect(points).toMatchObject([{ lat: 10, lon: 20 }]);
        expect([...new LocationRepo(db).points({ source: "apple" }, { west: 19, east: 21, south: 9, north: 11 })]).toMatchObject([{ lat: 10, lon: 20 }]);
      }
      else expect(points).toEqual([]);
    } finally { db.close(); }
  });

  it("keeps indexed folder locations visible when their root is paused from scanning", async () => {
    const db = await createTestDb();
    try {
      const root = seedScanRoot(db), folder = seedFolder(db, root, "/library");
      const id = seedMedia(db, folder, root);
      db.prepare("UPDATE media SET gps_lat = 1, gps_lon = 2 WHERE id = ?").run(id);
      db.prepare("UPDATE scan_roots SET enabled = 0 WHERE id = ?").run(root);
      expect([...new LocationRepo(db).points({ source: "filesystem" })].map((point) => point.mediaId)).toEqual([id]);
    } finally { db.close(); }
  });

  it("uses viewport bounds for folder and Photos coordinates, including the antimeridian", async () => {
    const db = await createTestDb();
    try {
      const root = seedScanRoot(db), folder = seedFolder(db, root, "/library");
      const east = seedMedia(db, folder, root), west = seedMedia(db, folder, root), outside = seedMedia(db, folder, root);
      db.prepare("UPDATE media SET gps_lat = ?, gps_lon = ? WHERE id = ?").run(10, 179.5, east);
      db.prepare("UPDATE media SET gps_lat = ?, gps_lon = ? WHERE id = ?").run(10, -179.5, west);
      db.prepare("UPDATE media SET gps_lat = ?, gps_lon = ? WHERE id = ?").run(10, 0, outside);
      const bounds = { west: 179, east: -179, south: 9, north: 11 };
      const points = [...new LocationRepo(db).points({ source: "filesystem" }, bounds)];
      expect(new Set(points.map((point) => point.mediaId))).toEqual(new Set([east, west]));
    } finally { db.close(); }
  });
});
