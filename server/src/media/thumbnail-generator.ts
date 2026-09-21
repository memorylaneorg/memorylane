import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import bmpJs from "bmp-js";

export const THUMBNAIL_LONG_EDGE = 500;

// A second, larger tier used only for RAW files. Standard JPEGs/PNGs/etc. get
// viewed at full original resolution via /api/media/:id/file - only RAW has
// no browser-viewable original, so without this it would fall back to the
// same 500px grid thumbnail in the fullscreen Viewer, looking soft/small.
// Generated from the same already-extracted embedded preview buffer as the
// grid thumbnail, so it costs one extra Sharp resize, not another ExifTool call.
export const PREVIEW_LONG_EDGE = 1800;

async function ensureDirFor(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

// Applies a standard EXIF orientation value (1-8) explicitly, rather than
// relying on Sharp's auto .rotate() (which only looks at whatever EXIF tag
// happens to be embedded in the buffer/file being processed). RAW embedded
// previews often lack their own orientation tag - or carry a stale/incorrect
// one - so for those we always apply the orientation read from the RAW
// file's own top-level EXIF (the authoritative source) instead.
function applyExifOrientation(image: sharp.Sharp, orientation: number | null | undefined): sharp.Sharp {
  switch (orientation) {
    case 2:
      return image.flop();
    case 3:
      return image.rotate(180);
    case 4:
      return image.flip();
    case 5:
      return image.rotate(90).flop();
    case 6:
      return image.rotate(90);
    case 7:
      return image.rotate(270).flop();
    case 8:
      return image.rotate(270);
    default:
      // 1 (normal) or unknown/missing - no transform needed.
      return image;
  }
}

// Sharp/libvips does not support BMP as an input format at all (unlike every
// other format in IMAGE_EXTENSIONS) - it throws "unsupported image format"
// on every BMP, valid or not. Decode it ourselves via bmp-js into raw pixels
// and hand those to sharp instead of failing every BMP's thumbnail. BMP has
// no EXIF/orientation concept of its own, so there's no rotation to apply.
export async function sharpFromBmpFile(sourcePath: string): Promise<sharp.Sharp> {
  const buffer = await fs.readFile(sourcePath);
  const decoded = bmpJs.decode(buffer);
  const { width, height, data } = decoded;
  // bmp-js emits 4 bytes/pixel as [alpha, blue, green, red] - reorder to the
  // plain RGB triples sharp's raw-pixel input expects (alpha dropped; BMP
  // photos are effectively always opaque).
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i + 3];
    rgb[j + 1] = data[i + 2];
    rgb[j + 2] = data[i + 1];
  }
  return sharp(rgb, { raw: { width, height, channels: 3 } });
}

// Resizes from a source file path (standard images) - Sharp handles EXIF
// orientation automatically via .rotate() with no arguments, since the file
// being read is itself the authoritative source of its own orientation tag.
export async function generateThumbnailFromFile(sourcePath: string, destPath: string): Promise<void> {
  await ensureDirFor(destPath);
  const image =
    path.extname(sourcePath).toLowerCase() === ".bmp" ? await sharpFromBmpFile(sourcePath) : sharp(sourcePath).rotate();
  await image
    .resize({ width: THUMBNAIL_LONG_EDGE, height: THUMBNAIL_LONG_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toFile(destPath);
}

// Resizes from an in-memory buffer (RAW embedded previews extracted via
// ExifTool). `orientation` should come from the parent RAW file's own EXIF
// (see media-processor.ts), not the buffer's - see applyExifOrientation above.
export async function generateThumbnailFromBuffer(
  buffer: Buffer,
  destPath: string,
  orientation?: number | null,
): Promise<void> {
  await ensureDirFor(destPath);
  await applyExifOrientation(sharp(buffer), orientation)
    .resize({ width: THUMBNAIL_LONG_EDGE, height: THUMBNAIL_LONG_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toFile(destPath);
}

// Larger RAW-only preview for fullscreen viewing - see PREVIEW_LONG_EDGE above.
export async function generatePreviewFromBuffer(
  buffer: Buffer,
  destPath: string,
  orientation?: number | null,
): Promise<void> {
  await ensureDirFor(destPath);
  await applyExifOrientation(sharp(buffer), orientation)
    .resize({ width: PREVIEW_LONG_EDGE, height: PREVIEW_LONG_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toFile(destPath);
}

export async function readImageDimensions(sourcePath: string): Promise<{ width: number | null; height: number | null; orientation: number | null }> {
  try {
    if (path.extname(sourcePath).toLowerCase() === ".bmp") {
      const decoded = bmpJs.decode(await fs.readFile(sourcePath));
      return { width: decoded.width, height: decoded.height, orientation: null };
    }
    const meta = await sharp(sourcePath).metadata();
    return { width: meta.width ?? null, height: meta.height ?? null, orientation: meta.orientation ?? null };
  } catch {
    return { width: null, height: null, orientation: null };
  }
}
