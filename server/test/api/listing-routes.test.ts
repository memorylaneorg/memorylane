import { describe, it, expect } from "vitest";
import { createTestApp } from "../helpers/app.js";
import { seedScanRoot, seedFolder, seedMedia } from "../helpers/db.js";

async function seeded() {
  const t = await createTestApp();
  const root = seedScanRoot(t.db);
  const top = seedFolder(t.db, root, "/library");
  const sub = seedFolder(t.db, root, "/library/sub", top);
  const jpg = seedMedia(t.db, top, root, { filename: "a.jpg", captured_date: "2020-01-01T00:00:00.000Z" });
  const raw = seedMedia(t.db, top, root, { filename: "a.cr3", media_type: "raw" });
  const video = seedMedia(t.db, top, root, { filename: "v.mp4", media_type: "video" });
  const subJpg = seedMedia(t.db, sub, root, { filename: "b.jpg" });
  t.db.prepare("UPDATE media SET raw_pair_id = ? WHERE id = ?").run(raw, jpg);
  t.db.prepare("INSERT INTO media_engagement (media_id, favorite, favorited_at) VALUES (?, 1, '2024-01-01')").run(subJpg);
  return { t, root, top, sub, jpg, raw, video, subJpg };
}

const get = (t: Awaited<ReturnType<typeof createTestApp>>, url: string) =>
  t.app.inject({ method: "GET", url, headers: { cookie: t.cookie } });

describe("listing routes on the query builder", () => {
  it("fills a short direct folder hover preview with ready descendant photos", async () => {
    const t = await createTestApp();
    try {
      const root = seedScanRoot(t.db);
      const top = seedFolder(t.db, root, "/library");
      const sub = seedFolder(t.db, root, "/library/sub", top);
      const direct = seedMedia(t.db, top, root, { filename: "direct.jpg" });
      seedMedia(t.db, top, root, { filename: "pending.jpg", thumbnail_status: "pending" });
      seedMedia(t.db, top, root, { filename: "clip.mp4", media_type: "video" });
      const nested = seedMedia(t.db, sub, root, { filename: "nested.jpg" });
      const response = await get(t, `/api/folders/${top}/preview`);
      expect(response.statusCode).toBe(200);
      expect(response.json().items.map((item: { id: number }) => item.id)).toEqual([direct, nested]);
    } finally { await t.close(); }
  });

  it("previews descendant photos when a folder has no direct photos", async () => {
    const t = await createTestApp();
    try {
      const root = seedScanRoot(t.db);
      const top = seedFolder(t.db, root, "/library");
      const sub = seedFolder(t.db, root, "/library/sub", top);
      const deeper = seedFolder(t.db, root, "/library/sub/deeper", sub);
      const first = seedMedia(t.db, sub, root, { filename: "first.jpg" });
      const second = seedMedia(t.db, deeper, root, { filename: "second.jpg" });
      seedMedia(t.db, sub, root, { filename: "pending.jpg", thumbnail_status: "pending" });
      seedMedia(t.db, deeper, root, { filename: "clip.mp4", media_type: "video" });

      const response = await get(t, `/api/folders/${top}/preview`);
      expect(response.statusCode).toBe(200);
      expect(response.json().items.map((item: { id: number }) => item.id)).toEqual([second, first]);
    } finally { await t.close(); }
  });

  it("folder cards retain subtree totals and exclude companions from fallback covers", async () => {
    const t = await createTestApp();
    try {
      const root = seedScanRoot(t.db);
      const top = seedFolder(t.db, root, "/library");
      const sub = seedFolder(t.db, root, "/library/sub", top);
      const jpg = seedMedia(t.db, sub, root);
      const raw = seedMedia(t.db, sub, root, { media_type: "raw" });
      const video = seedMedia(t.db, sub, root, { media_type: "video" });
      seedMedia(t.db, sub, root, { status: "missing" });
      seedMedia(t.db, sub, root, { thumbnail_status: "pending" });
      t.db.prepare("UPDATE media SET raw_pair_id = ?, live_photo_video_id = ? WHERE id = ?").run(raw, video, jpg);
      t.db.exec("ANALYZE media; ANALYZE folders;");
      const response = await get(t, "/api/folders");
      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveLength(1);
      expect(response.json()[0]).toMatchObject({
        id: top, mediaCount: 0, childFolderCount: 1,
        recursiveMediaCount: 4, recursiveSizeBytes: 4000, thumbnailMediaId: jpg,
      });
    } finally {
      await t.close();
    }
  });

  it("folder media: direct, recursive, and type filter; paired RAW hidden", async () => {
    const S = await seeded();
    try {
      let r = await get(S.t, `/api/folders/${S.top}/media`);
      expect(r.json().items.map((m: { id: number }) => m.id)).toEqual([S.jpg, S.video]);
      expect(r.json().total).toBe(2);
      r = await get(S.t, `/api/folders/${S.top}/media?recursive=true`);
      expect(r.json().total).toBe(3);
      r = await get(S.t, `/api/folders/${S.top}/media?recursive=true&type=video`);
      expect(r.json().items.map((m: { id: number }) => m.id)).toEqual([S.video]);
    } finally {
      await S.t.close();
    }
  });

  it("favorites lists only favorited, active, non-companion media", async () => {
    const S = await seeded();
    try {
      const r = await get(S.t, "/api/favorites");
      expect(r.json().items.map((m: { id: number }) => m.id)).toEqual([S.subJpg]);
      expect(r.json().items[0].favorite).toBe(true);
    } finally {
      await S.t.close();
    }
  });

  it("search finds media by filename and hides companions", async () => {
    const S = await seeded();
    try {
      const r = await get(S.t, "/api/search?q=a");
      const mediaIds = r
        .json()
        .items.filter((i: { type: string }) => i.type === "media")
        .map((i: { media: { id: number } }) => i.media.id);
      expect(mediaIds).toContain(S.jpg);
      expect(mediaIds).not.toContain(S.raw);
    } finally {
      await S.t.close();
    }
  });

  it("home summary hero and random memories pick only photos with thumbnails", async () => {
    const S = await seeded();
    try {
      const home = await get(S.t, "/api/home/summary");
      expect([S.jpg, S.subJpg]).toContain(home.json().heroMedia.id);
      const rnd = await get(S.t, "/api/memories/random?count=10");
      const ids = rnd.json().items.map((m: { id: number }) => m.id).sort();
      expect(ids).toEqual([S.jpg, S.subJpg].sort());
    } finally {
      await S.t.close();
    }
  });
});
