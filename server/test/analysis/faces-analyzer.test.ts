import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createTestDb, seedScanRoot, seedFolder, seedMedia } from "../helpers/db.js";
import { startFakeSidecar, type FakeSidecar } from "../helpers/fake-sidecar.js";
import { createFacesAnalyzer } from "../../src/analysis/analyzers/faces.js";
import { SidecarProvider } from "../../src/providers/sidecar-provider.js";
import { MemoryVectorIndex } from "../../src/vectors/memory-vector-index.js";
import { spaceFor } from "../../src/vectors/vector-index.js";
import type { AppPaths } from "../../src/config/paths.js";
import { SettingsRepo } from "../../src/db/settings-repo.js";

let fake: FakeSidecar;
let dir: string;
beforeAll(async () => {
  fake = await startFakeSidecar();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-faces-"));
});
afterAll(async () => {
  await fake.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("faces analyzer", () => {
  it("stores faces + vectors, replaces on re-run, hands new ids to the callback", async () => {
    const db = await createTestDb();
    const root = seedScanRoot(db), folder = seedFolder(db, root, "/lib");
    // The fake sidecar derives face count from the JPEG's first byte (0xFF for
    // JPEG = 255 % 3 = 0 faces) - so hand it PNG-free images through the
    // analysis renderer... instead we bypass rendering by pointing at a file the
    // renderer will produce deterministically: rendered JPEGs start with 0xFF,
    // 255 % 3 == 0 -> zero faces. Use the raw path: RAW previews are passed
    // through as-is, so craft preview bytes with a chosen first byte.
    const paths = { previewsDir: path.join(dir, "previews"), thumbnailsDir: path.join(dir, "thumbs"), vectorsDir: path.join(dir, "vectors") } as AppPaths;
    const raw = seedMedia(db, folder, root, { filename: "a.cr3", media_type: "raw" });
    const previewPath = path.join(paths.previewsDir, "00", "00", `${raw}.jpg`);
    fs.mkdirSync(path.dirname(previewPath), { recursive: true });
    fs.writeFileSync(previewPath, Buffer.from([2, 9, 9, 9, 9])); // 2 faces
    const video = seedMedia(db, folder, root, { filename: "v.mp4", media_type: "video" });
    const provider = new SidecarProvider(fake.url, { expectedModel: fake.model, healthTtlMs: 0 });
    const index = new MemoryVectorIndex();
    const received: number[][] = [];
    const analyzer = createFacesAnalyzer(db, paths, provider, index, new SettingsRepo(db), () => true, async (ids) => {
      received.push(ids);
    });
    const rows = [
      { id: raw, parent_folder_id: folder, absolute_path: "/x.cr3", media_type: "raw" as const },
      { id: video, parent_folder_id: folder, absolute_path: "/v.mp4", media_type: "video" as const },
    ];
    const out = await analyzer.run(rows);
    expect(out.map((o) => o.status)).toEqual(["done", "unsupported"]);
    expect((db.prepare("SELECT COUNT(*) c FROM faces").get() as { c: number }).c).toBe(2);
    expect(await index.count(spaceFor("faces", "yunet-sface@1"))).toBe(2);
    expect(received[0]).toHaveLength(2);
    await analyzer.run(rows.slice(0, 1));
    expect((db.prepare("SELECT COUNT(*) c FROM faces").get() as { c: number }).c).toBe(2); // replaced, not duplicated
    expect(await index.count(spaceFor("faces", "yunet-sface@1"))).toBe(2);
    await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } }).jpeg().toFile(path.join(dir, "unused.jpg"));
  });
});
