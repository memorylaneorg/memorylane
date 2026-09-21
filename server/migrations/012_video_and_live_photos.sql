-- Video support: media_type 'video' was already recognized by the scanner
-- but explicitly skipped during indexing (thumbnail/metadata pipeline
-- deferred). No new columns needed for video itself - duration_seconds and
-- codec already existed on this table unused, reserved for exactly this.
--
-- Live Photos: an Apple still+video pair sharing a ContentIdentifier tag
-- (read via ExifTool from either half). content_identifier is stored on
-- every photo/video that has one, purely to find the matching sibling
-- during indexing - never exposed to the client. live_photo_video_id points
-- from a still photo's row to its paired video's row; ON DELETE SET NULL so
-- removing the video (e.g. via the ignore-folder feature) can't leave a
-- dangling reference. Queries that list media for normal browsing exclude
-- any row referenced as someone's live_photo_video_id, so the paired video
-- never shows up as its own separate grid item next to its photo.
ALTER TABLE media ADD COLUMN content_identifier TEXT;
ALTER TABLE media ADD COLUMN live_photo_video_id INTEGER REFERENCES media(id) ON DELETE SET NULL;

CREATE INDEX idx_media_content_identifier ON media(content_identifier);
CREATE INDEX idx_media_live_photo_video_id ON media(live_photo_video_id);
