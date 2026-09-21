-- Persons (design doc §10). Opt-in: nothing here is populated until
-- personsEnabled is switched on in Settings, and "Delete all face data"
-- empties every table below plus the faces:* vector spaces and crop cache.

CREATE TABLE persons (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT,                       -- NULL until the user names them
  auto_label    TEXT NOT NULL UNIQUE,       -- "Person 12" - stable, never reused
  cover_face_id INTEGER,                    -- references faces(id); enforced in code (circular FK)
  hidden        INTEGER NOT NULL DEFAULT 0,
  merged_into   INTEGER REFERENCES persons(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE faces (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id       INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  model          TEXT NOT NULL,
  -- Normalised (0-1) to the oriented image the detector saw.
  bbox_x REAL NOT NULL, bbox_y REAL NOT NULL, bbox_w REAL NOT NULL, bbox_h REAL NOT NULL,
  landmarks_json TEXT,
  det_score      REAL NOT NULL,
  -- det_score * min(1, longest bbox edge / 0.05): tiny/blurry faces score
  -- low and never seed a person, though they can still be assigned to one.
  quality        REAL NOT NULL,
  embedding      BLOB NOT NULL,             -- float32[dim], L2-normalised
  person_id      INTEGER REFERENCES persons(id) ON DELETE SET NULL,
  assigned_by    TEXT,                      -- 'auto' | 'user'
  assign_score   REAL,
  discovered_at  TEXT,                      -- last discovery run that considered this face
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_faces_media ON faces(media_id);
CREATE INDEX idx_faces_person ON faces(person_id);
CREATE INDEX idx_faces_unassigned ON faces(person_id, quality, discovered_at);

-- "This face is NOT that person" - honoured by assignment and discovery.
CREATE TABLE face_person_rejections (
  face_id   INTEGER NOT NULL REFERENCES faces(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  PRIMARY KEY (face_id, person_id)
);
