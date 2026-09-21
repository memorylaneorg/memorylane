import { describe, it, expect } from "vitest";
import { ExifDateTime, type Tags } from "exiftool-vendored";
import { createTestDb, seedScanRoot, seedFolder, seedMedia } from "../helpers/db.js";
import { ExifRepo } from "../../src/exif/exif-repo.js";

async function setup() {
  const db = await createTestDb();
  const root = seedScanRoot(db);
  const folder = seedFolder(db, root, "/library/2024");
  return { db, root, folder, repo: new ExifRepo(db) };
}

describe("ExifRepo", () => {
  it("writes promoted columns and the stripped tag dump", async () => {
    const { db, root, folder, repo } = await setup();
    const id = seedMedia(db, folder, root);
    repo.upsertFromTags(
      id,
      { Make: "Nikon", Model: "NIKON Z 8", FNumber: 4, ISO: 800, FocalLength: "70.0 mm",
        DateTimeOriginal: ExifDateTime.fromEXIF("2024:03:01 08:00:00"), ThumbnailImage: "(Binary data 1 bytes)" } as unknown as Tags,
      "13.55",
    );
    const row = repo.get(id)!;
    expect(row.camera_model).toBe("NIKON Z 8");
    expect(row.aperture).toBe(4);
    expect(row.iso).toBe(800);
    expect(row.focal_length).toBe(70);
    expect(row.captured_at_precise).toBe("2024-03-01T08:00:00.000");
    expect(row.exiftool_version).toBe("13.55");
    const dump = JSON.parse(row.tags_json);
    expect(dump.Make).toBe("Nikon");
    expect(dump.ThumbnailImage).toBeUndefined();
  });

  it("falls back to media.fs_created_at when there is no EXIF capture date", async () => {
    const { db, root, folder, repo } = await setup();
    const id = seedMedia(db, folder, root, { fs_created_at: "2018-07-04T12:00:00.000Z" });
    repo.upsertFromTags(id, { Make: "Apple" } as unknown as Tags, "13.55");
    expect(repo.get(id)!.captured_at_precise).toBe("2018-07-04T12:00:00.000");
  });

  it("writes a minimal row when tags are null, and upserts on repeat", async () => {
    const { db, root, folder, repo } = await setup();
    const id = seedMedia(db, folder, root);
    repo.upsertFromTags(id, null, "unavailable");
    expect(repo.get(id)!.tags_json).toBe("{}");
    repo.upsertFromTags(id, { Make: "Sony" } as unknown as Tags, "13.55");
    expect(repo.get(id)!.camera_make).toBe("Sony");
    expect((db.prepare("SELECT COUNT(*) c FROM media_exif").get() as { c: number }).c).toBe(1);
  });

  it("returns null for unknown media", async () => {
    const { repo } = await setup();
    expect(repo.get(999)).toBeNull();
  });
});

describe("exifReadError", () => {
  it("recognises ExifTool's error-only results", async () => {
    const { exifReadError } = await import("../../src/exif/read-error.js");
    expect(exifReadError({ ExifToolVersion: 13, Error: "Error opening file" } as unknown as Tags)).toBe("Error opening file");
    expect(exifReadError({ errors: ["boom"] } as unknown as Tags)).toBe("boom");
    expect(exifReadError({ Make: "Canon" } as unknown as Tags)).toBeNull();
    expect(exifReadError(null)).toBeNull();
  });
});
