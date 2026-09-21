import { describe, it, expect } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb, seedScanRoot, seedFolder, seedMedia } from "../helpers/db.js";
import { AnalysisRepo, MAX_ATTEMPTS } from "../../src/analysis/analysis-repo.js";
import type { Analyzer } from "../../src/analysis/types.js";

const stills: Analyzer = { key: "t", version: "v1", batchSize: 10, appliesTo: "media_type IN ('image','raw')", run: async () => [] };

async function setup() {
  const db = await createTestDb();
  const root = seedScanRoot(db);
  const folder = seedFolder(db, root, "/library/a");
  const repo = new AnalysisRepo(db);
  return { db, root, folder, repo };
}

const statusOf = (db: Database.Database, id: number) =>
  db.prepare("SELECT status, attempts, model_version FROM media_analysis WHERE media_id = ? AND analyzer = 't'").get(id) as
    | { status: string; attempts: number; model_version: string | null }
    | undefined;

describe("AnalysisRepo", () => {
  it("does not queue or claim marked media", async () => {
    const { db, root, folder, repo } = await setup();
    const marked = seedMedia(db, folder, root);
    const visible = seedMedia(db, folder, root);
    repo.ensureQueued(stills);
    db.prepare("INSERT INTO deletion_marks (media_id) VALUES (?)").run(marked);
    expect(repo.claimBatch(stills).map((row) => row.id)).toEqual([visible]);
    const later = seedMedia(db, folder, root);
    db.prepare("INSERT INTO deletion_marks (media_id) VALUES (?)").run(later);
    expect(repo.ensureQueued(stills)).toBe(0);
  });
  it("ensureQueued adds pending rows only for matching active media, idempotently", async () => {
    const { db, root, folder, repo } = await setup();
    const a = seedMedia(db, folder, root);
    seedMedia(db, folder, root, { media_type: "video", filename: "v.mp4" });
    seedMedia(db, folder, root, { status: "missing" });
    expect(repo.ensureQueued(stills)).toBe(1);
    expect(repo.ensureQueued(stills)).toBe(0);
    expect(statusOf(db, a)?.status).toBe("pending");
  });

  it("queues dependent work only for completed media IDs", async () => {
    const { db, root, folder, repo } = await setup();
    const first = seedMedia(db, folder, root);
    const second = seedMedia(db, folder, root);
    expect(repo.ensureQueuedForIds(stills, [first])).toBe(1);
    expect(statusOf(db, first)?.status).toBe("pending");
    expect(statusOf(db, second)).toBeUndefined();
  });

  it("claimBatch marks rows running and returns media rows; complete records outcomes", async () => {
    const { db, root, folder, repo } = await setup();
    const a = seedMedia(db, folder, root);
    const b = seedMedia(db, folder, root);
    repo.ensureQueued(stills);
    const batch = repo.claimBatch(stills);
    expect(batch.map((r) => r.id).sort()).toEqual([a, b]);
    expect(statusOf(db, a)?.status).toBe("running");
    expect(repo.claimBatch(stills)).toEqual([]);

    repo.complete("t", "v1", [
      { mediaId: a, status: "done" },
      { mediaId: b, status: "failed", error: "boom" },
    ]);
    expect(statusOf(db, a)).toEqual({ status: "done", attempts: 1, model_version: "v1" });
    // First failure goes straight back to pending (retried up to MAX_ATTEMPTS).
    expect(statusOf(db, b)?.status).toBe("pending");
    expect(statusOf(db, b)?.attempts).toBe(1);
  });

  it("gives up after MAX_ATTEMPTS failures and retryFailed re-queues", async () => {
    const { db, root, folder, repo } = await setup();
    const a = seedMedia(db, folder, root);
    repo.ensureQueued(stills);
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      repo.claimBatch(stills);
      repo.complete("t", "v1", [{ mediaId: a, status: "failed", error: "x" }]);
    }
    expect(statusOf(db, a)).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
    expect(repo.claimBatch(stills)).toEqual([]);
    expect(repo.retryFailed("t")).toBe(1);
    expect(statusOf(db, a)).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("markDone upserts a done row; requeueStaleVersions re-queues older versions only", async () => {
    const { db, root, folder, repo } = await setup();
    const a = seedMedia(db, folder, root);
    const b = seedMedia(db, folder, root);
    repo.markDone(a, "t", "v0");
    repo.markDone(b, "t", "v1");
    expect(repo.requeueStaleVersions(stills)).toBe(1);
    expect(statusOf(db, a)?.status).toBe("pending");
    expect(statusOf(db, b)?.status).toBe("done");
  });

  it("resetForMedia and resetRunning return rows to pending", async () => {
    const { db, root, folder, repo } = await setup();
    const a = seedMedia(db, folder, root);
    repo.markDone(a, "t", "v1");
    repo.resetForMedia(a);
    expect(statusOf(db, a)?.status).toBe("pending");
    repo.claimBatch(stills);
    expect(statusOf(db, a)?.status).toBe("running");
    expect(repo.resetRunning()).toBe(1);
    expect(statusOf(db, a)?.status).toBe("pending");
  });

  it("counts groups by analyzer and status", async () => {
    const { db, root, folder, repo } = await setup();
    seedMedia(db, folder, root);
    seedMedia(db, folder, root);
    repo.ensureQueued(stills);
    expect(repo.counts()).toEqual([{ analyzer: "t", status: "pending", count: 2 }]);
  });
});
