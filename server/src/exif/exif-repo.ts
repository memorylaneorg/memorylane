import type Database from "better-sqlite3";
type Tags = Record<string, unknown>;
import { promoteTags, stripTagsForStorage, type PromotedExif } from "./promote.js";

export interface MediaExifRow {
  media_id: number;
  captured_at_precise: string | null;
  captured_tz_offset: string | null;
  camera_make: string | null;
  camera_model: string | null;
  camera_serial: string | null;
  lens_id: string | null;
  lens_make: string | null;
  lens_serial: string | null;
  focal_length: number | null;
  focal_length_35mm: number | null;
  aperture: number | null;
  shutter_speed_s: number | null;
  iso: number | null;
  exposure_compensation: number | null;
  exposure_program: string | null;
  metering_mode: string | null;
  flash_fired: number | null;
  white_balance: string | null;
  drive_mode: string | null;
  burst_id: string | null;
  shutter_count: number | null;
  rating: number | null;
  label: string | null;
  keywords_json: string | null;
  gps_lat: number | null;
  gps_lon: number | null;
  gps_alt: number | null;
  software: string | null;
  tags_json: string;
  exiftool_version: string;
  updated_at: string;
}

const EMPTY: PromotedExif = {
  capturedAtPrecise: null, capturedTzOffset: null, cameraMake: null, cameraModel: null, cameraSerial: null,
  lensId: null, lensMake: null, lensSerial: null, focalLength: null, focalLength35mm: null, aperture: null,
  shutterSpeedS: null, iso: null, exposureCompensation: null, exposureProgram: null, meteringMode: null,
  flashFired: null, whiteBalance: null, driveMode: null, burstId: null, shutterCount: null, rating: null,
  label: null, keywords: null, gpsLat: null, gpsLon: null, gpsAlt: null, software: null,
};

// Persists the promoted EXIF columns + stripped tag dump for one media row.
// Written inline by processMediaItem during scans and by the exif_full
// analyzer during backfill - both go through here so the mapping is one place.
export class ExifRepo {
  private upsertStmt: Database.Statement;
  private getStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.upsertStmt = db.prepare(
      `INSERT INTO media_exif (
         media_id, captured_at_precise, captured_tz_offset, camera_make, camera_model, camera_serial,
         lens_id, lens_make, lens_serial, focal_length, focal_length_35mm, aperture, shutter_speed_s, iso,
         exposure_compensation, exposure_program, metering_mode, flash_fired, white_balance, drive_mode,
         burst_id, shutter_count, rating, label, keywords_json, gps_lat, gps_lon, gps_alt, software,
         tags_json, exiftool_version, updated_at
       ) VALUES (
         @mediaId,
         COALESCE(@capturedAtPrecise, (SELECT substr(replace(fs_created_at, 'Z', ''), 1, 23) FROM media WHERE id = @mediaId)),
         @capturedTzOffset, @cameraMake, @cameraModel, @cameraSerial,
         @lensId, @lensMake, @lensSerial, @focalLength, @focalLength35mm, @aperture, @shutterSpeedS, @iso,
         @exposureCompensation, @exposureProgram, @meteringMode, @flashFired, @whiteBalance, @driveMode,
         @burstId, @shutterCount, @rating, @label, @keywordsJson, @gpsLat, @gpsLon, @gpsAlt, @software,
         @tagsJson, @exiftoolVersion, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       )
       ON CONFLICT(media_id) DO UPDATE SET
         captured_at_precise = excluded.captured_at_precise, captured_tz_offset = excluded.captured_tz_offset,
         camera_make = excluded.camera_make, camera_model = excluded.camera_model, camera_serial = excluded.camera_serial,
         lens_id = excluded.lens_id, lens_make = excluded.lens_make, lens_serial = excluded.lens_serial,
         focal_length = excluded.focal_length, focal_length_35mm = excluded.focal_length_35mm, aperture = excluded.aperture,
         shutter_speed_s = excluded.shutter_speed_s, iso = excluded.iso, exposure_compensation = excluded.exposure_compensation,
         exposure_program = excluded.exposure_program, metering_mode = excluded.metering_mode, flash_fired = excluded.flash_fired,
         white_balance = excluded.white_balance, drive_mode = excluded.drive_mode, burst_id = excluded.burst_id,
         shutter_count = excluded.shutter_count, rating = excluded.rating, label = excluded.label,
         keywords_json = excluded.keywords_json, gps_lat = excluded.gps_lat, gps_lon = excluded.gps_lon, gps_alt = excluded.gps_alt,
         software = excluded.software, tags_json = excluded.tags_json, exiftool_version = excluded.exiftool_version,
         updated_at = excluded.updated_at`,
    );
    this.getStmt = db.prepare("SELECT * FROM media_exif WHERE media_id = ?");
  }

  // Files with no EXIF date (scans, screenshots) fall back to the filesystem
  // creation time - see the COALESCE above - so date filters still see them.
  upsertFromTags(mediaId: number, tags: Tags | null, exiftoolVersion: string): void {
    const { keywords, ...cols } = tags ? promoteTags(tags) : EMPTY;
    this.upsertStmt.run({
      mediaId,
      ...cols,
      keywordsJson: keywords ? JSON.stringify(keywords) : null,
      tagsJson: tags ? JSON.stringify(stripTagsForStorage(tags)) : "{}",
      exiftoolVersion,
    });
  }

  get(mediaId: number): MediaExifRow | null {
    return (this.getStmt.get(mediaId) as MediaExifRow | undefined) ?? null;
  }
}
