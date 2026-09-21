import type Database from "better-sqlite3";
import pLimit from "p-limit";
import { ExifRepo } from "../../exif/exif-repo.js";
import { EXIF_PROMOTE_VERSION } from "../../exif/promote.js";
import type { MediaToolCapabilities } from "../../capabilities/media-tools.js";
import { markFoldersDirty } from "../../stacks/dirty.js";
import type { Analyzer, AnalysisMediaRow, AnalyzerOutcome } from "../types.js";
import { isMediaSourceVisible } from "../../plugins/registry.js";

export const EXIF_FULL_KEY = "exif_full";

export function classifyExifFailure(err: unknown): Pick<AnalyzerOutcome, "status" | "error"> {
  const error = err instanceof Error ? err.message : String(err);
  return { status: error === "File is empty" ? "unsupported" : "failed", error };
}

function emptyFileOutcome(mediaId: number): AnalyzerOutcome {
  return { mediaId, status: "unsupported", error: "File is empty" };
}

// Backfill/re-run path for media_exif. The scan path writes media_exif
// inline (processMediaItem already holds the Tags) and calls markDone, so
// this analyzer only ever sees media indexed before the feature existed or
// rows re-queued by a version bump.
export function createExifFullAnalyzer(db: Database.Database, tools: MediaToolCapabilities): Analyzer {
  const repo = new ExifRepo(db);
  const limit = pLimit(2); // matches the ExifTool process pool (maxProcs: 2)
  return {
    key: EXIF_FULL_KEY,
    version: EXIF_PROMOTE_VERSION,
    batchSize: 20,
    appliesTo: "1=1",
    async run(rows: AnalysisMediaRow[]): Promise<AnalyzerOutcome[]> {
      if (!tools.metadata.available()) {
        return rows.map((r) =>
          r.file_size === 0 ? emptyFileOutcome(r.id) : { mediaId: r.id, status: "unsupported" as const, error: "ExifTool not available" },
        );
      }
      const outcomes = await Promise.all(
        rows.map((row) =>
          limit(async (): Promise<AnalyzerOutcome> => {
            if (row.file_size === 0) return emptyFileOutcome(row.id);
            if (!isMediaSourceVisible(db, row.id)) return { mediaId: row.id, status: "unsupported", error: "Media source disabled" };
            try {
              const tags = await tools.metadata.read(row.absolute_path);
              if (!isMediaSourceVisible(db, row.id)) return { mediaId: row.id, status: "unsupported", error: "Media source disabled" };
              repo.upsertFromTags(row.id, tags, tools.metadata.version());
              return { mediaId: row.id, status: "done" };
            } catch (err) {
              return { mediaId: row.id, ...classifyExifFailure(err) };
            }
          }),
        ),
      );
      // Stacks group by capture time + body, both from media_exif - a folder
      // whose EXIF just arrived (backfill, or a retry after a volume came
      // back) needs re-stacking.
      markFoldersDirty(db, rows.filter((_, i) => outcomes[i].status === "done").map((r) => r.parent_folder_id));
      return outcomes;
    },
  };
}
