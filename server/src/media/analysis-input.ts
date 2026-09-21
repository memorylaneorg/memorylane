import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { previewPathForMediaId, thumbnailPathForMediaId, type AppPaths } from "../config/paths.js";
import { sharpFromBmpFile } from "./thumbnail-generator.js";
import type { AnalysisMediaRow } from "../analysis/types.js";

export const ANALYSIS_LONG_EDGE = 1600;

// The image a model sees (design doc §6.4): a consistently oriented JPEG at
// up to 1600px. Faces need more than the 500px thumbnail. Not persisted -
// generated per batch, decoded once per backfill. RAW uses the already
// oriented 1800px preview; video has no still to analyse here.
export async function renderAnalysisJpeg(paths: AppPaths, row: AnalysisMediaRow): Promise<Buffer | null> {
  try {
    if (row.media_type === "raw") {
      const preview = previewPathForMediaId(paths.previewsDir, row.id);
      if (fs.existsSync(preview)) return fs.readFileSync(preview);
      const thumb = thumbnailPathForMediaId(paths.thumbnailsDir, row.id);
      return fs.existsSync(thumb) ? fs.readFileSync(thumb) : null;
    }
    if (row.media_type !== "image") return null;
    const image =
      path.extname(row.absolute_path).toLowerCase() === ".bmp" ? await sharpFromBmpFile(row.absolute_path) : sharp(row.absolute_path).rotate();
    return await image
      .resize({ width: ANALYSIS_LONG_EDGE, height: ANALYSIS_LONG_EDGE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch {
    return null;
  }
}
