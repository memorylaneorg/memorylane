-- Tracks whether a scan run covered every enabled root (NULL) or was scoped
-- to a single scan root (per-folder "Scan Now").
ALTER TABLE scan_runs ADD COLUMN scan_root_id INTEGER REFERENCES scan_roots(id) ON DELETE SET NULL;

CREATE INDEX idx_scan_runs_scan_root_id ON scan_runs(scan_root_id);
