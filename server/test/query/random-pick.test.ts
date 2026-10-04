import { describe, expect, it } from "vitest";
import { createTestDb, seedFolder, seedMedia, seedScanRoot } from "../helpers/db.js";
import { probeRandomMediaIds } from "../../src/query/random-pick.js";

async function seeded(count: number) {
  const db = await createTestDb();
  const root = seedScanRoot(db);
  const folder = seedFolder(db, root, "/library");
  for (let i = 0; i < count; i += 1) seedMedia(db, folder, root, { filename: `${i}.jpg` });
  return db;
}

describe("probeRandomMediaIds", () => {
  it("returns the requested number of distinct eligible ids", async () => {
    const db = await seeded(300);
    const ids = probeRandomMediaIds(db, { count: 30, where: "media.status = 'active'" });
    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
    db.close();
  });

  it("only returns ids that satisfy the filter", async () => {
    const db = await seeded(300);
    const ids = probeRandomMediaIds(db, { count: 10, where: "media.id % 2 = 0" });
    expect(ids).toHaveLength(10);
    expect(ids!.every((id) => id % 2 === 0)).toBe(true);
    db.close();
  });

  it("returns null when it cannot fill the request so callers use their exact query", async () => {
    const db = await seeded(20);
    expect(probeRandomMediaIds(db, { count: 50, where: "media.status = 'active'" })).toBeNull();
    expect(probeRandomMediaIds(db, { count: 5, where: "0=1" })).toBeNull();
    db.close();
  });
});
