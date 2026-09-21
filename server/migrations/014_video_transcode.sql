-- Video modernization: detecting which videos won't play natively in a
-- browser needs the audio codec too, not just the video codec already
-- stored (container/format alone can't tell an old MJPEG .mov from a modern
-- H.264 one - ffprobe reports the same format_name for both, since the
-- mov/mp4 demuxer covers that whole family regardless of what's inside).
ALTER TABLE media ADD COLUMN audio_codec TEXT;

-- Existing video rows were indexed before audio_codec existed, so it's NULL
-- for all of them. Resetting thumbnail_status forces every video back
-- through the normal (self-healing) reprocessing pipeline on the next scan,
-- which now also probes and stores audio_codec - no separate backfill script
-- needed.
UPDATE media SET thumbnail_status = 'pending' WHERE media_type = 'video';

-- One row per video that's ever had a transcode attempted - current state
-- only (no per-attempt history), same philosophy as media_engagement.
-- pending: queued: transcoding: ffmpeg running; done+verified: ready to
-- archive; failed: needs a retry (see error); archived: the original has
-- been moved out and the new file taken over its place in the library.
CREATE TABLE video_transcode_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id INTEGER NOT NULL UNIQUE REFERENCES media(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  quality TEXT NOT NULL DEFAULT 'standard',
  error TEXT,
  original_duration_seconds REAL,
  output_duration_seconds REAL,
  original_size_bytes INTEGER,
  output_size_bytes INTEGER,
  verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  archived_at TEXT
);

CREATE INDEX idx_video_transcode_jobs_status ON video_transcode_jobs(status);
