-- Lightweight engagement tracking (favorites + shown/viewed counters) to
-- eventually power rediscovery features (Forgotten Photos, Rarely Seen, etc.)
-- and bias Surprise Me away from recently-shown photos. Kept as a separate
-- table rather than columns on `media` so the core media schema stays clean -
-- this data is behavioral, not filesystem/metadata truth.
--
-- Deliberately NOT a full event-history log (no per-view rows) - just
-- aggregate counters, per section 4/7 of the spec ("do not create a full
-- event-history system yet unless required", "keep it invisible and
-- lightweight"). media.rating (imported EXIF/XMP rating) is untouched by
-- this table and never overwritten by favoriting.
CREATE TABLE media_engagement (
  media_id INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  favorite INTEGER NOT NULL DEFAULT 0,
  favorited_at TEXT,
  shown_count INTEGER NOT NULL DEFAULT 0,
  last_shown_at TEXT,
  view_count INTEGER NOT NULL DEFAULT 0,
  first_viewed_at TEXT,
  last_viewed_at TEXT
);

CREATE INDEX idx_media_engagement_favorite ON media_engagement(favorite);
CREATE INDEX idx_media_engagement_last_shown_at ON media_engagement(last_shown_at);
