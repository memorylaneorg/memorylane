-- Only explicit favorite/collection actions create preparation intents.
CREATE TABLE apple_photo_preparation (
  media_id INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'ready', 'failed', 'blocked')),
  error TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX apple_photo_preparation_state ON apple_photo_preparation(state, media_id);
