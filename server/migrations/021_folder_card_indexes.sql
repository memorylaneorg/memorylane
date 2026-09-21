-- Companion exclusion must not scan the whole media table for every card.
CREATE INDEX idx_media_raw_pair_id ON media(raw_pair_id)
  WHERE raw_pair_id IS NOT NULL;

-- Keep subtree totals and random-cover candidates in small, folder-keyed
-- indexes, avoiding reads of the much wider media rows. SQLite indexes
-- include the rowid, so cover selection also has the media id available.
CREATE INDEX idx_media_active_folder_size ON media(parent_folder_id, file_size)
  WHERE status = 'active';
CREATE INDEX idx_media_active_folder_thumbnail ON media(parent_folder_id, thumbnail_version)
  WHERE status = 'active' AND thumbnail_status = 'done';

-- Existing libraries need statistics immediately so the planner chooses
-- folder lookups instead of scanning the active/thumbnail status indexes.
ANALYZE media;
ANALYZE folders;
