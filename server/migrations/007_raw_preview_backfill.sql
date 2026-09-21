-- RAW files scanned before the larger preview tier (PREVIEW_LONG_EDGE) existed
-- only have the small grid thumbnail on disk. Their thumbnail_status is
-- already 'done', so the scanner's normal unchanged-fingerprint path would
-- otherwise never revisit them. Reset to 'pending' so the next scan
-- regenerates them with both tiers - see scanner-service.ts indexFile,
-- which now also retries any file whose thumbnail_status isn't 'done' even
-- when its fingerprint is unchanged.
UPDATE media SET thumbnail_status = 'pending' WHERE media_type = 'raw' AND thumbnail_status = 'done';
