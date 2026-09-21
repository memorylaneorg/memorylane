-- Full EXIF capture (design doc §7.1). Promoted, typed, indexed columns for
-- the fields filters and reports use; tags_json holds everything else
-- ExifTool returned (flat tag names, binary/preview blobs stripped).
-- Kept off `media` for the same reason media_engagement is: it's a large,
-- derived superset, not filesystem truth.
CREATE TABLE media_exif (
  media_id             INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  -- Wall-clock capture time with milliseconds ("2024-05-12T10:31:44.250",
  -- no offset - offset is stored separately) so a camera's stream sorts and
  -- groups correctly for stacking. Falls back to media.fs_created_at when
  -- the file carries no EXIF date at all (scans, screenshots).
  captured_at_precise  TEXT,
  captured_tz_offset   TEXT,
  camera_make          TEXT,
  camera_model         TEXT,
  camera_serial        TEXT,
  lens_id              TEXT,
  lens_make            TEXT,
  lens_serial          TEXT,
  focal_length         REAL,
  focal_length_35mm    REAL,
  aperture             REAL,
  shutter_speed_s      REAL,
  iso                  INTEGER,
  exposure_compensation REAL,
  exposure_program     TEXT,
  metering_mode        TEXT,
  flash_fired          INTEGER,
  white_balance        TEXT,
  drive_mode           TEXT,
  burst_id             TEXT,
  shutter_count        INTEGER,
  rating               INTEGER,
  label                TEXT,
  keywords_json        TEXT,
  gps_lat              REAL,
  gps_lon              REAL,
  gps_alt              REAL,
  software             TEXT,
  tags_json            TEXT NOT NULL,
  exiftool_version     TEXT NOT NULL,
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_media_exif_lens     ON media_exif(lens_id);
CREATE INDEX idx_media_exif_camera   ON media_exif(camera_model);
CREATE INDEX idx_media_exif_make     ON media_exif(camera_make);
CREATE INDEX idx_media_exif_aperture ON media_exif(aperture);
CREATE INDEX idx_media_exif_iso      ON media_exif(iso);
CREATE INDEX idx_media_exif_focal    ON media_exif(focal_length);
CREATE INDEX idx_media_exif_captured ON media_exif(captured_at_precise);

-- Generic per-media, per-analyzer job/result status (design doc §6.2).
-- Mirrors the thumbnail_status pattern: anything not 'done' is retried;
-- a model_version that differs from the registered analyzer's is re-queued
-- at startup, so swapping a model is a queue event, not a migration.
CREATE TABLE media_analysis (
  media_id          INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  analyzer          TEXT    NOT NULL,
  status            TEXT    NOT NULL, -- pending | running | done | failed | unsupported
  model_version     TEXT,
  input_fingerprint TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  error             TEXT,
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (media_id, analyzer)
);
CREATE INDEX idx_media_analysis_pending ON media_analysis(analyzer, status);
