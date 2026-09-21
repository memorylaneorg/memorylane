import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { computeFingerprint } from "../../scanner/fingerprint.js";
import { classifyExtension } from "../../scanner/media-types.js";
import { getOrCreateFolder } from "../../scanner/folder-repo.js";
import { AnalysisRepo } from "../../analysis/analysis-repo.js";
import { TagRepo } from "../../tags/tag-repo.js";

export interface AppleCatalogAsset {
  uuid: string;
  original_filename: string | null;
  original_path: string | null;
  derivative_path: string | null;
  original_available: boolean;
  date: string | null;
  title: string | null;
  description: string | null;
  keywords: string[];
  favorite: boolean;
  hidden: boolean;
  in_trash: boolean;
  screenshot?: boolean;
  latitude: number | null;
  longitude: number | null;
  faces: { name: string; x: number; y: number; w: number; h: number }[];
  exif?: {
    camera_make: string | null; camera_model: string | null; lens_model: string | null;
    focal_length: number | null; aperture: number | null; iso: number | null; shutter_speed: number | null;
  } | null;
}

interface RootRow { path: string; kind: string }
interface ExistingAsset { media_id: number | null; catalog_date: string | null; is_screenshot: number }
interface ExistingMedia { absolute_path: string; fingerprint: string; thumbnail_status: string; captured_date: string | null }
export interface AppleUpsertResult { mediaId: number | null; changed: boolean; preserveCapturedDate: boolean; preservedCapturedDate: string | null }

function availablePath(rootPath: string, candidate: string | null): string | null {
  if (!candidate) return null;
  try {
    const realRoot = fs.realpathSync(rootPath);
    const realCandidate = fs.realpathSync(candidate);
    if (!realCandidate.startsWith(realRoot + path.sep)) return null;
    if (!fs.statSync(realCandidate).isFile()) return null;
    return realCandidate;
  } catch {
    return null;
  }
}

export function upsertAppleAsset(
  db: Database.Database,
  scanRootId: number,
  asset: AppleCatalogAsset,
  syncToken: string | null = null,
): AppleUpsertResult {
  const root = db.prepare("SELECT path, kind FROM scan_roots WHERE id = ?").get(scanRootId) as RootRow | undefined;
  if (!root || root.kind !== "apple-photos") throw new Error("Apple Photos scan root not found");
  if (!asset.uuid || !asset.original_filename) throw new Error("Invalid Apple Photos asset identity");

  const original = availablePath(root.path, asset.original_path);
  const derivativeCandidate = availablePath(root.path, asset.derivative_path);
  const originalType = classifyExtension(path.extname(asset.original_filename).slice(1).toLowerCase());
  const derivativeType = derivativeCandidate ? classifyExtension(path.extname(derivativeCandidate).slice(1).toLowerCase()) : null;
  const derivative = derivativeCandidate && (derivativeType === originalType || (originalType === "raw" && derivativeType === "image"))
    ? derivativeCandidate : null;
  const chosen = original ?? derivative;
  const existing = db.prepare("SELECT media_id, catalog_date, is_screenshot FROM apple_photos_assets WHERE scan_root_id = ? AND uuid = ?")
    .get(scanRootId, asset.uuid) as ExistingAsset | undefined;
  const isScreenshot = asset.screenshot ?? (existing?.is_screenshot === 1);

  return db.transaction(() => {
    let mediaId = existing?.media_id ?? null;
    let changed = false;
    let preserveCapturedDate = false;
    let preservedCapturedDate: string | null = null;
    if (chosen && !asset.hidden && !asset.in_trash) {
      const stat = fs.statSync(chosen);
      const extension = path.extname(chosen).slice(1).toLowerCase();
      const mediaType = classifyExtension(extension);
      if (!mediaType) throw new Error(`Unsupported Apple Photos media type: ${extension}`);
      const fingerprint = computeFingerprint(stat.size, stat.mtimeMs);
      const folder = getOrCreateFolder(db, scanRootId, null, path.basename(root.path), root.path);
      const filename = asset.original_filename;
      if (mediaId === null) {
        const inserted = db.prepare(`INSERT INTO media
          (parent_folder_id, scan_root_id, absolute_path, filename, extension, media_type,
           file_size, fs_created_at, fs_modified_at, fingerprint, thumbnail_status, status,
           source_kind, original_available, captured_date, gps_lat, gps_lon)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'active', 'apple-photos', ?, ?, ?, ?)`)
          .run(folder.id, scanRootId, chosen, filename, extension, mediaType, stat.size,
            stat.birthtime.toISOString(), stat.mtime.toISOString(), fingerprint,
            original ? 1 : 0, asset.date, asset.latitude, asset.longitude);
        mediaId = Number(inserted.lastInsertRowid);
        changed = true;
      } else {
        const prior = db.prepare("SELECT absolute_path, fingerprint, thumbnail_status, captured_date FROM media WHERE id = ?")
          .get(mediaId) as ExistingMedia | undefined;
        preserveCapturedDate = existing?.catalog_date !== null && existing?.catalog_date !== undefined
          && !!prior && prior.captured_date !== existing.catalog_date;
        preservedCapturedDate = preserveCapturedDate ? prior!.captured_date : null;
        const inputChanged = !prior || prior.absolute_path !== chosen || prior.fingerprint !== fingerprint;
        changed = inputChanged || prior?.thumbnail_status !== "done";
        db.prepare(`UPDATE media SET absolute_path = ?, filename = ?, extension = ?, media_type = ?,
          file_size = ?, fs_modified_at = ?, fingerprint = ?, source_kind = 'apple-photos',
          original_available = ?, captured_date = CASE WHEN ? THEN captured_date ELSE COALESCE(?, captured_date) END,
          gps_lat = COALESCE(gps_lat, ?), gps_lon = COALESCE(gps_lon, ?),
          thumbnail_status = CASE WHEN ? THEN 'pending' ELSE thumbnail_status END,
          status = 'active', last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
          .run(chosen, filename, extension, mediaType, stat.size, stat.mtime.toISOString(), fingerprint,
            original ? 1 : 0, preserveCapturedDate ? 1 : 0, asset.date, asset.latitude, asset.longitude, changed ? 1 : 0, mediaId);
        if (inputChanged) new AnalysisRepo(db).resetForMedia(mediaId);
      }
      if (asset.favorite) {
        db.prepare(`INSERT INTO media_engagement (media_id, favorite, favorited_at) VALUES (?, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          ON CONFLICT(media_id) DO UPDATE SET favorite = 1, favorited_at = COALESCE(media_engagement.favorited_at, excluded.favorited_at)`)
          .run(mediaId);
      }
    } else if (mediaId !== null) {
      db.prepare("UPDATE media SET status = 'missing' WHERE id = ?").run(mediaId);
    }

    db.prepare(`INSERT INTO apple_photos_assets
      (scan_root_id, uuid, media_id, original_filename, original_path, derivative_path,
       title, description, keywords_json, faces_json, favorite, hidden, in_trash, original_available, last_seen_sync_token, catalog_date,
       catalog_gps_lat, catalog_gps_lon, is_screenshot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scan_root_id, uuid) DO UPDATE SET
        media_id = excluded.media_id, original_filename = excluded.original_filename,
        original_path = excluded.original_path, derivative_path = excluded.derivative_path,
        title = excluded.title, description = excluded.description,
        keywords_json = excluded.keywords_json, faces_json = excluded.faces_json,
        favorite = excluded.favorite, hidden = excluded.hidden, in_trash = excluded.in_trash,
        original_available = excluded.original_available,
        last_seen_sync_token = excluded.last_seen_sync_token,
        catalog_date = excluded.catalog_date,
        catalog_gps_lat = excluded.catalog_gps_lat,
        catalog_gps_lon = excluded.catalog_gps_lon,
        is_screenshot = excluded.is_screenshot,
        synced_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
      .run(scanRootId, asset.uuid, mediaId, asset.original_filename, original, derivative,
        asset.title, asset.description, JSON.stringify(asset.keywords), JSON.stringify(asset.faces),
        asset.favorite ? 1 : 0, asset.hidden ? 1 : 0, asset.in_trash ? 1 : 0, original ? 1 : 0, syncToken, asset.date,
        asset.latitude, asset.longitude, isScreenshot ? 1 : 0);

    if (mediaId !== null && !asset.hidden && !asset.in_trash) {
      applyAppleMetadata(db, mediaId, asset, preserveCapturedDate, preservedCapturedDate);
      new TagRepo(db).replaceImported(mediaId, isScreenshot ? [...asset.keywords, "screenshot"] : asset.keywords);
    }

    return { mediaId, changed, preserveCapturedDate, preservedCapturedDate };
  })();
}

export function applyAppleMetadata(db: Database.Database, mediaId: number, asset: AppleCatalogAsset,
  preserveCapturedDate = false, preservedCapturedDate: string | null = null): void {
  const exif = asset.exif;
  db.prepare(`UPDATE media SET
    captured_date = CASE WHEN ? THEN ? ELSE COALESCE(?, captured_date) END,
    camera_make = COALESCE(camera_make, ?), camera_model = COALESCE(camera_model, ?),
    lens_model = COALESCE(lens_model, ?), focal_length = COALESCE(focal_length, ?),
    aperture = COALESCE(aperture, ?), iso = COALESCE(iso, ?),
    shutter_speed = COALESCE(shutter_speed, ?), gps_lat = COALESCE(gps_lat, ?), gps_lon = COALESCE(gps_lon, ?)
    WHERE id = ?`)
    .run(preserveCapturedDate ? 1 : 0, preservedCapturedDate, asset.date,
      exif?.camera_make ?? null, exif?.camera_model ?? null, exif?.lens_model ?? null,
      exif?.focal_length ?? null, exif?.aperture ?? null, exif?.iso ?? null,
      exif?.shutter_speed === null || exif?.shutter_speed === undefined ? null : String(exif.shutter_speed),
      asset.latitude, asset.longitude, mediaId);

  const captured = asset.date?.replace(/(Z|[+-]\d\d:\d\d)$/, "") ?? null;
  const offset = asset.date?.match(/([+-]\d\d:\d\d)$/)?.[1] ?? null;
  db.prepare(`INSERT INTO media_exif
    (media_id, captured_at_precise, captured_tz_offset, camera_make, camera_model, lens_id,
     focal_length, aperture, iso, shutter_speed_s, keywords_json, gps_lat, gps_lon,
     tags_json, exiftool_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 'photos-catalog')
    ON CONFLICT(media_id) DO UPDATE SET
      captured_at_precise = COALESCE(excluded.captured_at_precise, media_exif.captured_at_precise),
      captured_tz_offset = COALESCE(excluded.captured_tz_offset, media_exif.captured_tz_offset),
      camera_make = COALESCE(media_exif.camera_make, excluded.camera_make),
      camera_model = COALESCE(media_exif.camera_model, excluded.camera_model),
      lens_id = COALESCE(media_exif.lens_id, excluded.lens_id),
      focal_length = COALESCE(media_exif.focal_length, excluded.focal_length),
      aperture = COALESCE(media_exif.aperture, excluded.aperture),
      iso = COALESCE(media_exif.iso, excluded.iso),
      shutter_speed_s = COALESCE(media_exif.shutter_speed_s, excluded.shutter_speed_s),
      keywords_json = CASE WHEN excluded.keywords_json != '[]' THEN excluded.keywords_json ELSE media_exif.keywords_json END,
      gps_lat = COALESCE(media_exif.gps_lat, excluded.gps_lat),
      gps_lon = COALESCE(media_exif.gps_lon, excluded.gps_lon)`)
    .run(mediaId, captured, offset, exif?.camera_make ?? null, exif?.camera_model ?? null,
      exif?.lens_model ?? null, exif?.focal_length ?? null, exif?.aperture ?? null, exif?.iso ?? null,
      exif?.shutter_speed ?? null, JSON.stringify(asset.keywords), asset.latitude, asset.longitude);
}

export interface CatalogPage {
  assets: AppleCatalogAsset[];
  failures?: { uuid: string; error: string }[];
  next_cursor: number | null;
  total: number;
}

// Queue scans of the accumulated Apple rows occasionally during large Sync Now
// runs; a per-item kick would rescan the analysis queue thousands of times.
export function shouldKickAppleAnalysis(processed: number): boolean {
  return processed > 0 && processed % 250 === 0;
}

export async function findAppleCatalogAsset(
  fetchPage: (cursor: number) => Promise<CatalogPage>, uuid: string,
): Promise<AppleCatalogAsset | null> {
  let cursor = 0;
  while (true) {
    const page = await fetchPage(cursor);
    const found = page.assets.find((asset) => asset.uuid === uuid);
    if (found) return found;
    if (page.next_cursor === null) return null;
    if (page.next_cursor <= cursor) throw new Error("Apple Photos helper returned a non-advancing cursor");
    cursor = page.next_cursor;
  }
}

export async function syncAppleRoot(
  db: Database.Database,
  scanRootId: number,
  fetchPage: (cursor: number) => Promise<CatalogPage>,
  isEnabled: () => boolean,
  onAsset: (result: AppleUpsertResult, asset: AppleCatalogAsset) => Promise<void> = async () => {},
  onProgress: (processed: number, total: number) => void = () => {},
  onAssetError: (error: Error, asset: Pick<AppleCatalogAsset, "uuid">) => void = () => {},
): Promise<{ processed: number; total: number; cancelled: boolean; failed: number }> {
  let cursor = 0;
  let processed = 0;
  let total = 0;
  let failed = 0;
  const syncToken = randomUUID();
  while (true) {
    if (!isEnabled()) return { processed, total, cancelled: true, failed };
    const page = await fetchPage(cursor);
    total = page.total;
    for (const failure of page.failures ?? []) {
      failed++;
      processed++;
      onAssetError(new Error(failure.error), { uuid: failure.uuid });
      onProgress(processed, total);
    }
    for (const asset of page.assets) {
      if (!isEnabled()) return { processed, total, cancelled: true, failed };
      try {
        const result = upsertAppleAsset(db, scanRootId, asset, syncToken);
        await onAsset(result, asset);
      } catch (error) {
        failed++;
        onAssetError(error instanceof Error ? error : new Error(String(error)), asset);
      }
      processed++;
      onProgress(processed, total);
    }
    if (page.next_cursor === null) {
      if (!isEnabled()) return { processed, total, cancelled: true, failed };
      if (failed === 0) db.prepare(`UPDATE media SET status = 'missing' WHERE id IN (
        SELECT media_id FROM apple_photos_assets WHERE scan_root_id = ? AND media_id IS NOT NULL
          AND (last_seen_sync_token IS NULL OR last_seen_sync_token != ?))`).run(scanRootId, syncToken);
      return { processed, total, cancelled: false, failed };
    }
    if (page.next_cursor <= cursor) throw new Error("Apple Photos helper returned a non-advancing cursor");
    cursor = page.next_cursor;
  }
}
