-- Image/text embeddings (design doc §9). Durable home of every vector; the
-- The vector index under <data-dir>/vectors is a rebuildable cache over this.
-- One row per (media, model) so a model change never mixes spaces.
CREATE TABLE media_embeddings (
  media_id   INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  model      TEXT    NOT NULL,
  dim        INTEGER NOT NULL,
  vector     BLOB    NOT NULL, -- float32[dim], L2-normalised, little-endian
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (media_id, model)
);
CREATE INDEX idx_media_embeddings_model ON media_embeddings(model);
