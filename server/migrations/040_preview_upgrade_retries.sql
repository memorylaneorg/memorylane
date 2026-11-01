ALTER TABLE preview_upgrades ADD COLUMN error_code TEXT;
ALTER TABLE preview_upgrades ADD COLUMN error_message TEXT;
ALTER TABLE preview_upgrades ADD COLUMN output_bytes INTEGER;
ALTER TABLE preview_upgrades ADD COLUMN retry_requested INTEGER NOT NULL DEFAULT 0;
CREATE INDEX preview_upgrades_retry ON preview_upgrades(retry_requested) WHERE retry_requested=1;
