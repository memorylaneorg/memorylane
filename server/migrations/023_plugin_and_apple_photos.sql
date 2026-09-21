CREATE TABLE plugin_settings (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

ALTER TABLE scan_roots ADD COLUMN kind TEXT NOT NULL DEFAULT 'folder'
  CHECK (kind IN ('folder', 'apple-photos'));

ALTER TABLE media ADD COLUMN source_kind TEXT;
ALTER TABLE media ADD COLUMN original_available INTEGER NOT NULL DEFAULT 1;

CREATE TABLE apple_photos_assets (
  scan_root_id INTEGER NOT NULL REFERENCES scan_roots(id) ON DELETE CASCADE,
  uuid TEXT NOT NULL,
  media_id INTEGER UNIQUE REFERENCES media(id) ON DELETE SET NULL,
  original_filename TEXT,
  original_path TEXT,
  derivative_path TEXT,
  title TEXT,
  description TEXT,
  keywords_json TEXT,
  faces_json TEXT,
  favorite INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  in_trash INTEGER NOT NULL DEFAULT 0,
  original_available INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (scan_root_id, uuid)
);

CREATE INDEX idx_apple_assets_media_id ON apple_photos_assets(media_id);
CREATE INDEX idx_media_source_kind ON media(source_kind);
