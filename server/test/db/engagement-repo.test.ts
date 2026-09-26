import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { EngagementRepo } from "../../src/db/engagement-repo.js";
import { createTestDb, seedFolder, seedMedia, seedScanRoot } from "../helpers/db.js";

describe("EngagementRepo", () => {
  let db: Database.Database | undefined;
  afterEach(() => db?.close());

  it("creates and increments shown and viewed counters with one upsert per event", async () => {
    db = await createTestDb();
    const root = seedScanRoot(db);
    const folder = seedFolder(db, root, "/library/photos");
    const mediaId = seedMedia(db, folder, root);
    const repo = new EngagementRepo(db);

    repo.recordShown(mediaId);
    repo.recordShown(mediaId);
    repo.recordViewed(mediaId);
    repo.recordViewed(mediaId);

    const row = db.prepare("SELECT * FROM media_engagement WHERE media_id = ?").get(mediaId) as {
      shown_count: number;
      view_count: number;
      first_viewed_at: string | null;
      last_viewed_at: string | null;
    };
    expect(row.shown_count).toBe(2);
    expect(row.view_count).toBe(2);
    expect(row.first_viewed_at).not.toBeNull();
    expect(row.last_viewed_at).not.toBeNull();
  });

  it("preserves counters when setting a favorite on an existing row", async () => {
    db = await createTestDb();
    const root = seedScanRoot(db);
    const folder = seedFolder(db, root, "/library/photos");
    const mediaId = seedMedia(db, folder, root);
    const repo = new EngagementRepo(db);

    repo.recordShown(mediaId);
    repo.setFavorite(mediaId, true);

    const row = db.prepare("SELECT favorite, shown_count FROM media_engagement WHERE media_id = ?").get(mediaId) as {
      favorite: number;
      shown_count: number;
    };
    expect(row).toEqual({ favorite: 1, shown_count: 1 });
  });
});
