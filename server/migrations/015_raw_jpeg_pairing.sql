-- Pairs a RAW file with its same-name JPEG/image sibling, mirroring how
-- live_photo_video_id links a Live Photo's still to its paired video. Lives
-- on the image row (the visible/primary half) and points at the RAW row (the
-- hidden/secondary half) - a browser can display the JPEG directly but never
-- the RAW, so the JPEG is the one that should occupy the gallery grid slot.
ALTER TABLE media ADD COLUMN raw_pair_id INTEGER REFERENCES media(id);

-- One-time backfill for files scanned before this column existed. Unlike
-- Live Photo pairing, this needs no EXIF data - just a same-folder,
-- case-insensitive match on the filename with its extension stripped - so it
-- can run directly here as plain SQL rather than needing a forced
-- thumbnail_status='pending' reprocessing pass (see video_transcode_jobs
-- migration for that pattern, which this deliberately avoids: no need to
-- re-run ExifTool/ffprobe over the whole library just to link filenames that
-- are already sitting in the table).
UPDATE media
SET raw_pair_id = (
  SELECT r.id FROM media r
  WHERE r.media_type = 'raw'
    AND r.status = 'active'
    AND r.parent_folder_id = media.parent_folder_id
    AND lower(substr(r.filename, 1, length(r.filename) - length(r.extension) - 1))
      = lower(substr(media.filename, 1, length(media.filename) - length(media.extension) - 1))
  LIMIT 1
)
WHERE media_type = 'image' AND status = 'active';
