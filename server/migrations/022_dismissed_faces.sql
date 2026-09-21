-- A user can dismiss a detected person without deleting face detections or
-- media. Dismissed faces remain available for an explicit manual assignment,
-- but automatic discovery and assignment must never recreate the group.
ALTER TABLE faces ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_faces_discovery ON faces(model, person_id, dismissed, quality, discovered_at);
