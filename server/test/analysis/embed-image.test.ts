import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createTestDb, seedScanRoot, seedFolder, seedMedia } from "../helpers/db.js";
import { startFakeSidecar, type FakeSidecar } from "../helpers/fake-sidecar.js";
import { createEmbedImageAnalyzer } from "../../src/analysis/analyzers/embed-image.js";
import { AnalysisWorker } from "../../src/analysis/analysis-worker.js";
import { SidecarProvider } from "../../src/providers/sidecar-provider.js";
import { ProviderUnavailableError } from "../../src/providers/types.js";
import { MemoryVectorIndex } from "../../src/vectors/memory-vector-index.js";
import { EmbeddingRepo } from "../../src/vectors/embedding-repo.js";
import { spaceFor } from "../../src/vectors/vector-index.js";
import { thumbnailPathForMediaId, type AppPaths } from "../../src/config/paths.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as import("pino").Logger;
let fake: FakeSidecar;
let dataDir: string;
beforeAll(async () => {
  fake = await startFakeSidecar();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-embed-"));
});
afterAll(async () => {
  await fake.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function setup() {
  const db = await createTestDb();
  const root = seedScanRoot(db);
  const folder = seedFolder(db, root, "/lib");
  const paths = { thumbnailsDir: path.join(dataDir, "thumbs"), vectorsDir: path.join(dataDir, "vectors") } as AppPaths;
  const ids: number[] = [];
  for (const color of [{ r: 220, g: 20, b: 20 }, { r: 20, g: 20, b: 220 }, { r: 200, g: 200, b: 200 }]) {
    const id = seedMedia(db, folder, root);
    const p = thumbnailPathForMediaId(paths.thumbnailsDir, id);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    await sharp({ create: { width: 40, height: 30, channels: 3, background: color } }).jpeg().toFile(p);
    ids.push(id);
  }
  const noThumb = seedMedia(db, folder, root);
  const provider = new SidecarProvider(fake.url, { expectedModel: fake.model, healthTtlMs: 0 });
  const index = new MemoryVectorIndex();
  const analyzer = createEmbedImageAnalyzer(db, paths, provider, index, () => true);
  return { db, folder, ids, noThumb, provider, index, analyzer };
}

describe("embed_image analyzer", () => {
  it("embeds thumbnails into SQLite and the index, marks missing thumbnails unsupported, dirties the folder", async () => {
    const S = await setup();
    const rows = [...S.ids, S.noThumb].map((id) => ({ id, parent_folder_id: S.folder, absolute_path: "/x", media_type: "image" as const }));
    const out = await S.analyzer.run(rows);
    expect(out.map((o) => o.status)).toEqual(["done", "done", "done", "unsupported"]);
    const repo = new EmbeddingRepo(S.db);
    expect(repo.count(fake.model)).toBe(3);
    expect(await S.index.count(spaceFor("media", fake.model))).toBe(3);
    const q = repo.get(S.ids[0], fake.model)!;
    expect((await S.index.search(spaceFor("media", fake.model), q, 1))[0].id).toBe(S.ids[0]);
    expect((S.db.prepare("SELECT COUNT(*) c FROM stack_dirty_folders").get() as { c: number }).c).toBe(1);
  });

  it("propagates outages as ProviderUnavailableError", async () => {
    const S = await setup();
    fake.setFailing(503);
    try {
      await expect(S.analyzer.run([{ id: S.ids[0], parent_folder_id: S.folder, absolute_path: "/x", media_type: "image" }])).rejects.toBeInstanceOf(
        ProviderUnavailableError,
      );
    } finally {
      fake.setFailing(null);
    }
  });

  it("worker backs off on outages without failing rows, then resumes", async () => {
    const S = await setup();
    const w = new AnalysisWorker(S.db, logger, [S.analyzer], () => false, { provider: S.provider });
    w.enqueueAll();
    fake.setFailing(503);
    expect(await w.runOnce()).toBe(0);
    let st = w.getStatus();
    expect(st.analyzers[0].counts.pending).toBe(4);
    expect(st.analyzers[0].counts.failed).toBe(0);
    expect(st.analyzers[0].backoffUntil).not.toBeNull();
    expect(st.provider?.reachable).toBe(false);
    expect((S.db.prepare("SELECT MAX(attempts) m FROM media_analysis").get() as { m: number }).m).toBe(0);
    expect(await w.runOnce()).toBe(0); // still backing off - nothing claimed
    fake.setFailing(null);
    // Force the backoff to expire without waiting.
    (w as unknown as { backoff: Map<string, { until: number; delayMs: number }> }).backoff.set("embed_image", { until: 0, delayMs: 5000 });
    expect(await w.runOnce()).toBe(4);
    st = w.getStatus();
    expect(st.analyzers[0].counts.done).toBe(3);
    expect(st.analyzers[0].backoffUntil).toBeNull();
  });

  it("skips a disabled analyzer", async () => {
    const S = await setup();
    let enabled = false;
    const a = createEmbedImageAnalyzer(S.db, {} as AppPaths, S.provider, S.index, () => enabled);
    const w = new AnalysisWorker(S.db, logger, [a], () => false);
    w.enqueueAll();
    expect(await w.runOnce()).toBe(0);
    expect(w.getStatus().analyzers[0].enabled).toBe(false);
    enabled = true;
    expect(w.getStatus().analyzers[0].enabled).toBe(true);
  });

  it("does not send an Apple thumbnail to AI if the plugin is disabled during health check", async () => {
    const S = await setup();
    S.db.prepare("UPDATE media SET source_kind = 'apple-photos' WHERE id = ?").run(S.ids[0]);
    S.db.prepare("INSERT INTO plugin_settings (id, enabled) VALUES ('apple-photos', 1)").run();
    const realHealth = S.provider.health.bind(S.provider);
    S.provider.health = async (...args) => {
      const status = await realHealth(...args);
      S.db.prepare("UPDATE plugin_settings SET enabled = 0 WHERE id = 'apple-photos'").run();
      return status;
    };
    let sent = false;
    S.provider.embedImages = async () => { sent = true; throw new Error("Should not send disabled source"); };
    const result = await S.analyzer.run([{ id: S.ids[0], parent_folder_id: S.folder, absolute_path: "/x", media_type: "image" }]);
    expect(sent).toBe(false);
    expect(result[0].status).toBe("unsupported");
  });
});
