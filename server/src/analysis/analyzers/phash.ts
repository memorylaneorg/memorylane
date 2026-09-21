import fs from "node:fs";
import type Database from "better-sqlite3";
import sharp from "sharp";
import pLimit from "p-limit";
import { thumbnailPathForMediaId, type AppPaths } from "../../config/paths.js";
import { phashFromGray, PHASH_SIZE, PHASH_VERSION } from "../../stacks/phash.js";
import { markFoldersDirty } from "../../stacks/dirty.js";
import type { Analyzer, AnalysisMediaRow, AnalyzerOutcome } from "../types.js";
import { isMediaSourceVisible } from "../../plugins/registry.js";

export const PHASH_KEY = "phash";

// Hashes the existing 500px grid thumbnail (already oriented and decoded),
// so RAW/HEIC/BMP need no special handling here - if a thumbnail exists, it
// can be hashed. Videos are excluded: a poster frame isn't a burst.
export function createPhashAnalyzer(db: Database.Database, paths: AppPaths): Analyzer {
  const upsert = db.prepare(
    `INSERT INTO media_phash (media_id, phash, version, updated_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(media_id) DO UPDATE SET phash = excluded.phash, version = excluded.version, updated_at = excluded.updated_at`,
  );
  const limit = pLimit(4);
  return {
    key: PHASH_KEY,
    version: PHASH_VERSION,
    batchSize: 50,
    appliesTo: "media_type IN ('image', 'raw') AND thumbnail_status = 'done'",
    async run(rows: AnalysisMediaRow[]): Promise<AnalyzerOutcome[]> {
      const outcomes = await Promise.all(
        rows.map((row) =>
          limit(async (): Promise<AnalyzerOutcome> => {
            if (!isMediaSourceVisible(db, row.id)) return { mediaId: row.id, status: "unsupported", error: "Media source disabled" };
            const thumb = thumbnailPathForMediaId(paths.thumbnailsDir, row.id);
            if (!fs.existsSync(thumb)) return { mediaId: row.id, status: "unsupported", error: "No thumbnail on disk" };
            try {
              const gray = await sharp(thumb).grayscale().resize(PHASH_SIZE, PHASH_SIZE, { fit: "fill" }).raw().toBuffer();
              if (!isMediaSourceVisible(db, row.id)) return { mediaId: row.id, status: "unsupported", error: "Media source disabled" };
              upsert.run(row.id, phashFromGray(gray), PHASH_VERSION);
              return { mediaId: row.id, status: "done" };
            } catch (err) {
              return { mediaId: row.id, status: "failed", error: err instanceof Error ? err.message : String(err) };
            }
          }),
        ),
      );
      markFoldersDirty(
        db,
        rows.filter((_, i) => outcomes[i].status === "done").map((r) => r.parent_folder_id),
      );
      return outcomes;
    },
  };
}
