import { describe, it, expect } from "vitest";
import { createTestDb, seedScanRoot, seedFolder, seedMedia } from "../helpers/db.js";
import { runMigrations } from "../../src/db/migrate.js";
import { TagRepo } from "../../src/tags/tag-repo.js";

describe("migrations", () => {
  it("apply cleanly to an in-memory database and seed helpers work", async () => {
    const db = await createTestDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("media");
    expect(names).toContain("media_engagement");
    expect(names).toContain("media_exif");
    expect(names).toContain("media_analysis");
    for (const t of ["media_phash", "stacks", "stack_members", "stack_exclusions", "stack_dirty_folders", "media_embeddings", "persons", "faces", "face_person_rejections"]) expect(names).toContain(t);

    const root = seedScanRoot(db);
    const folder = seedFolder(db, root, "/library/2019");
    const id = seedMedia(db, folder, root);
    expect(db.prepare("SELECT filename FROM media WHERE id = ?").get(id)).toEqual({ filename: "IMG_0001.jpg" });
  });
});

it("removes obsolete AI screenshot tags while preserving personal and imported ones", async () => {
  const db = await createTestDb();
  try {
    const root = seedScanRoot(db), folder = seedFolder(db, root, "/library"), media = seedMedia(db, folder, root);
    const tags = new TagRepo(db);
    tags.addUser(media, "screenshot");
    tags.replaceImported(media, ["screenshot"]);
    tags.replaceAi(media, [{ name: "screenshot", score: 0.25 }, { name: "mountain", score: 0.30 }], "test-model:scene-v1");
    db.prepare("INSERT INTO media_analysis (media_id, analyzer, status, model_version) VALUES (?, 'ai_tags', 'done', 'test-model:scene-v1')").run(media);
    db.prepare("DELETE FROM schema_migrations WHERE name = '035_remove_ai_screenshot_tags.sql'").run();
    const logger = { info() {}, warn() {}, error() {} } as unknown as import("pino").Logger;
    await runMigrations(db, ":memory:", logger);
    expect(tags.listForMedia(media).map((tag) => `${tag.name}:${tag.source}`)).toEqual([
      "mountain:ai", "screenshot:user", "screenshot:imported",
    ]);
    expect(db.prepare("SELECT model_version FROM media_analysis WHERE media_id = ? AND analyzer = 'ai_tags'").get(media))
      .toEqual({ model_version: "test-model:scene-v2" });
  } finally { db.close(); }
});
