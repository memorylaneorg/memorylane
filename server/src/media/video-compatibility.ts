import { EXCLUDE_LIVE_PHOTO_VIDEOS } from "../api/mappers.js";

// A video counts as "needs modernizing" purely by codec - h264/vp8/vp9/av1
// video with aac/mp3/opus/vorbis audio (or no audio track at all) plays
// natively in every current browser regardless of container. Container/
// format isn't part of this check: ffprobe's format_name is shared across
// the whole mov/mp4/m4a/3gp family regardless of what codec is actually
// inside, so it can't tell a modern .mp4 apart from a decades-old MJPEG
// .mov - only the codec names can. This is also why HEVC/H.265 shows up
// here a lot in practice - it's the default codec for Live Photo companion
// clips (and short videos generally) on modern iPhones, and no non-Safari
// browser decodes it natively.
//
// A single SQL fragment (rather than a JS predicate re-implemented per
// query) so the scan-root stats count and the candidates list can never
// drift out of sync with each other. Append with AND to a WHERE clause
// already scoped to `media_type = 'video' AND status = 'active'`.
export const NEEDS_TRANSCODE_SQL_CLAUSE = `
  NOT (
    codec IN ('h264', 'vp8', 'vp9', 'av1')
    AND (audio_codec IS NULL OR audio_codec IN ('aac', 'mp3', 'opus', 'vorbis'))
  )
  AND id NOT IN (SELECT media_id FROM video_transcode_jobs WHERE status = 'archived')
  -- Excludes a Live Photo's paired video: transcoding one half of a pair
  -- without the other, and then archiving the original out from under the
  -- still photo's live_photo_video_id, would silently break that photo's
  -- LIVE playback with no automatic repair. Re-encoding a Live Photo's video
  -- isn't something this feature handles at all right now.
  AND ${EXCLUDE_LIVE_PHOTO_VIDEOS}
`;
