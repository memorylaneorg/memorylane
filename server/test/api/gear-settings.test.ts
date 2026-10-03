import { describe, expect, it } from "vitest";
import { createTestApp } from "../helpers/app.js";
import { seedFolder, seedMedia, seedScanRoot } from "../helpers/db.js";
import { SettingsRepo } from "../../src/db/settings-repo.js";

describe("gear minimum photo setting", () => {
  it("persists the threshold and applies it to camera and lens defaults", async () => {
    const t = await createTestApp();
    try {
      const root = seedScanRoot(t.db), folder = seedFolder(t.db, root, "/library");
      const id = seedMedia(t.db, folder, root);
      t.db.prepare("INSERT INTO media_exif (media_id, camera_model, lens_id, tags_json, exiftool_version) VALUES (?, 'Test camera', 'Test lens', '{}', 'test')").run(id);
      const get = (url: string) => t.app.inject({ method: "GET", url, headers: { cookie: t.cookie } });
      expect((await get("/api/settings")).json().gearMinPhotos).toBe(50);
      expect((await get("/api/gear/cameras")).json()).toHaveLength(0);
      const patch = (value: number) => t.app.inject({ method: "PUT", url: "/api/settings", headers: { cookie: t.cookie }, payload: { gearMinPhotos: value } });
      expect((await patch(1)).statusCode).toBe(200);
      expect(new SettingsRepo(t.db).getAll().gearMinPhotos).toBe(1);
      expect((await get("/api/gear/cameras")).json()).toHaveLength(1);
      expect((await get("/api/gear/lenses")).json()).toHaveLength(1);
      expect((await get("/api/gear/cameras?minPhotos=50")).json()).toHaveLength(0);
      expect((await patch(0)).statusCode).toBe(200);
      expect((await get("/api/gear/cameras")).json()).toHaveLength(1);
      expect((await get("/api/gear/lenses")).json()).toHaveLength(1);
      for (const value of [-1, 1.5]) expect((await patch(value)).statusCode).toBe(400);
    } finally { await t.close(); }
  });
  it("aggregates the same lens across cameras and applies the shared threshold", async () => {
    const t = await createTestApp();
    try {
      const root = seedScanRoot(t.db), folder = seedFolder(t.db, root, "/library");
      for (const camera of ["Camera A", "Camera B"]) {
        const id = seedMedia(t.db, folder, root);
        t.db.prepare("INSERT INTO media_exif (media_id, camera_model, lens_id, captured_at_precise, tags_json, exiftool_version) VALUES (?, ?, 'Shared lens', '2020-01-01', '{}', 'test')").run(id, camera);
      }
      new SettingsRepo(t.db).update({ gearMinPhotos: 2 });
      const get = (url: string) => t.app.inject({ method: "GET", url, headers: { cookie: t.cookie } });
      expect((await get("/api/gear/cameras")).json()).toHaveLength(0);
      expect((await get("/api/gear/lenses")).json()).toMatchObject([{ label: "Shared lens", photoCount: 2, yearBreakdown: [{ year: "2020", count: 2 }] }]);
      expect((await get("/api/gear/lenses?minPhotos=3")).json()).toHaveLength(0);
    } finally { await t.close(); }
  });

});
