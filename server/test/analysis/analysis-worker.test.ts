import { describe, it, expect } from "vitest";
import { createTestDb, seedScanRoot, seedFolder, seedMedia } from "../helpers/db.js";
import { AnalysisWorker } from "../../src/analysis/analysis-worker.js";
import { AnalysisRepo } from "../../src/analysis/analysis-repo.js";
import type { Analyzer, AnalysisMediaRow } from "../../src/analysis/types.js";
import { CapabilityUnavailableError } from "../../src/capabilities/errors.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as import("pino").Logger;

function fakeAnalyzer(overrides: Partial<Analyzer> = {}): Analyzer & { seen: number[][] } {
  const seen: number[][] = [];
  return {
    key: "fake",
    version: "v1",
    batchSize: 2,
    appliesTo: "1=1",
    async run(rows: AnalysisMediaRow[]) {
      seen.push(rows.map((r) => r.id));
      return rows.map((r) => ({ mediaId: r.id, status: "done" as const }));
    },
    ...overrides,
    seen,
  };
}

async function setup(n: number) {
  const db = await createTestDb();
  const root = seedScanRoot(db);
  const folder = seedFolder(db, root, "/library/a");
  const ids = Array.from({ length: n }, () => seedMedia(db, folder, root));
  return { db, ids, repo: new AnalysisRepo(db) };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("AnalysisWorker", () => {
  it("enqueueAll + runOnce processes pending rows in batches of batchSize", async () => {
    const { db, ids } = await setup(3);
    const a = fakeAnalyzer();
    const w = new AnalysisWorker(db, logger, [a], () => false);
    expect(w.enqueueAll()).toBe(3);
    expect(await w.runOnce()).toBe(2);
    expect(await w.runOnce()).toBe(1);
    expect(await w.runOnce()).toBe(0);
    expect(a.seen).toEqual([[ids[0], ids[1]], [ids[2]]]);
    const st = w.getStatus();
    expect(st.analyzers[0].counts.done).toBe(3);
    expect(st.analyzers[0].counts.pending).toBe(0);
  });

  it("marks the whole batch failed when run() throws", async () => {
    const { db } = await setup(1);
    const a = fakeAnalyzer({ run: async () => { throw new Error("provider down"); } });
    const w = new AnalysisWorker(db, logger, [a], () => false);
    w.enqueueAll();
    await w.runOnce();
    const row = db.prepare("SELECT status, error, attempts FROM media_analysis").get() as { status: string; error: string; attempts: number };
    expect(row.attempts).toBe(1);
    expect(row.status).toBe("pending"); // retried until MAX_ATTEMPTS
    expect(row.error).toContain("provider down");
  });

  it("returns work to pending without consuming an attempt when a capability is stopped", async () => {
    const { db } = await setup(1);
    const a = fakeAnalyzer({ run: async () => { throw new CapabilityUnavailableError("people.faces"); } });
    const w = new AnalysisWorker(db, logger, [a], () => false);
    w.enqueueAll();
    await w.runOnce();
    expect(db.prepare("SELECT status, attempts FROM media_analysis").get()).toEqual({ status: "pending", attempts: 0 });
  });

  it("start() reconciles interrupted rows and re-queues stale versions", async () => {
    const { db, ids, repo } = await setup(2);
    repo.markDone(ids[0], "fake", "v0"); // stale version
    repo.ensureQueued(fakeAnalyzer());
    repo.claimBatch(fakeAnalyzer({ batchSize: 1 })); // simulate a crash mid-run
    const a = fakeAnalyzer();
    const w = new AnalysisWorker(db, logger, [a], () => false, { idleMs: 5 });
    w.start();
    await wait(100);
    await w.stop();
    const st = w.getStatus().analyzers[0].counts;
    expect(st.done).toBe(2);
    expect(st.running).toBe(0);
  });

  it("does not run while paused", async () => {
    const { db } = await setup(1);
    const a = fakeAnalyzer();
    let paused = true;
    const w = new AnalysisWorker(db, logger, [a], () => paused, { idleMs: 5, pausedMs: 5 });
    w.start();
    await wait(40);
    expect(a.seen).toEqual([]);
    paused = false;
    await wait(60);
    await w.stop();
    expect(a.seen.length).toBe(1);
  });

  it("runs the idle hook only when no analyzer work remains", async () => {
    const { db } = await setup(1);
    const a = fakeAnalyzer();
    const calls: number[] = [];
    let remaining = 2;
    const w = new AnalysisWorker(db, logger, [a], () => false, {
      idleMs: 5,
      onIdle: () => {
        calls.push(a.seen.length);
        return remaining-- > 0 ? 1 : 0;
      },
    });
    w.start();
    await wait(80);
    await w.stop();
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.every((seenBatches) => seenBatches === 1)).toBe(true); // analyzer drained first
  });

  it("kick() clears backoff so a just-enabled provider retries immediately instead of waiting out the window", async () => {
    const { db } = await setup(1);
    let fail = true;
    const a = fakeAnalyzer({ run: async (rows) => {
      if (fail) throw new CapabilityUnavailableError("ai.image-embedding");
      return rows.map((r) => ({ mediaId: r.id, status: "done" as const }));
    } });
    const w = new AnalysisWorker(db, logger, [a], () => false);
    w.enqueueAll();
    await w.runOnce(); // fails, enters backoff
    expect(await w.runOnce()).toBe(0); // still backed off - skipped, not retried
    fail = false;
    w.kick(); // e.g. the provider's plugin was just enabled
    expect(await w.runOnce()).toBe(1); // retried immediately, backoff didn't block it
  });

  it.skipIf(process.platform !== "darwin")("returns an in-flight Apple result to pending when the plugin is disabled", async () => {
    const { db, ids } = await setup(1);
    db.prepare("UPDATE media SET source_kind = 'apple-photos' WHERE id = ?").run(ids[0]);
    db.prepare("INSERT INTO plugin_settings (id, enabled) VALUES ('apple-photos', 1)").run();
    const a = fakeAnalyzer({ run: async (rows) => {
      db.prepare("UPDATE plugin_settings SET enabled = 0 WHERE id = 'apple-photos'").run();
      return rows.map((r) => ({ mediaId: r.id, status: "done" as const }));
    } });
    const w = new AnalysisWorker(db, logger, [a], () => false);
    w.enqueueAll();
    await w.runOnce();
    expect(db.prepare("SELECT status FROM media_analysis WHERE media_id = ?").get(ids[0])).toEqual({ status: "pending" });
  });
});
