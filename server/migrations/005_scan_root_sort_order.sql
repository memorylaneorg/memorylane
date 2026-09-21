ALTER TABLE scan_roots ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

-- Backfill existing rows with a stable order matching insertion order (id),
-- since sort_order defaults to 0 for all rows above.
UPDATE scan_roots SET sort_order = id;
