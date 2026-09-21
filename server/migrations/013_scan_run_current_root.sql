-- A "Run Scan Now (all folders)" run has scan_root_id = NULL (its scope is
-- "everything"), so the client couldn't tell which specific folder was
-- currently being walked while a multi-folder run was in progress - only
-- that a scan was running at all. current_scan_root_id is a separate,
-- purely transient field the scanner updates as it moves from root to
-- root (same live-update mechanism as the thumbnail counters in
-- 010_scan_run_live_progress.sql) so the in-progress UI can show the scan's
-- progress right under the folder it's actually working on, root by root,
-- even during an all-folders run.
ALTER TABLE scan_runs ADD COLUMN current_scan_root_id INTEGER REFERENCES scan_roots(id) ON DELETE SET NULL;
