ALTER TABLE apple_photos_assets ADD COLUMN catalog_gps_lat REAL;
ALTER TABLE apple_photos_assets ADD COLUMN catalog_gps_lon REAL;

CREATE INDEX idx_apple_assets_catalog_date ON apple_photos_assets(scan_root_id, catalog_date);
