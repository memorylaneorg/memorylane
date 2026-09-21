import { describe, it, expect } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb, seedScanRoot, seedFolder, seedMedia } from "../helpers/db.js";
import { buildMediaQuery, mediaSelectSql, mediaCountSql, type MediaQueryParams } from "../../src/query/media-query.js";

function run(db: Database.Database, p: MediaQueryParams, orderBy?: string): number[] {
  const q = buildMediaQuery(p);
  return (db.prepare(mediaSelectSql(q, orderBy)).all(...q.bindings, 100, 0) as { id: number }[]).map((r) => r.id).sort((a, b) => a - b);
}
function count(db: Database.Database, p: MediaQueryParams): number {
  const q = buildMediaQuery(p);
  return (db.prepare(mediaCountSql(q)).get(...q.bindings) as { c: number }).c;
}

async function library() {
  const db = await createTestDb();
  const root = seedScanRoot(db);
  const root2 = seedScanRoot(db, "/other");
  const top = seedFolder(db, root, "/library");
  const sub = seedFolder(db, root, "/library/sub", top);
  const other = seedFolder(db, root2, "/other");
  const jpg = seedMedia(db, top, root, { filename: "a.jpg" });
  const raw = seedMedia(db, top, root, { filename: "a.cr3", media_type: "raw" });
  const video = seedMedia(db, top, root, { filename: "v.mp4", media_type: "video" });
  const live = seedMedia(db, top, root, { filename: "live.mov", media_type: "video" });
  const missing = seedMedia(db, top, root, { filename: "gone.jpg", status: "missing" });
  const pendingThumb = seedMedia(db, sub, root, { filename: "sub.jpg", thumbnail_status: "pending" });
  const otherRoot = seedMedia(db, other, root2, { filename: "o.jpg" });
  db.prepare("UPDATE media SET raw_pair_id = ? WHERE id = ?").run(raw, jpg);
  db.prepare("UPDATE media SET live_photo_video_id = ? WHERE id = ?").run(live, jpg);
  return { db, root, root2, top, sub, jpg, raw, video, live, missing, pendingThumb, otherRoot };
}

describe("buildMediaQuery", () => {
  it("defaults: active media, companions hidden, all roots", async () => {
    const L = await library();
    expect(run(L.db, {})).toEqual([L.jpg, L.video, L.pendingThumb, L.otherRoot].sort((a, b) => a - b));
    expect(count(L.db, {})).toBe(4);
  });

  it("includeCompanions shows the paired RAW and Live Photo video", async () => {
    const L = await library();
    expect(run(L.db, { includeCompanions: true })).toContain(L.raw);
    expect(run(L.db, { includeCompanions: true })).toContain(L.live);
  });

  it("scopes to a folder, recursively or not, and to a scan root or id list", async () => {
    const L = await library();
    expect(run(L.db, { scope: { kind: "folder", folderId: L.top, recursive: false } })).toEqual([L.jpg, L.video]);
    expect(run(L.db, { scope: { kind: "folder", folderId: L.top, recursive: true } })).toEqual([L.jpg, L.video, L.pendingThumb]);
    expect(run(L.db, { scope: { kind: "scanRoot", scanRootId: L.root2 } })).toEqual([L.otherRoot]);
    expect(run(L.db, { scope: { kind: "ids", ids: [L.jpg, L.missing] } })).toEqual([L.jpg]);
    expect(run(L.db, { scope: { kind: "ids", ids: [] } })).toEqual([]);
  });

  it("filters by type and thumbnail status", async () => {
    const L = await library();
    expect(run(L.db, { type: "photo" })).toEqual([L.jpg, L.pendingThumb, L.otherRoot]);
    expect(run(L.db, { type: "video" })).toEqual([L.video]);
    expect(run(L.db, { thumbnailDone: true })).toEqual([L.jpg, L.video, L.otherRoot]);
  });

  it("filters people through the person index without duplicating photos with multiple faces", async () => {
    const L = await library();
    const personId = Number(L.db.prepare("INSERT INTO persons (auto_label) VALUES ('Person 1')").run().lastInsertRowid);
    const insertFace = L.db.prepare(
      `INSERT INTO faces (media_id, model, bbox_x, bbox_y, bbox_w, bbox_h, det_score, quality, embedding, person_id)
       VALUES (?, 'test', 0, 0, 0.2, 0.2, 0.9, 0.9, zeroblob(32), ?)`,
    );
    insertFace.run(L.jpg, personId);
    insertFace.run(L.jpg, personId);
    insertFace.run(L.otherRoot, personId);
    insertFace.run(L.raw, personId); // companion stays hidden by default

    const params = { personIds: [personId] };
    expect(run(L.db, params)).toEqual([L.jpg, L.otherRoot]);
    expect(count(L.db, params)).toBe(2);
    const q = buildMediaQuery(params);
    const plan = L.db.prepare(`EXPLAIN QUERY PLAN ${mediaCountSql(q)}`).all(...q.bindings) as { detail: string }[];
    expect(plan.some((step) => step.detail.includes("CORRELATED"))).toBe(false);
  });

  it("favoritesOnly joins media_engagement", async () => {
    const L = await library();
    L.db.prepare("INSERT INTO media_engagement (media_id, favorite, favorited_at) VALUES (?, 1, '2024-01-01')").run(L.video);
    expect(run(L.db, { favoritesOnly: true }, "me.favorited_at DESC")).toEqual([L.video]);
  });

  it("EXIF filters join media_exif and combine with AND", async () => {
    const L = await library();
    const ins = L.db.prepare(
      `INSERT INTO media_exif (media_id, lens_id, camera_model, camera_make, aperture, iso, focal_length, captured_at_precise, tags_json, exiftool_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', 't')`,
    );
    ins.run(L.jpg, "RF 100-500", "Canon EOS R5", "Canon", 7.1, 3200, 500, "2024-05-12T10:31:44.250");
    ins.run(L.otherRoot, "EF 50", "Canon EOS R5", "Canon", 1.8, 100, 50, "2019-06-01T12:00:00.000");
    expect(run(L.db, { exif: { lens: "RF 100-500" } })).toEqual([L.jpg]);
    expect(run(L.db, { exif: { camera: "Canon EOS R5" } })).toEqual([L.jpg, L.otherRoot]);
    expect(run(L.db, { exif: { apertureMax: 2 } })).toEqual([L.otherRoot]);
    expect(run(L.db, { exif: { isoMin: 1000 } })).toEqual([L.jpg]);
    expect(run(L.db, { exif: { focalMin: 36, focalMax: 50 } })).toEqual([L.otherRoot]);
    expect(run(L.db, { exif: { year: 2019 } })).toEqual([L.otherRoot]);
    expect(run(L.db, { exif: { from: "2024-01-01", to: "2024-12-31" } })).toEqual([L.jpg]);
    expect(run(L.db, { exif: { camera: "Canon EOS R5", isoMin: 1000 } })).toEqual([L.jpg]);
    // requireExifJoin without filters still restricts to rows with EXIF
    expect(run(L.db, { requireExifJoin: true })).toEqual([L.jpg, L.otherRoot]);
  });

  it("collapseStacks hides non-cover members", async () => {
    const L = await library();
    const s = L.db
      .prepare("INSERT INTO stacks (kind, cover_media_id, parent_folder_id) VALUES ('burst', ?, ?)")
      .run(L.jpg, L.top).lastInsertRowid;
    L.db.prepare("INSERT INTO stack_members (stack_id, media_id, position) VALUES (?, ?, 0), (?, ?, 1)").run(s, L.jpg, s, L.video);
    expect(run(L.db, { collapseStacks: true, scope: { kind: "folder", folderId: L.top, recursive: false } })).toEqual([L.jpg]);
    expect(run(L.db, { scope: { kind: "folder", folderId: L.top, recursive: false } })).toEqual([L.jpg, L.video]);
  });
});
