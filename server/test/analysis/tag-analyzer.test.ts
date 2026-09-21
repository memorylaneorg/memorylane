import { expect, it } from "vitest";
import { createTestDb, seedFolder, seedMedia, seedScanRoot } from "../helpers/db.js";
import { EmbeddingRepo } from "../../src/vectors/embedding-repo.js";
import { TagRepo } from "../../src/tags/tag-repo.js";
import { createAiTagAnalyzer } from "../../src/analysis/analyzers/ai-tags.js";
import type { EmbeddingProvider, ProviderInfo } from "../../src/providers/types.js";
import { AnalysisRepo } from "../../src/analysis/analysis-repo.js";
import { AnalysisWorker } from "../../src/analysis/analysis-worker.js";
import type { Analyzer } from "../../src/analysis/types.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as import("pino").Logger;

it("generates a scene tag from an existing image embedding without reading the photo", async () => {
  const db = await createTestDb();
  try {
    const root = seedScanRoot(db), folder = seedFolder(db, root, "/library"), media = seedMedia(db, folder, root);
    new EmbeddingRepo(db).upsertMany("test-model", [{ mediaId: media, vector: new Float32Array([1, 0]) }]);
    const info = { reachable: true, model: "test-model" } as ProviderInfo;
    const provider = {
      expectedModel: "test-model",
      health: async () => info,
      embedText: async (texts: string[]) => ({ model: "test-model", dim: 2,
        vectors: texts.map((text) => text.includes("mountain") ? new Float32Array([1, 0]) : new Float32Array([0, 1])) }),
    } as EmbeddingProvider;
    const analyzer = createAiTagAnalyzer(db, provider, () => true);
    const outcomes = await analyzer.run([{ id: media, parent_folder_id: folder, absolute_path: "/unused", media_type: "image" }]);
    expect(outcomes).toEqual([{ mediaId: media, status: "done" }]);
    expect(new TagRepo(db).listForMedia(media).filter((tag) => tag.source === "ai").map((tag) => tag.name)).toEqual(["mountain"]);
  } finally { db.close(); }
});

it("does not infer screenshot from text similarity alone", async () => {
  const db = await createTestDb();
  try {
    const root = seedScanRoot(db), folder = seedFolder(db, root, "/library"), media = seedMedia(db, folder, root);
    new EmbeddingRepo(db).upsertMany("test-model", [{ mediaId: media, vector: new Float32Array([1, 0]) }]);
    const provider = {
      expectedModel: "test-model",
      health: async () => ({ reachable: true }),
      embedText: async (texts: string[]) => ({ model: "test-model", dim: 2,
        vectors: texts.map((text) => text.includes("screenshot") ? new Float32Array([1, 0]) : new Float32Array([0, 1])) }),
    } as EmbeddingProvider;
    const analyzer = createAiTagAnalyzer(db, provider, () => true);
    await analyzer.run([{ id: media, parent_folder_id: folder, absolute_path: "/unused", media_type: "image" }]);
    expect(new TagRepo(db).listForMedia(media).filter((tag) => tag.source === "ai").map((tag) => tag.name)).not.toContain("screenshot");
  } finally { db.close(); }
});

it("backfills tags after image embeddings finish in the same worker pass", async () => {
  const db = await createTestDb();
  try {
    const root = seedScanRoot(db), folder = seedFolder(db, root, "/library"), media = seedMedia(db, folder, root);
    const provider = {
      expectedModel: "test-model", health: async () => ({ reachable: true }),
      embedText: async (texts: string[]) => ({ model: "test-model", dim: 2,
        vectors: texts.map((text) => text.includes("mountain") ? new Float32Array([1, 0]) : new Float32Array([0, 1])) }),
    } as EmbeddingProvider;
    const embed: Analyzer = { key: "embed_image", version: "test-model", batchSize: 10, appliesTo: "1=1", run: async (rows) => {
      new EmbeddingRepo(db).upsertMany("test-model", rows.map((row) => ({ mediaId: row.id, vector: new Float32Array([1, 0]) })));
      return rows.map((row) => ({ mediaId: row.id, status: "done" as const }));
    } };
    const worker = new AnalysisWorker(db, logger, [embed, createAiTagAnalyzer(db, provider, () => true)], () => false);
    expect(worker.enqueueAll()).toBe(1);
    expect(await worker.runOnce()).toBe(2);
    expect(new TagRepo(db).listForMedia(media).map((tag) => tag.name)).toEqual(["mountain"]);
  } finally { db.close(); }
});

it("waits for a current image embedding before claiming a pending tag job", async () => {
  const db = await createTestDb();
  try {
    const root = seedScanRoot(db), folder = seedFolder(db, root, "/library"), media = seedMedia(db, folder, root);
    const provider = { expectedModel: "test-model" } as EmbeddingProvider;
    const analyzer = createAiTagAnalyzer(db, provider, () => true);
    db.prepare("INSERT INTO media_analysis (media_id, analyzer, status) VALUES (?, 'ai_tags', 'pending')").run(media);
    const repo = new AnalysisRepo(db);
    expect(repo.claimBatch(analyzer)).toEqual([]);
    new EmbeddingRepo(db).upsertMany("test-model", [{ mediaId: media, vector: new Float32Array([1, 0]) }]);
    db.prepare("INSERT INTO media_analysis (media_id, analyzer, status, model_version, input_fingerprint) VALUES (?, 'embed_image', 'done', 'test-model', '1000:1')").run(media);
    expect(repo.claimBatch(analyzer).map((row) => row.id)).toEqual([media]);
  } finally { db.close(); }
});
