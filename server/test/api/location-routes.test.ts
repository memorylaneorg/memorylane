import { describe, expect, it } from "vitest";
import { createTestApp } from "../helpers/app.js";
import { seedFolder, seedMedia, seedScanRoot } from "../helpers/db.js";
import { cellKey } from "../../src/locations/location-grid.js";

describe("location routes", () => {
  it("requires login and rejects invalid map requests", async () => {
    const t = await createTestApp();
    try {
      expect((await t.app.inject({ method: "GET", url: "/api/locations/summary" })).statusCode).toBe(401);
      const get = (url: string) => t.app.inject({ method: "GET", url, headers: { cookie: t.cookie } });
      expect((await get("/api/locations/cells?west=200&east=1&south=-20&north=20&zoom=0")).statusCode).toBe(400);
      expect((await get("/api/locations/summary?fromYear=2025&toYear=2020")).statusCode).toBe(400);
      expect((await get("/api/locations/summary?fromYear=1799&toYear=2101")).statusCode).toBe(200);
      expect((await get("/api/locations/cells/0:1:2/items?limit=500")).statusCode).toBe(400);
    } finally { await t.close(); }
  });

  it("keeps summary, cells, and selected items in agreement", async () => {
    const t = await createTestApp();
    try {
      const root = seedScanRoot(t.db), folder = seedFolder(t.db, root, "/library");
      const id = seedMedia(t.db, folder, root, { captured_date: "2020-04-03T00:00:00Z" });
      t.db.prepare("UPDATE media SET gps_lat = 40, gps_lon = -74 WHERE id = ?").run(id);
      const get = (url: string) => t.app.inject({ method: "GET", url, headers: { cookie: t.cookie } });
      const summary = (await get("/api/locations/summary")).json();
      expect(summary).toMatchObject({ total: 1, sources: { filesystem: 1, apple: 0 }, years: [{ year: 2020, count: 1 }] });
      const cells = (await get("/api/locations/cells?west=-180&east=180&south=-90&north=90&zoom=0")).json();
      expect(cells.total).toBe(1);
      expect(cells.items).toMatchObject([{ key: cellKey(40, -74, 0), count: 1 }]);
      const result = (await get(`/api/locations/cells/${cellKey(40, -74, 0)}/items`)).json();
      expect(result.total).toBe(1);
      expect(result.mediaTotal).toBe(1);
      expect(result.items).toMatchObject([{ kind: "media", media: { id } }]);
      expect((await get("/api/locations/summary?fromYear=2021")).json().total).toBe(0);
    } finally { await t.close(); }
  });

  it("returns catalog-only Apple items while the plugin is enabled", async () => {
    const t = await createTestApp();
    try {
      const root = seedScanRoot(t.db, "/Photos.photoslibrary");
      t.db.prepare("UPDATE scan_roots SET kind = 'apple-photos' WHERE id = ?").run(root);
      t.db.prepare(`INSERT INTO apple_photos_assets
        (scan_root_id, uuid, original_filename, catalog_date, catalog_gps_lat, catalog_gps_lon)
        VALUES (?, 'cloud', 'cloud.jpg', '2020-05-02', 40, -74)`).run(root);
      t.db.prepare("INSERT INTO plugin_settings (id, enabled) VALUES ('apple-photos', 1)").run();
      const get = (url: string) => t.app.inject({ method: "GET", url, headers: { cookie: t.cookie } });
      const result = (await get(`/api/locations/cells/${cellKey(40, -74, 0)}/items`)).json();
      if (process.platform === "darwin") {
        expect(result.items).toMatchObject([{ kind: "apple-catalog", rootId: root, uuid: "cloud", filename: "cloud.jpg" }]);
        expect(result.mediaTotal).toBe(0);
        t.db.prepare("UPDATE plugin_settings SET enabled = 0 WHERE id = 'apple-photos'").run();
        expect((await get("/api/locations/summary")).json().total).toBe(0);
      } else expect(result.items).toEqual([]);
    } finally { await t.close(); }
  });

  it("uses the same viewport for a selected cell and its item count", async () => {
    const t = await createTestApp();
    try {
      const root = seedScanRoot(t.db), folder = seedFolder(t.db, root, "/library");
      const inside = seedMedia(t.db, folder, root), outside = seedMedia(t.db, folder, root);
      t.db.prepare("UPDATE media SET gps_lat = 40, gps_lon = -74 WHERE id = ?").run(inside);
      t.db.prepare("UPDATE media SET gps_lat = 40.005, gps_lon = -74.005 WHERE id = ?").run(outside);
      const bounds = "west=-74.001&east=-73.999&south=39.999&north=40.001";
      const get = (url: string) => t.app.inject({ method: "GET", url, headers: { cookie: t.cookie } });
      const cells = (await get(`/api/locations/cells?${bounds}&zoom=0`)).json();
      expect(cells).toMatchObject({ total: 1, items: [{ count: 1 }] });
      const items = (await get(`/api/locations/cells/${cellKey(40, -74, 0)}/items?${bounds}`)).json();
      expect(items).toMatchObject({ total: 1, items: [{ kind: "media", media: { id: inside } }] });
    } finally { await t.close(); }
  });
});
