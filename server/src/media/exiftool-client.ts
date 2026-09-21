import { ExifTool, type Tags } from "exiftool-vendored";
import type { Logger } from "pino";

// exiftool-vendored keeps a small pool of long-lived exiftool processes rather
// than spawning one per file - this is the main reason RAW metadata extraction
// stays fast across a large library. One instance is shared for the app lifetime.
let sharedInstance: ExifTool | null = null;
let availabilityChecked = false;
let isAvailable = false;
let cachedVersion = "unavailable";

export function getExifTool(): ExifTool {
  if (!sharedInstance) {
    sharedInstance = new ExifTool({ maxProcs: 2 });
  }
  return sharedInstance;
}

export async function checkExifToolAvailable(logger: Logger): Promise<boolean> {
  if (availabilityChecked) return isAvailable;
  try {
    const et = getExifTool();
    cachedVersion = await et.version();
    isAvailable = true;
    logger.info("ExifTool is available");
  } catch (err) {
    isAvailable = false;
    logger.warn({ err }, "ExifTool is not available - RAW metadata/preview extraction will be degraded");
  }
  availabilityChecked = true;
  return isAvailable;
}

export function isExifToolAvailable(): boolean {
  return isAvailable;
}

// Recorded on every media_exif row so a future ExifTool upgrade can be
// targeted for re-extraction if it starts reading tags an older one missed.
export function getExifToolVersion(): string {
  return cachedVersion;
}

// ExifTool reports a file it couldn't open as a *successful* read whose
// only content is an Error tag (e.g. an unmounted NAS volume). Treat that
// as a failed read so callers retry later instead of storing an empty result.
export class ExifReadError extends Error {}

export function exifReadError(tags: Tags | null): string | null {
  if (!tags) return null;
  const t = tags as { Error?: unknown; errors?: unknown };
  if (typeof t.Error === "string") return t.Error;
  if (Array.isArray(t.errors) && t.errors.length > 0) return String(t.errors[0]);
  return null;
}

export async function readTags(filePath: string): Promise<Tags | null> {
  if (!isAvailable) return null;
  let tags: Tags;
  try {
    tags = await getExifTool().read(filePath);
  } catch (err) {
    throw new ExifReadError(err instanceof Error ? err.message : String(err));
  }
  const problem = exifReadError(tags);
  if (problem) throw new ExifReadError(problem);
  return tags;
}

// Returns the largest embedded preview image found in a RAW file, if any.
// Tries the tags in rough order of typical size (largest-first) across
// common camera makes; the first one that resolves to actual bytes wins.
export async function extractLargestEmbeddedPreview(filePath: string): Promise<Buffer | null> {
  if (!isAvailable) return null;
  const et = getExifTool();
  const candidateTags = ["JpgFromRaw2", "JpgFromRaw", "PreviewImage", "OtherImage", "ThumbnailImage"];

  for (const tag of candidateTags) {
    try {
      const buf = await et.extractBinaryTagToBuffer(tag, filePath);
      if (buf && buf.length > 0) return buf;
    } catch {
      // tag not present on this file - try the next candidate
    }
  }
  return null;
}

export async function shutdownExifTool(): Promise<void> {
  if (sharedInstance) {
    await sharedInstance.end();
    sharedInstance = null;
  }
}
