import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import type { Logger } from "pino";
import type { VideoTranscodeQuality } from "@memorylane/shared";

const execFileAsync = promisify(execFile);

let availabilityChecked = false;
let isAvailable = false;

// Thumbnail extraction only - no transcoding for playback. Originals are
// served as-is (see file-streaming.ts's Range support); if a browser can't
// decode a given container/codec, it simply won't play, the same way an
// unsupported RAW format would fail to open in any other viewer. Building a
// compatibility-transcode layer is a much bigger, ongoing-maintenance-cost
// feature that isn't in scope here.
export async function checkFfmpegAvailable(logger: Logger): Promise<boolean> {
  if (availabilityChecked) return isAvailable;
  try {
    if (!ffmpegPath || !ffprobeStatic.path) throw new Error("ffmpeg-static/ffprobe-static did not resolve a binary path");
    await execFileAsync(ffmpegPath, ["-version"]);
    await execFileAsync(ffprobeStatic.path, ["-version"]);
    isAvailable = true;
    logger.info("ffmpeg/ffprobe are available");
  } catch (err) {
    isAvailable = false;
    logger.warn({ err }, "ffmpeg/ffprobe are not available - video thumbnails/duration will be degraded");
  }
  availabilityChecked = true;
  return isAvailable;
}

export function isFfmpegAvailable(): boolean {
  return isAvailable;
}

export interface VideoProbeResult {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  audioCodec: string | null;
}

export async function probeVideo(filePath: string): Promise<VideoProbeResult | null> {
  if (!isAvailable) return null;
  try {
    // No -select_streams here (unlike before) - browser-playability depends
    // on the audio codec too, not just video, so both streams are read in
    // one call rather than probing twice.
    const { stdout } = await execFileAsync(ffprobeStatic.path, [
      "-v", "error",
      "-show_entries", "stream=codec_type,codec_name,width,height:format=duration",
      "-of", "json",
      filePath,
    ]);
    const parsed = JSON.parse(stdout) as {
      streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number }[];
      format?: { duration?: string };
    };
    const videoStream = parsed.streams?.find((s) => s.codec_type === "video");
    const audioStream = parsed.streams?.find((s) => s.codec_type === "audio");
    const duration = parsed.format?.duration ? Number(parsed.format.duration) : null;
    return {
      durationSeconds: duration !== null && Number.isFinite(duration) ? duration : null,
      width: videoStream?.width ?? null,
      height: videoStream?.height ?? null,
      codec: videoStream?.codec_name ?? null,
      audioCodec: audioStream?.codec_name ?? null,
    };
  } catch {
    return null;
  }
}

// A single representative frame as a JPEG buffer, for the existing Sharp
// thumbnail pipeline (generateThumbnailFromBuffer) to resize exactly like
// any other buffer-sourced thumbnail (RAW previews, this). 0.5s in is safely
// within even a ~3s Live Photo clip while skipping the very first frame,
// which is disproportionately likely to be black/blank on real footage.
export async function extractPosterFrame(filePath: string): Promise<Buffer | null> {
  if (!isAvailable) return null;
  try {
    const { stdout } = await execFileAsync(
      ffmpegPath!,
      ["-ss", "0.5", "-i", filePath, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "-"],
      { encoding: "buffer", maxBuffer: 1024 * 1024 * 64 },
    );
    return stdout.length > 0 ? stdout : null;
  } catch {
    // Some very short clips have nothing at 0.5s - retry at the very start
    // before giving up (a missing thumbnail beats a failed scan either way).
    try {
      const { stdout } = await execFileAsync(
        ffmpegPath!,
        ["-i", filePath, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "-"],
        { encoding: "buffer", maxBuffer: 1024 * 1024 * 64 },
      );
      return stdout.length > 0 ? stdout : null;
    } catch {
      return null;
    }
  }
}

// CRF-based (quality target, not a fixed bitrate) so simple and complex
// scenes both land at a consistent visual quality instead of wasting or
// starving bits. "standard" is deliberately conservative on size - these are
// old, often noisy/grainy camera originals, and a near-lossless CRF faithfully
// (and expensively) re-encodes that noise, so a library-wide batch can easily
// grow rather than shrink at a low CRF. "high" is an explicit opt-in for a
// specific clip worth the extra space. Source resolution and frame rate are
// always left untouched - modernizing the codec, not re-editing the footage.
const TRANSCODE_SETTINGS: Record<VideoTranscodeQuality, { preset: string; crf: string; audioBitrate: string }> = {
  standard: { preset: "medium", crf: "23", audioBitrate: "128k" },
  high: { preset: "veryslow", crf: "17", audioBitrate: "192k" },
};

export async function transcodeVideo(
  inputPath: string,
  outputPath: string,
  quality: VideoTranscodeQuality,
): Promise<boolean> {
  if (!isAvailable) return false;
  const settings = TRANSCODE_SETTINGS[quality];
  try {
    await execFileAsync(
      ffmpegPath!,
      [
        "-y",
        "-i", inputPath,
        "-c:v", "libx264",
        "-preset", settings.preset,
        "-crf", settings.crf,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", settings.audioBitrate,
        "-movflags", "+faststart",
        "-loglevel", "error",
        outputPath,
      ],
      { maxBuffer: 1024 * 1024 * 16 },
    );
    return true;
  } catch {
    return false;
  }
}
