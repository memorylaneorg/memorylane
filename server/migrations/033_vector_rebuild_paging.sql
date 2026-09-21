-- Keyset paging keeps vector rebuilds bounded and releases the shared SQLite
-- connection between pages. These indexes preserve the requested id order.
CREATE INDEX idx_media_embeddings_model_media_id ON media_embeddings(model, media_id);
CREATE INDEX idx_faces_model_id ON faces(model, id);
