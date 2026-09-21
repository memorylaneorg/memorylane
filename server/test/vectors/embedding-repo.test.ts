import { describe, it, expect } from "vitest";
import { createTestDb, seedScanRoot, seedFolder, seedMedia } from "../helpers/db.js";
import { EmbeddingRepo, vectorToBlob, blobToVector, VECTOR_READ_PAGE_SIZE } from "../../src/vectors/embedding-repo.js";

describe("EmbeddingRepo", () => {
  it("round-trips float32 vectors through BLOBs", () => {
    const v = Float32Array.from([0.1, -0.5, 1, 0]);
    expect(Array.from(blobToVector(vectorToBlob(v)))).toEqual(Array.from(v));
  });

  it("upserts, counts, iterates in id order and overwrites", async () => {
    const db = await createTestDb();
    const root = seedScanRoot(db);
    const folder = seedFolder(db, root, "/lib");
    const a = seedMedia(db, folder, root), b = seedMedia(db, folder, root);
    const repo = new EmbeddingRepo(db);
    repo.upsertMany("m@1", [{ mediaId: b, vector: Float32Array.from([0, 1]) }, { mediaId: a, vector: Float32Array.from([1, 0]) }]);
    expect(repo.count("m@1")).toBe(2);
    expect(repo.count("other")).toBe(0);
    expect(repo.dim("m@1")).toBe(2);
    expect([...repo.iterate("m@1")].map((r) => r.id)).toEqual([a, b]);
    repo.upsertMany("m@1", [{ mediaId: a, vector: Float32Array.from([0.5, 0.5]) }]);
    expect(Array.from(repo.get(a, "m@1")!)).toEqual([0.5, 0.5]);
    expect(repo.get(a, "other")).toBeNull();
    expect(repo.deleteModel("m@1")).toBe(2);
  });

  it("allows database writes while a vector rebuild pauses between rows", async () => {
    const db = await createTestDb();
    const root = seedScanRoot(db);
    const folder = seedFolder(db, root, "/lib");
    const a = seedMedia(db, folder, root), b = seedMedia(db, folder, root);
    const repo = new EmbeddingRepo(db);
    repo.upsertMany("m@1", [
      { mediaId: a, vector: Float32Array.from([1, 0]) },
      { mediaId: b, vector: Float32Array.from([0, 1]) },
    ]);

    const rows = repo.iterate("m@1");
    expect(rows.next().value?.id).toBe(a);
    // The vector index awaits a disk write after each chunk, allowing request and
    // analysis handlers to use this same SQLite connection in the meantime.
    await Promise.resolve();
    expect(() => db.prepare("UPDATE media SET filename = ? WHERE id = ?").run("kept.jpg", b)).not.toThrow();
    expect(rows.next().value?.id).toBe(b);
    expect(rows.next().done).toBe(true);
  });

  it("reads every vector once across page boundaries", async () => {
    const db = await createTestDb();
    const root = seedScanRoot(db);
    const folder = seedFolder(db, root, "/lib");
    const ids = Array.from({ length: VECTOR_READ_PAGE_SIZE + 1 }, () => seedMedia(db, folder, root));
    const repo = new EmbeddingRepo(db);
    repo.upsertMany("m@1", ids.map((mediaId) => ({ mediaId, vector: Float32Array.from([1, 0]) })));

    expect([...repo.iterate("m@1")].map((row) => row.id)).toEqual(ids);
  });
});
