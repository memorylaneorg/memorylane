import { expect, it } from "vitest";
import { createTestDb, seedFolder, seedMedia, seedScanRoot } from "../helpers/db.js";
import { buildMediaQuery, mediaSelectSql } from "../../src/query/media-query.js";

it("excludes marked media from normal listings and can include it for cleanup", async () => {
  const db = await createTestDb();
  try {
    const root = seedScanRoot(db);
    const folder = seedFolder(db, root, "/library");
    const marked = seedMedia(db, folder, root);
    const visible = seedMedia(db, folder, root);
    db.prepare("INSERT INTO deletion_marks (media_id, reason) VALUES (?, 'user')").run(marked);

    const ids = (includeMarked: boolean) => {
      const q = buildMediaQuery({ includeMarked });
      return (db.prepare(mediaSelectSql(q)).all(...q.bindings, 100, 0) as { id: number }[]).map((r) => r.id);
    };
    expect(ids(false)).toEqual([visible]);
    expect(ids(true)).toEqual([marked, visible]);
  } finally { db.close(); }
});
