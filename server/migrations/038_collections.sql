-- Collection-specific tags: explicit membership is never changed by tag analysis.
-- Never reuse IDs: saved TV selections must not authorize a later collection.
CREATE TABLE collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE
);
CREATE TABLE collection_media (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  PRIMARY KEY (collection_id, media_id)
);
CREATE INDEX idx_collection_media_media ON collection_media(media_id, collection_id);
