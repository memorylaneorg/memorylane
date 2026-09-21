CREATE TABLE deletion_marks (
  media_id INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  marked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  reason TEXT NOT NULL DEFAULT 'user',
  original_cover_stack_id INTEGER,
  replacement_cover_media_id INTEGER
);

CREATE INDEX idx_deletion_marks_marked_at ON deletion_marks(marked_at DESC);
