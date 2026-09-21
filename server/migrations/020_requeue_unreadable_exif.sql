-- Earlier builds stored an ExifTool "Error opening file" result (e.g. a
-- network volume that wasn't mounted yet at startup) as a completed EXIF
-- read. Drop those rows and queue the files again; the analyzer now treats
-- such results as failures and retries them.
DELETE FROM media_exif WHERE json_extract(tags_json, '$.Error') IS NOT NULL;
UPDATE media_analysis SET status = 'pending', attempts = 0, error = 'requeued: earlier read failed (file was unreadable)', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE analyzer = 'exif_full' AND media_id NOT IN (SELECT media_id FROM media_exif);
