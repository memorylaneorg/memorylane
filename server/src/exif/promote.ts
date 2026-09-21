type Tags = Record<string, unknown>;
interface ExifDateValue { year: number; month: number; day: number; hour: number; minute: number; second: number; millisecond?: number; tzoffsetMinutes?: number }

// Bump whenever the mapping below changes in a way that should re-run over
// already-processed media - the analysis worker re-queues every media_exif
// row whose media_analysis.model_version differs (design doc §6.1).
export const EXIF_PROMOTE_VERSION = "exif-promote-v1";

export interface PromotedExif {
  capturedAtPrecise: string | null;
  capturedTzOffset: string | null;
  cameraMake: string | null;
  cameraModel: string | null;
  cameraSerial: string | null;
  lensId: string | null;
  lensMake: string | null;
  lensSerial: string | null;
  focalLength: number | null;
  focalLength35mm: number | null;
  aperture: number | null;
  shutterSpeedS: number | null;
  iso: number | null;
  exposureCompensation: number | null;
  exposureProgram: string | null;
  meteringMode: string | null;
  flashFired: 0 | 1 | null;
  whiteBalance: string | null;
  driveMode: string | null;
  burstId: string | null;
  shutterCount: number | null;
  rating: number | null;
  label: string | null;
  keywords: string[] | null;
  gpsLat: number | null;
  gpsLon: number | null;
  gpsAlt: number | null;
  software: string | null;
}

function str(v: unknown): string | null {
  if (typeof v === "number") return String(v);
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length ? s : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function int(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? Math.round(n) : null;
}

// ExifTool renders many numeric tags with units ("100.0 mm", "500 mm") -
// exiftool-vendored only asks for raw numbers on a short numericTags list
// (GPS, Orientation, durations), so anything else arrives as a string.
export function parseLeadingNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

// "1/250" -> 0.004, "30" -> 30, 0.5 -> 0.5. Anything non-numeric ("Bulb") -> null.
export function parseShutterSeconds(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  const frac = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (frac) {
    const d = Number(frac[2]);
    return d > 0 ? Number(frac[1]) / d : null;
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Maker-note drive/shooting mode strings vary per brand ("Continuous
// Shooting", "Continuous High", "Single Frame", "Self-timer 10 sec"...).
// Collapse to a small vocabulary; unknown values pass through lowercased so
// nothing is lost, just un-normalised.
export function normalizeDriveMode(v: unknown): string | null {
  const s = str(v)?.toLowerCase() ?? null;
  if (!s) return null;
  if (/continuous|burst|high speed|sequential/.test(s)) return "continuous";
  if (/bracket/.test(s)) return "bracket";
  if (/timer/.test(s)) return "timer";
  if (/single/.test(s)) return "single";
  return s;
}

// ExifTool's Flash is a composite description: "Off, Did not fire",
// "Auto, Fired, Red-eye reduction", "No Flash", "Fired".
export function parseFlashFired(v: unknown): 0 | 1 | null {
  const s = str(v)?.toLowerCase() ?? null;
  if (!s) return null;
  if (/did not fire|no flash|^off\b/.test(s)) return 0;
  if (/fired|^on\b/.test(s)) return 1;
  return null;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

// Wall-clock string without an offset - see media_exif.captured_at_precise.
export function formatWallClock(dt: ExifDateValue): string {
  return `${pad(dt.year, 4)}-${pad(dt.month)}-${pad(dt.day)}T${pad(dt.hour)}:${pad(dt.minute)}:${pad(dt.second)}.${pad(dt.millisecond ?? 0, 3)}`;
}

// "+02:00" / "-05:30" from the parsed offset, so the column is a plain ISO
// offset regardless of how ExifTool spelled the zone.
export function formatTzOffset(dt: ExifDateValue): string | null {
  const m = dt.tzoffsetMinutes;
  if (typeof m !== "number" || !Number.isFinite(m)) return null;
  const sign = m < 0 ? "-" : "+";
  const abs = Math.abs(m);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function firstDateTime(...candidates: unknown[]): ExifDateValue | null {
  for (const c of candidates) {
    if (c && typeof c === "object" && ["year", "month", "day", "hour", "minute", "second"].every((key) => Number.isFinite((c as Record<string, unknown>)[key]))) return c as ExifDateValue;
    if (typeof c === "string") {
      const match = /^(\d{4})[-:](\d{2})[-:](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([+-])(\d{2}):?(\d{2}))?/.exec(c);
      if (match) return { year:+match[1], month:+match[2], day:+match[3], hour:+match[4], minute:+match[5], second:+match[6], millisecond: +(match[7] ?? 0), tzoffsetMinutes: match[8] ? (match[8] === "-" ? -1 : 1) * (+match[9] * 60 + +match[10]) : undefined };
    }
  }
  return null;
}

function keywords(tags: Tags): string[] | null {
  const raw = (tags.Keywords ?? tags.Subject) as unknown;
  if (raw == null) return null;
  const list = Array.isArray(raw) ? raw : [raw];
  const cleaned = list.map((k) => str(k)).filter((k): k is string => k !== null);
  return cleaned.length ? cleaned : null;
}

export function promoteTags(tags: Tags): PromotedExif {
  const t = tags as Record<string, unknown>;
  const dt = firstDateTime(t.SubSecDateTimeOriginal, t.DateTimeOriginal, t.CreateDate);
  return {
    capturedAtPrecise: dt ? formatWallClock(dt) : null,
    capturedTzOffset: dt ? formatTzOffset(dt) : null,
    cameraMake: str(t.Make),
    cameraModel: str(t.Model),
    cameraSerial: str(t.SerialNumber),
    lensId: str(t.LensID) ?? str(t.LensModel) ?? str(t.Lens),
    lensMake: str(t.LensMake),
    lensSerial: str(t.LensSerialNumber),
    focalLength: parseLeadingNumber(t.FocalLength),
    focalLength35mm: parseLeadingNumber(t.FocalLengthIn35mmFormat),
    aperture: num(t.FNumber) ?? parseLeadingNumber(t.FNumber),
    shutterSpeedS: parseShutterSeconds(t.ExposureTime) ?? parseShutterSeconds(t.ShutterSpeed),
    iso: int(t.ISO),
    exposureCompensation: num(t.ExposureCompensation) ?? parseLeadingNumber(t.ExposureCompensation),
    exposureProgram: str(t.ExposureProgram),
    meteringMode: str(t.MeteringMode),
    flashFired: parseFlashFired(t.Flash),
    whiteBalance: str(t.WhiteBalance),
    driveMode: normalizeDriveMode(t.DriveMode ?? t.ShootingMode),
    burstId: str(t.BurstUUID),
    shutterCount: int(t.ShutterCount) ?? int(t.ImageCount),
    rating: int(t.Rating),
    label: str(t.Label),
    keywords: keywords(tags),
    gpsLat: num(t.GPSLatitude),
    gpsLon: num(t.GPSLongitude),
    gpsAlt: num(t.GPSAltitude),
    software: str(t.Software),
  };
}

const DROPPED_KEYS = new Set(["SourceFile", "Directory", "FileName", "FilePath", "errors", "warnings"]);

// Everything ExifTool returned, minus binary blobs (previews/thumbnails are
// multi-MB strings-of-bytes we never want in the DB), file-location keys
// (absolute_path already lives on media), and exiftool-vendored's own
// error/warning arrays. Date/time objects flatten to their raw EXIF text.
export function stripTagsForStorage(tags: Tags): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(tags as Record<string, unknown>)) {
    if (DROPPED_KEYS.has(key) || value == null) continue;
    if (typeof value === "string" && value.startsWith("(Binary data")) continue;
    if (typeof value === "object" && !Array.isArray(value)) {
      const v = value as { rawValue?: unknown; bytes?: unknown };
      if ("bytes" in v) continue; // BinaryField
      if (typeof v.rawValue === "string") out[key] = v.rawValue;
      continue; // any other object shape isn't worth storing
    }
    out[key] = value;
  }
  return out;
}
