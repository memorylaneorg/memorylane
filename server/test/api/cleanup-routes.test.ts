import { expect, it } from "vitest";
import { createTestApp } from "../helpers/app.js";
import { seedFolder, seedMedia, seedScanRoot } from "../helpers/db.js";
import fs from "node:fs";
import path from "node:path";
import { thumbnailPathForMediaId } from "../../src/config/paths.js";

it("marks visible media, hides it from folders, and restores it on unmark", async () => {
  const t = await createTestApp();
  try {
    const root = seedScanRoot(t.db);
    const folder = seedFolder(t.db, root, "/library");
    const id = seedMedia(t.db, folder, root);
    const headers = { cookie: t.cookie };
    const mark = await t.app.inject({ method: "POST", url: "/api/cleanup/marks", headers,
      payload: { mediaIds: [id] } });
    expect(mark.statusCode).toBe(200);
    const normal = await t.app.inject({ method: "GET", url: `/api/folders/${folder}/media`, headers });
    expect(normal.json().items).toEqual([]);
    const folderDetail = await t.app.inject({ method: "GET", url: `/api/folders/${folder}`, headers });
    expect(folderDetail.json().folder.mediaCount).toBe(0);
    const home = await t.app.inject({ method: "GET", url: "/api/home/summary", headers });
    expect(home.json().mediaCount).toBe(0);
    const roots = await t.app.inject({ method: "GET", url: "/api/scan-roots", headers });
    expect(roots.json()[0].stats.mediaCount).toBe(0);
    const review = await t.app.inject({ method: "GET", url: "/api/cleanup/marks", headers });
    expect(review.json().total).toBe(1);
    expect(review.json().items[0].media.id).toBe(id);
    t.db.prepare("UPDATE media SET status = 'missing' WHERE id = ?").run(id);
    const missingReview = await t.app.inject({ method: "GET", url: "/api/cleanup/marks", headers });
    expect(missingReview.json().items.map((item: { media: { id: number } }) => item.media.id)).toEqual([id]);
    const thumbnail = thumbnailPathForMediaId(t.ctx.paths.thumbnailsDir, id);
    fs.mkdirSync(path.dirname(thumbnail), { recursive: true });
    fs.writeFileSync(thumbnail, "cached thumbnail");
    expect((await t.app.inject({ method: "GET", url: `/api/media/${id}/thumbnail`, headers })).statusCode).toBe(200);
    const unmark = await t.app.inject({ method: "DELETE", url: `/api/cleanup/marks/${id}`, headers });
    expect(unmark.statusCode).toBe(200);
    t.db.prepare("UPDATE media SET status = 'active' WHERE id = ?").run(id);
    const again = await t.app.inject({ method: "GET", url: `/api/folders/${folder}/media`, headers });
    expect(again.json().items.map((m: { id: number }) => m.id)).toEqual([id]);
  } finally { await t.close(); }
});

it("rejects companions and oversized mark batches", async () => {
  const t = await createTestApp();
  try {
    const root = seedScanRoot(t.db);
    const folder = seedFolder(t.db, root, "/library");
    const jpg = seedMedia(t.db, folder, root);
    const raw = seedMedia(t.db, folder, root, { media_type: "raw" });
    t.db.prepare("UPDATE media SET raw_pair_id = ? WHERE id = ?").run(raw, jpg);
    const headers = { cookie: t.cookie };
    const companion = await t.app.inject({ method: "POST", url: "/api/cleanup/marks", headers, payload: { mediaIds: [raw] } });
    expect(companion.statusCode).toBe(400);
    const oversized = await t.app.inject({ method: "POST", url: "/api/cleanup/marks", headers,
      payload: { mediaIds: Array.from({ length: 201 }, (_, i) => i + 1) } });
    expect(oversized.statusCode).toBe(400);
  } finally { await t.close(); }
});

it("keeps an unmarked burst member visible when its cover is marked", async () => {
  const t = await createTestApp();
  try {
    const root = seedScanRoot(t.db);
    const folder = seedFolder(t.db, root, "/library");
    const cover = seedMedia(t.db, folder, root);
    const other = seedMedia(t.db, folder, root);
    const stackId = Number(t.db.prepare("INSERT INTO stacks (kind, cover_media_id, parent_folder_id, user_modified) VALUES ('manual', ?, ?, 1)").run(cover, folder).lastInsertRowid);
    t.db.prepare("INSERT INTO stack_members (stack_id, media_id, position) VALUES (?, ?, ?)").run(stackId, cover, 0);
    t.db.prepare("INSERT INTO stack_members (stack_id, media_id, position) VALUES (?, ?, ?)").run(stackId, other, 1);
    const headers = { cookie: t.cookie };
    expect((await t.app.inject({ method: "POST", url: "/api/cleanup/marks", headers, payload: { mediaIds: [cover] } })).statusCode).toBe(200);
    const listing = await t.app.inject({ method: "GET", url: `/api/folders/${folder}/media`, headers });
    expect(listing.json().items.map((item: { id: number }) => item.id)).toEqual([other]);
    expect(listing.json().items[0].stack.isCover).toBe(true);
    const detail = await t.app.inject({ method: "GET", url: `/api/stacks/${stackId}`, headers });
    expect(detail.json().items.map((item: { id: number }) => item.id)).toEqual([other]);
    await t.app.inject({ method: "DELETE", url: `/api/cleanup/marks/${cover}`, headers });
    const restored = await t.app.inject({ method: "GET", url: `/api/folders/${folder}/media`, headers });
    expect(restored.json().items.map((item: { id: number }) => item.id)).toEqual([cover]);
  } finally { await t.close(); }
});

it("does not mark an Apple Photos item while the plugin is disabled", async () => {
  const t = await createTestApp();
  try {
    const root = Number(t.db.prepare("INSERT INTO scan_roots (path, kind, enabled) VALUES ('/Library.photoslibrary', 'apple-photos', 1)").run().lastInsertRowid);
    const folder = seedFolder(t.db, root, "/Library.photoslibrary");
    const id = seedMedia(t.db, folder, root);
    t.db.prepare("UPDATE media SET source_kind = 'apple-photos' WHERE id = ?").run(id);
    const result = await t.app.inject({ method: "POST", url: "/api/cleanup/marks", headers: { cookie: t.cookie }, payload: { mediaIds: [id] } });
    expect(result.statusCode).toBe(400);
    expect((t.db.prepare("SELECT COUNT(*) AS c FROM deletion_marks").get() as { c: number }).c).toBe(0);
  } finally { await t.close(); }
});

it("requires file restoration before a trashed item can be unmarked", async () => {
  const t = await createTestApp();
  try {
    const root = seedScanRoot(t.db);
    const folder = seedFolder(t.db, root, "/library");
    const id = seedMedia(t.db, folder, root);
    t.db.prepare("INSERT INTO deletion_marks (media_id) VALUES (?)").run(id);
    t.db.prepare("INSERT INTO trash_entries (media_id, status, files_json) VALUES (?, 'trashed', '[]')").run(id);
    const result = await t.app.inject({ method: "DELETE", url: `/api/cleanup/marks/${id}`, headers: { cookie: t.cookie } });
    expect(result.statusCode).toBe(409);
    expect((t.db.prepare("SELECT COUNT(*) AS c FROM deletion_marks WHERE media_id = ?").get(id) as { c: number }).c).toBe(1);
  } finally { await t.close(); }
});
