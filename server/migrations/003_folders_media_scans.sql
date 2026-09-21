CREATE TABLE folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_root_id INTEGER NOT NULL REFERENCES scan_roots(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  absolute_path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_folders_parent_id ON folders(parent_id);
CREATE INDEX idx_folders_scan_root_id ON folders(scan_root_id);

CREATE TABLE media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  scan_root_id INTEGER NOT NULL REFERENCES scan_roots(id) ON DELETE CASCADE,
  absolute_path TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  extension TEXT NOT NULL,
  media_type TEXT NOT NULL, -- 'image' | 'raw' | 'video'

  file_size INTEGER NOT NULL,
  fs_created_at TEXT,
  fs_modified_at TEXT NOT NULL,
  indexed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  width INTEGER,
  height INTEGER,
  orientation INTEGER,
  captured_date TEXT,

  fingerprint TEXT NOT NULL,
  thumbnail_status TEXT NOT NULL DEFAULT 'pending', -- pending | done | failed | unsupported
  status TEXT NOT NULL DEFAULT 'active', -- active | missing

  camera_make TEXT,
  camera_model TEXT,
  lens_model TEXT,
  focal_length REAL,
  aperture REAL,
  shutter_speed TEXT,
  iso INTEGER,
  rating INTEGER,
  gps_lat REAL,
  gps_lon REAL,

  duration_seconds REAL,
  codec TEXT
);

CREATE INDEX idx_media_parent_folder_id ON media(parent_folder_id);
CREATE INDEX idx_media_scan_root_id ON media(scan_root_id);
CREATE INDEX idx_media_filename ON media(filename);
CREATE INDEX idx_media_media_type ON media(media_type);
CREATE INDEX idx_media_captured_date ON media(captured_date);
CREATE INDEX idx_media_fs_modified_at ON media(fs_modified_at);
CREATE INDEX idx_media_status ON media(status);
CREATE INDEX idx_media_thumbnail_status ON media(thumbnail_status);

CREATE TABLE scan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running', -- running | completed | failed
  files_scanned INTEGER NOT NULL DEFAULT 0,
  files_new INTEGER NOT NULL DEFAULT 0,
  files_changed INTEGER NOT NULL DEFAULT 0,
  files_removed INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  trigger_source TEXT NOT NULL DEFAULT 'manual' -- manual | scheduled ('trigger' is a reserved SQLite keyword)
);

-- Full text search over folders and media for the global search feature.
CREATE VIRTUAL TABLE folders_fts USING fts5(name, absolute_path, content='folders', content_rowid='id');
CREATE VIRTUAL TABLE media_fts USING fts5(filename, absolute_path, camera_make, camera_model, lens_model, content='media', content_rowid='id');

CREATE TRIGGER folders_ai AFTER INSERT ON folders BEGIN
  INSERT INTO folders_fts(rowid, name, absolute_path) VALUES (new.id, new.name, new.absolute_path);
END;
CREATE TRIGGER folders_ad AFTER DELETE ON folders BEGIN
  INSERT INTO folders_fts(folders_fts, rowid, name, absolute_path) VALUES ('delete', old.id, old.name, old.absolute_path);
END;
CREATE TRIGGER folders_au AFTER UPDATE ON folders BEGIN
  INSERT INTO folders_fts(folders_fts, rowid, name, absolute_path) VALUES ('delete', old.id, old.name, old.absolute_path);
  INSERT INTO folders_fts(rowid, name, absolute_path) VALUES (new.id, new.name, new.absolute_path);
END;

CREATE TRIGGER media_ai AFTER INSERT ON media BEGIN
  INSERT INTO media_fts(rowid, filename, absolute_path, camera_make, camera_model, lens_model)
    VALUES (new.id, new.filename, new.absolute_path, new.camera_make, new.camera_model, new.lens_model);
END;
CREATE TRIGGER media_ad AFTER DELETE ON media BEGIN
  INSERT INTO media_fts(media_fts, rowid, filename, absolute_path, camera_make, camera_model, lens_model)
    VALUES ('delete', old.id, old.filename, old.absolute_path, old.camera_make, old.camera_model, old.lens_model);
END;
CREATE TRIGGER media_au AFTER UPDATE ON media BEGIN
  INSERT INTO media_fts(media_fts, rowid, filename, absolute_path, camera_make, camera_model, lens_model)
    VALUES ('delete', old.id, old.filename, old.absolute_path, old.camera_make, old.camera_model, old.lens_model);
  INSERT INTO media_fts(rowid, filename, absolute_path, camera_make, camera_model, lens_model)
    VALUES (new.id, new.filename, new.absolute_path, new.camera_make, new.camera_model, new.lens_model);
END;
