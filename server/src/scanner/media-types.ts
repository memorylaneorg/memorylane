import type { MediaType } from "@memorylane/shared";

// Standard, broadly-supported raster formats (section 8 of PLAN.md).
const IMAGE_EXTENSIONS = new Set([
  "jpg", "jpeg", "png", "webp", "gif", "tif", "tiff", "bmp", "heic", "heif",
]);

// Camera RAW formats (section 6). Kept separate from IMAGE_EXTENSIONS because
// RAW files always go through the ExifTool embedded-preview pipeline, never
// a direct Sharp decode. Covers every still-camera RAW format ExifTool
// recognizes (`exiftool -listf`) - cinema/video-only RAW formats (R3D, CRM)
// are deliberately excluded since video is out of scope for v1.
const RAW_EXTENSIONS = new Set([
  "cr2", "cr3", "craw", "crw", "ciff", // Canon
  "nef", "nrw", // Nikon
  "arw", "srf", "sr2", "arq", // Sony
  "raf", // Fujifilm
  "orf", // Olympus / OM System
  "rw2", "raw", // Panasonic/Lumix
  "pef", // Pentax
  "srw", // Samsung
  "x3f", // Sigma
  "mrw", // Minolta
  "dcr", "k25", "kdc", // Kodak
  "3fr", "fff", // Hasselblad / Imacon
  "mef", "mos", // Mamiya / Leaf
  "iiq", // Phase One
  "erf", // Epson
  "cs1", // Sinar
  "gpr", // GoPro
  "rwl", // Leica
  "rwz", // Rawzor-compressed RAW
  "dng", // Adobe DNG - also native for Leica, Pentax, Ricoh, Zeiss, Pixel, etc.
]);

// Video is out of scope for the initial build (deprioritized per product
// direction - photos first). Extensions are recognized so files aren't
// silently mis-typed, but no thumbnail/metadata pipeline runs for them yet.
const VIDEO_EXTENSIONS = new Set([
  "mp4", "mov", "m4v", "avi", "mkv", "webm",
]);

export const ALL_SUPPORTED_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS,
  ...RAW_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
]);

export function classifyExtension(extensionNoDot: string): MediaType | null {
  const ext = extensionNoDot.toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (RAW_EXTENSIONS.has(ext)) return "raw";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  return null;
}
