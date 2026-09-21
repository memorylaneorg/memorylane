CREATE TABLE trash_entries (
  media_id INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('moving', 'trashed')),
  files_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
