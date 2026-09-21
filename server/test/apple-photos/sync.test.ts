import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb } from "../helpers/db.js";
import { upsertAppleAsset, applyAppleMetadata, syncAppleRoot, findAppleCatalogAsset, shouldKickAppleAnalysis, type AppleCatalogAsset } from "../../src/plugins/apple-photos/sync.js";
import { AnalysisRepo } from "../../src/analysis/analysis-repo.js";
import { TagRepo } from "../../src/tags/tag-repo.js";
import { createImportedTagAnalyzer } from "../../src/analysis/analyzers/import-tags.js";

const baseAsset: AppleCatalogAsset = {
  uuid: "asset-1", original_filename: "Beach.JPG", original_path: null, derivative_path: null,
  original_available: false, date: "2020-06-01T12:00:00", title: "Beach", description: null,
  keywords: ["holiday"], favorite: true, hidden: false, in_trash: false,
  latitude: 10, longitude: 20, faces: [],
};

describe("Apple catalogue media mapping", () => {
  it("imports only catalog-confirmed screenshots and removes the tag when the flag clears", async () => {
    const db = await createTestDb();
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-apple-screenshot-"));
    const library = path.join(scratch, "Test.photoslibrary");
    const preview = path.join(library, "preview.png");
    fs.mkdirSync(library);
    fs.writeFileSync(preview, "preview");
    const root = Number(db.prepare("INSERT INTO scan_roots (path, enabled, kind) VALUES (?, 1, 'apple-photos')").run(library).lastInsertRowid);
    try {
      const first = upsertAppleAsset(db, root, { ...baseAsset, original_filename: "IMG_1234.PNG", derivative_path: preview, screenshot: true });
      const tags = new TagRepo(db);
      expect(tags.listForMedia(first.mediaId!).map(({ name, source }) => `${name}:${source}`))
        .toEqual(["holiday:imported", "screenshot:imported"]);
      await createImportedTagAnalyzer(db).run([{ id: first.mediaId!, parent_folder_id: 1, absolute_path: preview, media_type: "image" }]);
      expect(tags.listForMedia(first.mediaId!).map(({ name, source }) => `${name}:${source}`))
        .toEqual(["holiday:imported", "screenshot:imported"]);
      tags.addUser(first.mediaId!, "personal");
      upsertAppleAsset(db, root, { ...baseAsset, original_filename: "IMG_1234.PNG", derivative_path: preview });
      expect(tags.listForMedia(first.mediaId!).map(({ name, source }) => `${name}:${source}`))
        .toEqual(["holiday:imported", "personal:user", "screenshot:imported"]);
      upsertAppleAsset(db, root, { ...baseAsset, original_filename: "IMG_1234.PNG", derivative_path: preview, screenshot: false });
      expect(tags.listForMedia(first.mediaId!).map(({ name, source }) => `${name}:${source}`))
        .toEqual(["holiday:imported", "personal:user"]);
    } finally { db.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
  });

  it("refreshes imported tags when Photos keywords change without changing the image", async () => {
    const db = await createTestDb();
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-apple-tags-"));
    const library = path.join(scratch, "Test.photoslibrary");
    const preview = path.join(library, "preview.jpg");
    fs.mkdirSync(library);
    fs.writeFileSync(preview, "preview");
    const root = Number(db.prepare("INSERT INTO scan_roots (path, enabled, kind) VALUES (?, 1, 'apple-photos')").run(library).lastInsertRowid);
    try {
      const first = upsertAppleAsset(db, root, { ...baseAsset, derivative_path: preview });
      const tags = new TagRepo(db);
      tags.addUser(first.mediaId!, "personal");
      upsertAppleAsset(db, root, { ...baseAsset, derivative_path: preview, keywords: ["mountain"] });
      expect(tags.listForMedia(first.mediaId!).map(({ name, source }) => `${name}:${source}`))
        .toEqual(["mountain:imported", "personal:user"]);
    } finally { db.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
  });
  it("schedules bounded analysis catch-up during a long sync", () => {
    expect(shouldKickAppleAnalysis(1)).toBe(false);
    expect(shouldKickAppleAnalysis(249)).toBe(false);
    expect(shouldKickAppleAnalysis(250)).toBe(true);
    expect(shouldKickAppleAnalysis(251)).toBe(false);
  });
  it("finds one catalog asset across helper pages without mutating the library", async () => {
    const cursors: number[] = [];
    const found = await findAppleCatalogAsset(async (cursor) => {
      cursors.push(cursor);
      return cursor === 0
        ? { assets: [baseAsset], next_cursor: 1, total: 2 }
        : { assets: [{ ...baseAsset, uuid: "target" }], next_cursor: null, total: 2 };
    }, "target");
    expect(found?.uuid).toBe("target");
    expect(cursors).toEqual([0, 1]);
  });
  it("keeps one stable row as a preview-only asset gains a local original", async () => {
    const db = await createTestDb();
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-apple-sync-"));
    const library = path.join(scratch, "Test.photoslibrary");
    const preview = path.join(library, "resources", "derivatives", "preview.jpg");
    const original = path.join(library, "originals", "asset-1.jpg");
    fs.mkdirSync(path.dirname(preview), { recursive: true });
    fs.mkdirSync(path.dirname(original), { recursive: true });
    fs.writeFileSync(preview, "preview");
    const rootId = Number(db.prepare("INSERT INTO scan_roots (path, enabled, kind) VALUES (?, 1, 'apple-photos')").run(library).lastInsertRowid);
    try {
      const first = upsertAppleAsset(db, rootId, { ...baseAsset, derivative_path: preview });
      expect(first.mediaId).toBeGreaterThan(0);
      expect(first.changed).toBe(true);
      const analysis = new AnalysisRepo(db);
      analysis.markDone(first.mediaId!, "faces", "v1");
      db.prepare("UPDATE media SET thumbnail_status = 'done' WHERE id = ?").run(first.mediaId);
      const again = upsertAppleAsset(db, rootId, { ...baseAsset, derivative_path: preview });
      expect(again).toMatchObject({ mediaId: first.mediaId, changed: false });
      expect(db.prepare("SELECT status FROM media_analysis WHERE media_id = ? AND analyzer = 'faces'").get(first.mediaId)).toEqual({ status: "done" });
      fs.writeFileSync(original, "original-content");
      const upgraded = upsertAppleAsset(db, rootId, { ...baseAsset, original_path: original, original_available: true, derivative_path: preview });
      expect(upgraded).toMatchObject({ mediaId: first.mediaId, changed: true });
      expect(db.prepare("SELECT status FROM media_analysis WHERE media_id = ? AND analyzer = 'faces'").get(first.mediaId)).toEqual({ status: "pending" });
      expect(db.prepare("SELECT absolute_path, filename, original_available, source_kind, captured_date, gps_lat FROM media WHERE id = ?").get(first.mediaId)).toMatchObject({
        absolute_path: fs.realpathSync(original), filename: "Beach.JPG", original_available: 1, source_kind: "apple-photos", captured_date: "2020-06-01T12:00:00", gps_lat: 10,
      });
      expect((db.prepare("SELECT COUNT(*) AS c FROM media").get() as { c: number }).c).toBe(1);
      expect(db.prepare("SELECT derivative_path, keywords_json FROM apple_photos_assets WHERE media_id = ?").get(first.mediaId)).toEqual({
        derivative_path: fs.realpathSync(preview), keywords_json: '["holiday"]',
      });
    } finally {
      db.close();
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("retains unavailable provenance without inventing a media row", async () => {
    const db = await createTestDb();
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-apple-unavailable-"));
    const library = path.join(scratch, "Test.photoslibrary");
    fs.mkdirSync(library);
    const rootId = Number(db.prepare("INSERT INTO scan_roots (path, enabled, kind) VALUES (?, 1, 'apple-photos')").run(library).lastInsertRowid);
    try {
      expect(upsertAppleAsset(db, rootId, baseAsset)).toMatchObject({ mediaId: null, changed: false });
      expect((db.prepare("SELECT COUNT(*) AS c FROM media").get() as { c: number }).c).toBe(0);
      expect(db.prepare("SELECT uuid, catalog_date, catalog_gps_lat, catalog_gps_lon FROM apple_photos_assets WHERE scan_root_id = ?").get(rootId)).toEqual({
        uuid: "asset-1", catalog_date: "2020-06-01T12:00:00", catalog_gps_lat: 10, catalog_gps_lon: 20,
      });
      upsertAppleAsset(db, rootId, { ...baseAsset, latitude: 11, longitude: 21 });
      expect(db.prepare("SELECT catalog_gps_lat, catalog_gps_lon FROM apple_photos_assets WHERE scan_root_id = ?").get(rootId)).toEqual({
        catalog_gps_lat: 11, catalog_gps_lon: 21,
      });
    } finally {
      db.close();
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("stops at an asset boundary when the plugin is disabled mid-sync", async () => {
    const db = await createTestDb();
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-apple-cancel-"));
    const library = path.join(scratch, "Test.photoslibrary");
    fs.mkdirSync(library);
    const rootId = Number(db.prepare("INSERT INTO scan_roots (path, enabled, kind) VALUES (?, 1, 'apple-photos')").run(library).lastInsertRowid);
    let enabled = true;
    try {
      const result = await syncAppleRoot(db, rootId,
        async () => ({ assets: [baseAsset, { ...baseAsset, uuid: "asset-2" }], next_cursor: null, total: 2 }),
        () => enabled,
        async () => { enabled = false; });
      expect(result).toEqual({ processed: 1, total: 2, cancelled: true, failed: 0 });
      expect((db.prepare("SELECT COUNT(*) AS c FROM apple_photos_assets").get() as { c: number }).c).toBe(1);
    } finally {
      db.close();
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("does not reconcile missing assets if disabled during the final item", async () => {
    const db = await createTestDb();
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-apple-last-item-"));
    const library = path.join(scratch, "Test.photoslibrary");
    const preview = path.join(library, "resources", "preview.jpg");
    const nextPreview = path.join(library, "resources", "next.jpg");
    fs.mkdirSync(path.dirname(preview), { recursive: true });
    fs.writeFileSync(preview, "preview");
    fs.writeFileSync(nextPreview, "preview next");
    const rootId = Number(db.prepare("INSERT INTO scan_roots (path, enabled, kind) VALUES (?, 1, 'apple-photos')").run(library).lastInsertRowid);
    try {
      const old = upsertAppleAsset(db, rootId, { ...baseAsset, uuid: "old", derivative_path: preview });
      let enabled = true;
      const result = await syncAppleRoot(db, rootId,
        async () => ({ assets: [{ ...baseAsset, uuid: "new", derivative_path: nextPreview }], next_cursor: null, total: 1 }),
        () => enabled, async () => { enabled = false; });
      expect(result).toMatchObject({ cancelled: true, failed: 0 });
      expect(db.prepare("SELECT status FROM media WHERE id = ?").get(old.mediaId)).toEqual({ status: "active" });
    } finally { db.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
  });

  it("skips a broken catalogue item and continues with later assets", async () => {
    const db = await createTestDb();
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-apple-errors-"));
    const library = path.join(scratch, "Test.photoslibrary");
    fs.mkdirSync(library);
    const rootId = Number(db.prepare("INSERT INTO scan_roots (path, enabled, kind) VALUES (?, 1, 'apple-photos')").run(library).lastInsertRowid);
    const errors: string[] = [];
    try {
      const result = await syncAppleRoot(db, rootId,
        async () => ({ assets: [{ ...baseAsset, uuid: "" }, { ...baseAsset, uuid: "good" }], next_cursor: null, total: 2 }),
        () => true, async () => {}, () => {}, (error) => errors.push(error.message));
      expect(result).toEqual({ processed: 2, total: 2, cancelled: false, failed: 1 });
      expect(errors).toEqual(["Invalid Apple Photos asset identity"]);
      expect((db.prepare("SELECT COUNT(*) AS c FROM apple_photos_assets").get() as { c: number }).c).toBe(1);
    } finally { db.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
  });

  it("counts a helper-side mapping failure without abandoning the page", async () => {
    const db = await createTestDb();
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-apple-helper-error-"));
    const library = path.join(scratch, "Test.photoslibrary");
    fs.mkdirSync(library);
    const rootId = Number(db.prepare("INSERT INTO scan_roots (path, enabled, kind) VALUES (?, 1, 'apple-photos')").run(library).lastInsertRowid);
    try {
      const result = await syncAppleRoot(db, rootId, async () => ({ assets: [baseAsset], failures: [{ uuid: "broken", error: "bad photo metadata" }], next_cursor: null, total: 2 }), () => true);
      expect(result).toMatchObject({ processed: 2, failed: 1, cancelled: false });
      expect((db.prepare("SELECT COUNT(*) AS c FROM apple_photos_assets").get() as { c: number }).c).toBe(1);
    } finally { db.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
  });

  it("marks assets absent from a successful later catalogue as missing", async () => {
    const db = await createTestDb();
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-apple-reconcile-"));
    const library = path.join(scratch, "Test.photoslibrary");
    const preview = path.join(library, "resources", "preview.jpg");
    fs.mkdirSync(path.dirname(preview), { recursive: true });
    fs.writeFileSync(preview, "preview");
    const rootId = Number(db.prepare("INSERT INTO scan_roots (path, enabled, kind) VALUES (?, 1, 'apple-photos')").run(library).lastInsertRowid);
    try {
      const asset = { ...baseAsset, derivative_path: preview };
      await syncAppleRoot(db, rootId, async () => ({ assets: [asset], next_cursor: null, total: 1 }), () => true);
      const mediaId = (db.prepare("SELECT media_id FROM apple_photos_assets WHERE uuid = 'asset-1'").get() as { media_id: number }).media_id;
      await syncAppleRoot(db, rootId, async () => ({ assets: [], next_cursor: null, total: 0 }), () => true);
      expect(db.prepare("SELECT status FROM media WHERE id = ?").get(mediaId)).toEqual({ status: "missing" });
    } finally { db.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
  });

  it("restores Photos adjusted metadata after ordinary file processing", async () => {
    const db = await createTestDb();
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-apple-metadata-"));
    const library = path.join(scratch, "Test.photoslibrary");
    const preview = path.join(library, "resources", "derivatives", "preview.jpg");
    fs.mkdirSync(path.dirname(preview), { recursive: true });
    fs.writeFileSync(preview, "preview");
    const rootId = Number(db.prepare("INSERT INTO scan_roots (path, enabled, kind) VALUES (?, 1, 'apple-photos')").run(library).lastInsertRowid);
    try {
      const asset = { ...baseAsset, derivative_path: preview,
        exif: { camera_make: "Canon", camera_model: "R5", lens_model: "50mm", focal_length: 50, aperture: 1.8, iso: 400, shutter_speed: 0.01 } };
      const { mediaId } = upsertAppleAsset(db, rootId, asset);
      db.prepare("UPDATE media SET captured_date = NULL, camera_make = NULL, gps_lat = NULL WHERE id = ?").run(mediaId);
      applyAppleMetadata(db, mediaId!, asset);
      expect(db.prepare("SELECT captured_date, camera_make, gps_lat FROM media WHERE id = ?").get(mediaId))
        .toEqual({ captured_date: "2020-06-01T12:00:00", camera_make: "Canon", gps_lat: 10 });
      expect(db.prepare("SELECT captured_at_precise, camera_model, keywords_json FROM media_exif WHERE media_id = ?").get(mediaId))
        .toEqual({ captured_at_precise: "2020-06-01T12:00:00", camera_model: "R5", keywords_json: '["holiday"]' });
    } finally { db.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
  });

  it("does not replace a locally edited capture date on later Photos sync", async () => {
    const db = await createTestDb();
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-apple-edited-date-"));
    const library = path.join(scratch, "Test.photoslibrary");
    const preview = path.join(library, "resources", "preview.jpg");
    fs.mkdirSync(path.dirname(preview), { recursive: true });
    fs.writeFileSync(preview, "preview");
    const rootId = Number(db.prepare("INSERT INTO scan_roots (path, enabled, kind) VALUES (?, 1, 'apple-photos')").run(library).lastInsertRowid);
    try {
      const first = upsertAppleAsset(db, rootId, { ...baseAsset, derivative_path: preview });
      db.prepare("UPDATE media SET captured_date = '2019-01-01T00:00:00' WHERE id = ?").run(first.mediaId);
      const nextAsset = { ...baseAsset, derivative_path: preview, date: "2021-07-01T12:00:00" };
      const second = upsertAppleAsset(db, rootId, nextAsset);
      db.prepare("UPDATE media SET captured_date = '2020-06-01T12:00:00' WHERE id = ?").run(first.mediaId);
      applyAppleMetadata(db, second.mediaId!, nextAsset, second.preserveCapturedDate, second.preservedCapturedDate);
      expect(db.prepare("SELECT captured_date FROM media WHERE id = ?").get(first.mediaId))
        .toEqual({ captured_date: "2019-01-01T00:00:00" });
    } finally { db.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
  });

  it("keeps a deliberately cleared capture date null on resync", async () => {
    const db = await createTestDb();
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-apple-cleared-date-"));
    const library = path.join(scratch, "Test.photoslibrary");
    const preview = path.join(library, "resources", "preview.jpg");
    fs.mkdirSync(path.dirname(preview), { recursive: true });
    fs.writeFileSync(preview, "preview");
    const rootId = Number(db.prepare("INSERT INTO scan_roots (path, enabled, kind) VALUES (?, 1, 'apple-photos')").run(library).lastInsertRowid);
    try {
      const first = upsertAppleAsset(db, rootId, { ...baseAsset, derivative_path: preview });
      db.prepare("UPDATE media SET captured_date = NULL WHERE id = ?").run(first.mediaId);
      const second = upsertAppleAsset(db, rootId, { ...baseAsset, derivative_path: preview, date: "2021-01-01T00:00:00" });
      expect(db.prepare("SELECT captured_date FROM media WHERE id = ?").get(second.mediaId)).toEqual({ captured_date: null });
    } finally { db.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
  });
});
