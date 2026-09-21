CREATE TABLE apple_photos_dismissed_people (
  name_key TEXT PRIMARY KEY,
  dismissed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
