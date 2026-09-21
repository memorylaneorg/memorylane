import { expect, it } from "vitest";
import { createTestDb, seedFolder, seedMedia, seedScanRoot } from "../helpers/db.js";
import { TagRepo } from "../../src/tags/tag-repo.js";

it("refreshes imported keywords without erasing a user's tag", async () => {
  const db = await createTestDb();
  try {
    const root = seedScanRoot(db), folder = seedFolder(db, root, "/library"), media = seedMedia(db, folder, root);
    const tags = new TagRepo(db);
    tags.addUser(media, "landscape");
    tags.replaceImported(media, [" Mountain ", "lake"]);
    tags.replaceImported(media, ["mountain", "forest"]);
    expect(tags.listForMedia(media).map(({ name, source }) => `${name}:${source}`))
      .toEqual(["forest:imported", "landscape:user", "mountain:imported"]);
  } finally { db.close(); }
});

it("keeps a dismissed AI tag suppressed across regeneration while preserving a user tag", async () => {
  const db = await createTestDb();
  try {
    const root = seedScanRoot(db), folder = seedFolder(db, root, "/library"), media = seedMedia(db, folder, root);
    const tags = new TagRepo(db);
    tags.addUser(media, "mountain");
    tags.replaceAi(media, [{ name: "mountain", score: 0.31 }, { name: "lake", score: 0.28 }], "clip-v1");
    const lakeId = tags.listForMedia(media).find((tag) => tag.name === "lake")!.id;
    expect(tags.remove(media, lakeId, "ai")).toBe(true);
    tags.replaceAi(media, [{ name: "lake", score: 0.35 }, { name: "mountain", score: 0.32 }], "clip-v2");
    expect(tags.listForMedia(media).map(({ name, source }) => `${name}:${source}`))
      .toEqual(["mountain:user", "mountain:ai"]);
  } finally { db.close(); }
});

it("removing an AI source leaves the same user's tag in place", async () => {
  const db = await createTestDb();
  try {
    const root = seedScanRoot(db), folder = seedFolder(db, root, "/library"), media = seedMedia(db, folder, root);
    const tags = new TagRepo(db);
    const manual = tags.addUser(media, "mountain");
    tags.replaceAi(media, [{ name: "mountain", score: 0.34 }], "clip-v1");
    expect(tags.remove(media, manual.id, "ai")).toBe(true);
    tags.replaceAi(media, [{ name: "mountain", score: 0.38 }], "clip-v2");
    expect(tags.listForMedia(media).map((tag) => tag.source)).toEqual(["user"]);
  } finally { db.close(); }
});
