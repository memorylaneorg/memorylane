import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb, seedFolder, seedMedia, seedScanRoot } from "../helpers/db.js";
import { ApplePhotoPreparation } from "../../src/plugins/apple-photos/preparation.js";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
async function setup(download = vi.fn(async (_id: number, _signal: AbortSignal) => jpeg)) {
  const db = await createTestDb();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "apple-preparation-test-"));
  const root = seedScanRoot(db), folder = seedFolder(db, root, "/library");
  const ids = [seedMedia(db, folder, root), seedMedia(db, folder, root)];
  const selected = new Set(ids);
  let enabled = true;
  let worker = new ApplePhotoPreparation(db, { dataDir }, download, id => selected.has(id) && !!db.prepare("SELECT 1 FROM media WHERE id=?").get(id), () => enabled);
  cleanups.push(async () => { await worker.close(); db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { db, dataDir, ids, selected, download, get worker() { return worker; },
    enable(value: boolean) { enabled = value; },
    async restart() { await worker.close(); worker = new ApplePhotoPreparation(db, { dataDir }, download, id => selected.has(id) && !!db.prepare("SELECT 1 FROM media WHERE id=?").get(id), () => enabled); },
  };
}

describe("Apple Photos explicit preparation", () => {
  it("does not discover selected items; explicit requests persist and publish cache atomically", async () => {
    const t = await setup();
    expect(t.worker.status().queued).toBe(0);
    t.worker.configure({ paused: true });
    expect(t.worker.enqueue(t.ids)).toBe(2);
    expect(t.worker.enqueue(t.ids)).toBe(0);
    await t.restart();
    expect(t.worker.status()).toMatchObject({ paused: true, queued: 2, ready: 0 });
    t.worker.configure({ paused: false });
    await vi.waitFor(() => expect(t.worker.status().ready).toBe(2));
    expect(fs.readFileSync(t.worker.readPath(t.ids[0])!)).toEqual(jpeg);
    expect(t.worker.status().usageBytes).toBe(jpeg.length * 2);
  });

  it("does not retry failures until explicitly requested", async () => {
    const download = vi.fn(async () => { throw new Error("Cloud unavailable"); return jpeg; });
    const t = await setup(download);
    t.worker.enqueue([t.ids[0]]);
    await vi.waitFor(() => expect(t.worker.status().failed).toBe(1));
    t.worker.enqueue([t.ids[0]]);
    await t.restart();
    expect(download).toHaveBeenCalledTimes(1);
    download.mockResolvedValue(jpeg);
    expect(t.worker.retry([t.ids[0]])).toBe(1);
    await vi.waitFor(() => expect(t.worker.status().ready).toBe(1));
  });

  it("pauses unavailable sources and cancels revoked selection without publishing bytes", async () => {
    let finish: (value: Buffer) => void = () => {};
    let signal: AbortSignal | undefined;
    const download = vi.fn((_id: number, s: AbortSignal) => { signal = s; return new Promise<Buffer>(resolve => { finish = resolve; }); });
    const t = await setup(download);
    t.enable(false);
    t.worker.enqueue([t.ids[0]]);
    expect(t.worker.status().queued).toBe(1);
    t.enable(true);
    await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    t.selected.delete(t.ids[0]);
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    finish(jpeg);
    await vi.waitFor(() => expect(t.worker.status().running).toBe(0));
    expect(t.worker.readPath(t.ids[0])).toBeNull();
    expect(t.worker.status().failed).toBe(0);
  });

  it("blocks before downloading over budget and resumes after increasing it", async () => {
    const t = await setup();
    t.worker.configure({ cacheMiB: 1 });
    t.worker.enqueue([t.ids[0]]);
    await vi.waitFor(() => expect(t.worker.status().blocked).toBe(1));
    expect(t.download).not.toHaveBeenCalled();
    t.worker.configure({ cacheMiB: 100 });
    await vi.waitFor(() => expect(t.worker.status().ready).toBe(1));
  });

  it("clear cancels active work, pauses persistently, and preserves unrelated storage", async () => {
    const t = await setup();
    fs.writeFileSync(path.join(t.dataDir, "original.jpg"), jpeg);
    t.worker.enqueue(t.ids);
    await vi.waitFor(() => expect(t.worker.status().ready).toBe(2));
    expect(await t.worker.clear()).toMatchObject({ paused: true, ready: 0, queued: 0, usageBytes: 0 });
    await t.restart();
    expect(t.worker.status().paused).toBe(true);
    expect(fs.readFileSync(path.join(t.dataDir, "original.jpg"))).toEqual(jpeg);
  });

  it("cancels disabled-source downloads without failure and resumes queued work", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const download = vi.fn(async (_id: number, _signal: AbortSignal) => jpeg)
      .mockImplementationOnce((_id, s) => { signal = s; return new Promise<Buffer>(() => {}); });
    const t = await setup(download);
    t.worker.enqueue([t.ids[0]]);
    await vi.advanceTimersByTimeAsync(250);
    expect(t.worker.status().running).toBe(1);
    t.enable(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(signal?.aborted).toBe(true);
    expect(t.worker.status()).toMatchObject({ queued: 1, failed: 0, running: 0 });
    t.enable(true);
    await vi.advanceTimersByTimeAsync(750);
    expect(t.worker.status().ready).toBe(1);
    expect(t.worker.readPath(t.ids[0])).not.toBeNull();
    t.enable(false);
    expect(t.worker.readPath(t.ids[0])).toBeNull();
  });

  it("enforces a download deadline even if a helper ignores cancellation", async () => {
    vi.useFakeTimers();
    const t = await setup(vi.fn(() => new Promise<Buffer>(() => {})));
    t.worker.enqueue([t.ids[0]]);
    await vi.advanceTimersByTimeAsync(120_500);
    expect(t.worker.status()).toMatchObject({ failed: 1, running: 0, lastError: "download-timeout" });
    await vi.advanceTimersByTimeAsync(120_500);
    expect(t.download).toHaveBeenCalledTimes(1);
  });

  it("clear prevents an old in-flight response from refilling the cache", async () => {
    vi.useFakeTimers();
    let finish: (value: Buffer) => void = () => {};
    const t = await setup(vi.fn(() => new Promise<Buffer>(resolve => { finish = resolve; })));
    t.worker.enqueue(t.ids);
    await vi.advanceTimersByTimeAsync(250);
    const cleared = await t.worker.clear();
    expect(cleared).toMatchObject({ paused: true, queued: 0, running: 0, ready: 0 });
    finish(jpeg);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.worker.status().usageBytes).toBe(0);
    expect(t.worker.readPath(t.ids[0])).toBeNull();
  });

  it("blocks low-disk requests and leaves them for an explicit retry", async () => {
    vi.useFakeTimers();
    const t = await setup();
    const original = fs.statfsSync(t.dataDir);
    vi.spyOn(fs, "statfsSync").mockReturnValue({ ...original, bsize: 1024, bavail: 1 });
    t.worker.enqueue([t.ids[0]]);
    await vi.advanceTimersByTimeAsync(500);
    expect(t.worker.status()).toMatchObject({ blocked: 1, lastError: "disk-reserve" });
    expect(t.download).not.toHaveBeenCalled();
    vi.mocked(fs.statfsSync).mockReturnValue(original);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.download).not.toHaveBeenCalled();
    t.worker.retry([t.ids[0]]);
    await vi.advanceTimersByTimeAsync(500);
    expect(t.worker.status().ready).toBe(1);
  });


  it("drains for data relocation without changing the user's persisted pause preference", async () => {
    vi.useFakeTimers();
    const download = vi.fn(async (_id: number, _signal: AbortSignal) => jpeg)
      .mockImplementationOnce(() => new Promise<Buffer>(() => {}));
    const t = await setup(download);
    t.worker.enqueue([t.ids[0]]);
    await vi.advanceTimersByTimeAsync(250);
    const resume = await t.worker.pauseForMove();
    expect(t.worker.status()).toMatchObject({ paused: false, queued: 1, running: 0 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(download).toHaveBeenCalledTimes(1);
    resume(); resume();
    await vi.advanceTimersByTimeAsync(750);
    expect(t.worker.status().ready).toBe(1);
  });

  it("hides deselected failures and progress while retaining actual cache usage", async () => {
    vi.useFakeTimers();
    const download = vi.fn(async (_id: number, _signal: AbortSignal) => jpeg)
      .mockRejectedValueOnce(new Error("Old cloud failure"));
    const t = await setup(download);
    t.worker.enqueue(t.ids);
    await vi.advanceTimersByTimeAsync(750);
    expect(t.worker.status()).toMatchObject({ failed: 1, ready: 1, lastError: "Old cloud failure" });
    t.selected.delete(t.ids[0]);
    expect(t.worker.retry([t.ids[0]])).toBe(0);
    expect(t.worker.status()).toMatchObject({ failed: 0, ready: 1, lastError: null });
    t.enable(false);
    expect(t.worker.status().ready).toBe(1);
    t.selected.delete(t.ids[1]);
    expect(t.worker.status()).toMatchObject({ failed: 0, ready: 0, usageBytes: jpeg.length, lastError: null });
  });

  it("refreshes thumbnail URLs when prepared bytes publish and clear, preserving indexed status", async () => {
    vi.useFakeTimers();
    const t = await setup();
    const id = t.ids[0];
    t.db.prepare("UPDATE media SET thumbnail_status='unsupported' WHERE id=?").run(id);
    const before = t.db.prepare("SELECT thumbnail_version FROM media WHERE id=?").get(id) as { thumbnail_version: number };
    t.worker.enqueue([id]);
    await vi.advanceTimersByTimeAsync(500);
    expect(t.db.prepare("SELECT thumbnail_version,thumbnail_status FROM media WHERE id=?").get(id)).toEqual({ thumbnail_version: before.thumbnail_version + 1, thumbnail_status: 'unsupported' });
    await t.worker.clear();
    expect(t.db.prepare("SELECT thumbnail_version,thumbnail_status FROM media WHERE id=?").get(id)).toEqual({ thumbnail_version: before.thumbnail_version + 2, thumbnail_status: 'unsupported' });
  });

});
