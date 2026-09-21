import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createTestApp } from "../helpers/app.js";
import { seedScanRoot, seedFolder, seedMedia } from "../helpers/db.js";
import { thumbnailPathForMediaId } from "../../src/config/paths.js";

describe("disabled Apple Photos media visibility", () => {
  it("serves hover preview only while the plugin is enabled", async () => {
    const t = await createTestApp();
    try {
      const root = seedScanRoot(t.db, "/preview.photoslibrary");
      t.db.prepare("UPDATE scan_roots SET kind = 'apple-photos' WHERE id = ?").run(root);
      const url = `/api/plugins/apple-photos/roots/${root}/preview?year=2021`;
      const get = () => t.app.inject({ method: "GET", url, headers: { cookie: t.cookie } });
      expect((await get()).statusCode).toBe(404);
      await t.app.inject({ method: "PUT", url: "/api/plugins/apple-photos", headers: { cookie: t.cookie }, payload: { enabled: true } });
      expect((await get()).statusCode).toBe(process.platform === "darwin" ? 200 : 404);
    } finally { await t.close(); }
  });

  it("hides Apple media from listings and direct media endpoints, including cached thumbnails", async () => {
    const t = await createTestApp();
    const ordinaryRoot = seedScanRoot(t.db, "/ordinary");
    const ordinaryFolder = seedFolder(t.db, ordinaryRoot, "/ordinary");
    const ordinaryId = seedMedia(t.db, ordinaryFolder, ordinaryRoot);
    const appleRoot = seedScanRoot(t.db, "/apple.photoslibrary");
    t.db.prepare("UPDATE scan_roots SET kind = 'apple-photos' WHERE id = ?").run(appleRoot);
    const appleFolder = seedFolder(t.db, appleRoot, "/apple.photoslibrary");
    const appleId = seedMedia(t.db, appleFolder, appleRoot);
    t.db.prepare("UPDATE media SET source_kind = 'apple-photos' WHERE id = ?").run(appleId);
    const thumb = thumbnailPathForMediaId(t.ctx.paths.thumbnailsDir, appleId);
    fs.mkdirSync(path.dirname(thumb), { recursive: true });
    fs.writeFileSync(thumb, "private-photo-bytes");
    try {
      const get = (url: string) => t.app.inject({ method: "GET", url, headers: { cookie: t.cookie } });
      const list = (await get("/api/media")).json();
      expect(list.items.map((item: { id: number }) => item.id)).toContain(ordinaryId);
      expect(list.items.map((item: { id: number }) => item.id)).not.toContain(appleId);
      expect((await get(`/api/media/${appleId}`)).statusCode).toBe(404);
      expect((await get(`/api/media/${appleId}/thumbnail`)).statusCode).toBe(404);
      expect((await get(`/api/media/${appleId}/file`)).statusCode).toBe(404);
      const search = (await get("/api/search?q=apple")).json();
      expect(search.items.some((item: { type: string; folder?: { id: number } }) => item.type === "folder" && item.folder?.id === appleFolder)).toBe(false);
      const ignored = await t.app.inject({ method: "POST", url: `/api/folders/${appleFolder}/ignore`, headers: { cookie: t.cookie } });
      expect(ignored.statusCode).toBe(409);
      expect(t.db.prepare("SELECT id FROM media WHERE id = ?").get(appleId)).toEqual({ id: appleId });
    } finally {
      await t.close();
    }
  });
});
