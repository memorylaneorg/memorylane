-- Stacks v1 (design doc §8.2): bursts of near-identical shots collapsed
-- into one grid item. Auto stacks are recomputed per folder whenever its
-- contents or hashes change; a stack the user has touched (user_modified)
-- is never rewritten by the stacker.

-- 64-bit DCT perceptual hash of the 500px thumbnail, as 16 hex chars
-- (SQLite integers are signed 64-bit and JS numbers lose precision past
-- 2^53; hex round-trips exactly through BigInt).
CREATE TABLE media_phash (
  media_id   INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  phash      TEXT NOT NULL,
  version    TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE stacks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  kind             TEXT    NOT NULL,            -- 'burst' (auto) | 'manual'
  cover_media_id   INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  parent_folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  rule_version     TEXT,                        -- stacker version that created it (NULL for manual)
  user_modified    INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_stacks_folder ON stacks(parent_folder_id);

-- A photo is in at most one stack.
CREATE TABLE stack_members (
  stack_id INTEGER NOT NULL REFERENCES stacks(id) ON DELETE CASCADE,
  media_id INTEGER NOT NULL UNIQUE REFERENCES media(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (stack_id, media_id)
);

-- "Never auto-stack this photo again" - set when the user removes a photo
-- from a stack or deletes a stack outright.
CREATE TABLE stack_exclusions (
  media_id   INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Folders whose contents/hashes changed since their stacks were last
-- computed. Persisted (not in-memory) so a restart mid-scan loses nothing.
CREATE TABLE stack_dirty_folders (
  folder_id INTEGER PRIMARY KEY REFERENCES folders(id) ON DELETE CASCADE
);
