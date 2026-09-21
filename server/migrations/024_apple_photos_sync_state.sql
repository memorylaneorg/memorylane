CREATE TABLE apple_photos_sync_state (
  scan_root_id INTEGER PRIMARY KEY REFERENCES scan_roots(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
  processed INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  started_at TEXT,
  finished_at TEXT,
  last_success_at TEXT
);
