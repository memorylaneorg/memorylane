-- Follow-up to 007: RAW thumbnails/previews generated before the explicit
-- EXIF-orientation fix (media-processor.ts / thumbnail-generator.ts) may have
-- been baked in with the wrong rotation, since Sharp's bare .rotate() only
-- honors an orientation tag embedded in the preview buffer itself - which RAW
-- embedded previews frequently lack. Reset RAW thumbnail_status again so the
-- next scan regenerates them using the RAW file's own EXIF orientation.
UPDATE media SET thumbnail_status = 'pending' WHERE media_type = 'raw' AND thumbnail_status = 'done';
