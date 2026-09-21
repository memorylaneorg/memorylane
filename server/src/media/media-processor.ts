import path from "node:path";
import type Database from "better-sqlite3";
import type { Logger } from "pino";
import { thumbnailPathForMediaId, previewPathForMediaId, type AppPaths } from "../config/paths.js";
import { ExifRepo } from "../exif/exif-repo.js";
import { EXIF_PROMOTE_VERSION, parseLeadingNumber } from "../exif/promote.js";
import { AnalysisRepo } from "../analysis/analysis-repo.js";
import { EXIF_FULL_KEY } from "../analysis/analyzers/exif-full.js";
import { DeferredMediaToolCapabilities, type MediaToolCapabilities, type MetadataTags } from "../capabilities/media-tools.js";
import {
  generateThumbnailFromFile,
  generateThumbnailFromBuffer,
  generatePreviewFromBuffer,
  readImageDimensions,
} from "./thumbnail-generator.js";

export interface MediaRowForProcessing {
  id: number;
  parent_folder_id: number;
  absolute_path: string;
  media_type: "image" | "raw" | "video";
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function dateOrNull(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === "object" && v !== null && "toISOString" in v) {
    try {
      return (v as { toISOString: () => string }).toISOString();
    } catch {
      return null;
    }
  }
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return null;
}

function extractMetadataFields(tags: MetadataTags | null) {
  if (!tags) {
    return {
      capturedDate: null, width: null, height: null, orientation: null,
      cameraMake: null, cameraModel: null, lensModel: null, focalLength: null,
      aperture: null, shutterSpeed: null, iso: null, rating: null,
      gpsLat: null, gpsLon: null, durationSeconds: null, codec: null, audioCodec: null,
      contentIdentifier: null,
    };
  }
  return {
    capturedDate: dateOrNull(tags.DateTimeOriginal) ?? dateOrNull(tags.CreateDate),
    width: numOrNull(tags.ImageWidth) ?? numOrNull(tags.ExifImageWidth),
    height: numOrNull(tags.ImageHeight) ?? numOrNull(tags.ExifImageHeight),
    orientation: typeof tags.Orientation === "number" ? tags.Orientation : null,
    cameraMake: tags.Make ?? null,
    cameraModel: tags.Model ?? null,
    // Same preference order as server/src/exif/promote.ts's lensId, which is
    // what Reports' own lens facet groups by (media_exif.lens_id) - LensModel
    // first here would let this drift from that value again (confirmed on
    // real Canon data: LensModel and LensID are genuinely different strings
    // for the same lens), breaking the Viewer's "see every photo with this
    // lens" link to Reports.
    lensModel: tags.LensID ?? tags.LensModel ?? tags.Lens ?? null,
    // ExifTool renders this as "100.0 mm" (a string), so a plain numeric
    // check would always yield null here.
    focalLength: parseLeadingNumber(tags.FocalLength),
    aperture: numOrNull(tags.FNumber),
    shutterSpeed: tags.ShutterSpeed != null ? String(tags.ShutterSpeed) : null,
    iso: numOrNull(tags.ISO),
    rating: numOrNull(tags.Rating),
    gpsLat: numOrNull(tags.GPSLatitude),
    gpsLon: numOrNull(tags.GPSLongitude),
    // Video-specific - left null here and filled in from ffprobe (more
    // reliable for these than ExifTool) in the video branch below.
    durationSeconds: null as number | null,
    codec: null as string | null,
    audioCodec: null as string | null,
    // Apple Live Photos: the still half and its paired ~3s video share this
    // identifier - used only to find each other during indexing (see
    // linkLivePhotoPair), never exposed to the client.
    contentIdentifier: typeof tags.ContentIdentifier === "string" ? tags.ContentIdentifier : null,
  };
}

// Called after a still photo or video's own metadata is saved, to complete a
// Live Photo pairing in whichever order the two halves happened to be
// scanned in. Best-effort: a missing/unmatched identifier just means this
// isn't a Live Photo (or its other half hasn't been scanned yet, which
// self-heals whenever that half is indexed and runs this same lookup from
// its own side).
function linkLivePhotoPair(
  db: Database.Database,
  mediaId: number,
  parentFolderId: number,
  mediaType: "image" | "raw" | "video",
  contentIdentifier: string | null,
): void {
  if (!contentIdentifier) return;
  if (mediaType === "video") {
    db.prepare(
      `UPDATE media SET live_photo_video_id = ?
       WHERE parent_folder_id = ? AND content_identifier = ? AND media_type IN ('image', 'raw') AND id != ?`,
    ).run(mediaId, parentFolderId, contentIdentifier, mediaId);
  } else {
    const video = db
      .prepare(
        `SELECT id FROM media WHERE parent_folder_id = ? AND content_identifier = ? AND media_type = 'video' AND id != ?`,
      )
      .get(parentFolderId, contentIdentifier, mediaId) as { id: number } | undefined;
    if (video) {
      db.prepare("UPDATE media SET live_photo_video_id = ? WHERE id = ?").run(video.id, mediaId);
    }
  }
}

// Called after a RAW or image file's own row is inserted, to complete a
// RAW+JPEG pairing in whichever order the two files happened to be scanned
// in. Unlike linkLivePhotoPair, this needs no EXIF tag - camera-generated
// RAW+JPEG pairs share the exact same base filename in the same folder, so a
// straight filename comparison is enough. Best-effort: no match just means
// this file doesn't have a same-name counterpart (or it hasn't been scanned
// yet, which self-heals whenever that file is indexed and runs this same
// lookup from its own side).
function linkRawJpegPair(
  db: Database.Database,
  mediaId: number,
  parentFolderId: number,
  mediaType: "image" | "raw" | "video",
  absolutePath: string,
): void {
  if (mediaType === "video") return;
  const baseName = path.parse(absolutePath).name.toLowerCase();
  const counterpartType = mediaType === "raw" ? "image" : "raw";
  const siblings = db
    .prepare(
      `SELECT id, absolute_path FROM media
       WHERE parent_folder_id = ? AND media_type = ? AND status = 'active' AND id != ?`,
    )
    .all(parentFolderId, counterpartType, mediaId) as { id: number; absolute_path: string }[];
  const match = siblings.find((s) => path.parse(s.absolute_path).name.toLowerCase() === baseName);
  if (!match) return;

  if (mediaType === "raw") {
    db.prepare("UPDATE media SET raw_pair_id = ? WHERE id = ?").run(mediaId, match.id);
  } else {
    db.prepare("UPDATE media SET raw_pair_id = ? WHERE id = ?").run(match.id, mediaId);
  }
}

// Processes one media row end-to-end: metadata extraction + thumbnail
// generation. Never throws - failures are logged and reflected in
// thumbnail_status so a single corrupt file can never abort a scan.
//
// Metadata extraction and thumbnail generation are guarded independently
// (rather than one try/catch around everything) so that a thumbnail failure
// - a corrupt file, an unsupported format quirk - never discards metadata
// ExifTool already successfully read. Losing captured-date/camera/GPS data
// just because Sharp couldn't decode the file would be an unrelated failure
// bundled into one.
export async function processMediaItem(
  db: Database.Database,
  paths: AppPaths,
  logger: Logger,
  row: MediaRowForProcessing,
  capabilities: MediaToolCapabilities = new DeferredMediaToolCapabilities(),
): Promise<void> {
  const destPath = thumbnailPathForMediaId(paths.thumbnailsDir, row.id);

  let tags: MetadataTags | null = null;
  let tagsError: string | null = null;
  let metadata: ReturnType<typeof extractMetadataFields>;
  try {
    tags = capabilities.metadata.available() ? await capabilities.metadata.read(row.absolute_path) : null;
    metadata = extractMetadataFields(tags);
  } catch (err) {
    tagsError = err instanceof Error ? err.message : String(err);
    logger.error({ err, mediaId: row.id, path: row.absolute_path }, "Failed to read metadata");
    metadata = extractMetadataFields(null);
  }

  let thumbnailStatus: "done" | "unsupported" | "failed" = "failed";
  try {
    if (row.media_type === "raw") {
      const preview = await capabilities.rawPreview.extract(row.absolute_path);
      if (preview) {
        // Two tiers from the same extracted buffer (no extra ExifTool call):
        // a small grid thumbnail, and a much larger preview for the fullscreen
        // Viewer, since RAW has no browser-viewable original to fall back on.
        // Orientation comes from the RAW file's own EXIF (metadata.orientation)
        // rather than the embedded preview buffer's - RAW previews frequently
        // lack their own orientation tag, so trusting the buffer leaves
        // portrait photos sideways.
        await generateThumbnailFromBuffer(preview, destPath, metadata.orientation);
        await generatePreviewFromBuffer(
          preview,
          previewPathForMediaId(paths.previewsDir, row.id),
          metadata.orientation,
        );
        thumbnailStatus = "done";
      } else {
        thumbnailStatus = "unsupported";
        logger.warn({ mediaId: row.id, path: row.absolute_path }, "No usable embedded preview found in RAW file");
      }
    } else if (row.media_type === "image") {
      // Fall back to Sharp's own dimension reading if ExifTool wasn't available.
      if (metadata.width === null || metadata.height === null) {
        const dims = await readImageDimensions(row.absolute_path);
        metadata = { ...metadata, width: dims.width, height: dims.height, orientation: metadata.orientation ?? dims.orientation };
      }
      await generateThumbnailFromFile(row.absolute_path, destPath);
      thumbnailStatus = "done";
    } else {
      // Thumbnail (a single poster frame) only - originals are always served
      // as-is for playback, never transcoded. If a browser can't decode a
      // given container/codec it simply won't play, same as any other
      // unsupported format elsewhere in the app - no compatibility layer.
      if (capabilities.video.available()) {
        const probe = await capabilities.video.probe(row.absolute_path);
        if (probe) {
          metadata = {
            ...metadata,
            width: probe.width ?? metadata.width,
            height: probe.height ?? metadata.height,
            durationSeconds: probe.durationSeconds,
            codec: probe.codec,
            audioCodec: probe.audioCodec,
          };
        }
        const frame = await capabilities.video.poster(row.absolute_path);
        if (frame) {
          await generateThumbnailFromBuffer(frame, destPath, null);
          thumbnailStatus = "done";
        } else {
          thumbnailStatus = "unsupported";
          logger.warn({ mediaId: row.id, path: row.absolute_path }, "Could not extract a poster frame from video");
        }
      } else {
        thumbnailStatus = "unsupported";
      }
    }
  } catch (err) {
    logger.error({ err, mediaId: row.id, path: row.absolute_path }, "Failed to generate thumbnail");
    thumbnailStatus = "failed";
  }

  try {
    db.prepare(
      `UPDATE media SET
        captured_date = ?, width = ?, height = ?, orientation = ?,
        camera_make = ?, camera_model = ?, lens_model = ?, focal_length = ?,
        aperture = ?, shutter_speed = ?, iso = ?, rating = ?, gps_lat = ?, gps_lon = ?,
        duration_seconds = ?, codec = ?, audio_codec = ?, content_identifier = ?,
        thumbnail_status = ?,
        thumbnail_version = thumbnail_version + 1
      WHERE id = ?`,
    ).run(
      metadata.capturedDate, metadata.width, metadata.height, metadata.orientation,
      metadata.cameraMake, metadata.cameraModel, metadata.lensModel, metadata.focalLength,
      metadata.aperture, metadata.shutterSpeed, metadata.iso, metadata.rating, metadata.gpsLat, metadata.gpsLon,
      metadata.durationSeconds, metadata.codec, metadata.audioCodec, metadata.contentIdentifier,
      thumbnailStatus, row.id,
    );
    linkLivePhotoPair(db, row.id, row.parent_folder_id, row.media_type, metadata.contentIdentifier);
    linkRawJpegPair(db, row.id, row.parent_folder_id, row.media_type, row.absolute_path);

    // Full EXIF capture (design doc §7.2) - written here because we already
    // hold the Tags, so the backfill analyzer never has to re-read this file.
    if (tags) {
      new ExifRepo(db).upsertFromTags(row.id, tags, capabilities.metadata.version());
      new AnalysisRepo(db).markDone(row.id, EXIF_FULL_KEY, EXIF_PROMOTE_VERSION);
    } else if (tagsError) {
      // Leave it to the exif_full analyzer to retry later (e.g. once a
      // network volume is back) rather than recording an empty result.
      new AnalysisRepo(db).markPending(row.id, EXIF_FULL_KEY, tagsError);
    }
  } catch (err) {
    logger.error({ err, mediaId: row.id, path: row.absolute_path }, "Failed to save media metadata");
  }
}
