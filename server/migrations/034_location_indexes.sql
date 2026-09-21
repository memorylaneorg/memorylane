-- Bounded coordinate scans for the offline map. Catalog entries use their
-- Photos coordinates even when no local image is available.
CREATE INDEX idx_media_location ON media(gps_lat, gps_lon) WHERE gps_lat IS NOT NULL AND gps_lon IS NOT NULL;
CREATE INDEX idx_apple_catalog_location ON apple_photos_assets(catalog_gps_lat, catalog_gps_lon)
  WHERE catalog_gps_lat IS NOT NULL AND catalog_gps_lon IS NOT NULL;
