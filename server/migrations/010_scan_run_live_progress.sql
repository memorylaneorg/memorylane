-- scan_runs rows were only ever written once at insert (all zeros) and once
-- at completion, so polling /api/scans/status while a scan was running always
-- showed stale zeros until it finished - there was no actual live progress.
-- Add thumbnail-queue counters (indexing and thumbnail generation are
-- separate phases - a scan can finish walking files in seconds while
-- thousands of thumbnails still process in the background) so both phases
-- are visible while running, not just at the end.
ALTER TABLE scan_runs ADD COLUMN thumbnails_queued INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scan_runs ADD COLUMN thumbnails_processed INTEGER NOT NULL DEFAULT 0;
