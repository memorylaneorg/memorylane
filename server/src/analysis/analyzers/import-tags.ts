import type Database from "better-sqlite3";
import { TagRepo } from "../../tags/tag-repo.js";
import { isMediaSourceVisible } from "../../plugins/registry.js";
import type { Analyzer } from "../types.js";

function readKeywords(json: string | null): string[] {
  if (!json) return [];
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((part): part is string => typeof part === "string") : [];
  } catch { return []; }
}

function isCaptureFilename(filename: string, extension: string, cameraMake: string | null, cameraModel: string | null): boolean {
  if (cameraMake || cameraModel || !/^(png|jpe?g|webp)$/i.test(extension)) return false;
  return /^(?:screenshot|screen[ _-]shot)[ _-]\d{4}[-_]?\d{2}[-_]?\d{2}(?=$|[ _.-])/i.test(filename);
}

export function createImportedTagAnalyzer(db: Database.Database): Analyzer {
  const tags = new TagRepo(db);
  const get = db.prepare(`SELECT mx.keywords_json AS exifKeywords, a.keywords_json AS appleKeywords,
    m.source_kind AS sourceKind, m.filename, m.extension, m.media_type AS mediaType,
    mx.camera_make AS cameraMake, mx.camera_model AS cameraModel, a.is_screenshot AS appleScreenshot
    FROM media m LEFT JOIN media_exif mx ON mx.media_id = m.id
    LEFT JOIN apple_photos_assets a ON a.media_id = m.id WHERE m.id = ?`);
  return {
    key: "import_tags",
    version: "keywords-v2",
    batchSize: 64,
    requires: ["exif_full"],
    appliesTo: `(
      (media.source_kind = 'apple-photos' AND EXISTS (SELECT 1 FROM apple_photos_assets a WHERE a.media_id = media.id))
      OR (EXISTS (SELECT 1 FROM media_exif mx WHERE mx.media_id = media.id)
        AND EXISTS (SELECT 1 FROM media_analysis ex WHERE ex.media_id = media.id AND ex.analyzer = 'exif_full'
          AND ex.status = 'done' AND ex.input_fingerprint = media.fingerprint))
    )`,
    run: async (rows) => rows.map((row) => {
      if (!isMediaSourceVisible(db, row.id)) return { mediaId: row.id, status: "unsupported" as const };
      const data = get.get(row.id) as {
        exifKeywords: string | null; appleKeywords: string | null; sourceKind: string;
        filename: string; extension: string; mediaType: string; cameraMake: string | null;
        cameraModel: string | null; appleScreenshot: number | null;
      } | undefined;
      const names = readKeywords(data?.appleKeywords ?? data?.exifKeywords ?? null);
      const screenshot = data?.sourceKind === "apple-photos"
        ? data.appleScreenshot === 1
        : data?.mediaType === "image" && isCaptureFilename(data.filename, data.extension, data.cameraMake, data.cameraModel);
      if (screenshot) names.push("screenshot");
      tags.replaceImported(row.id, names);
      return { mediaId: row.id, status: "done" as const };
    }),
  };
}
