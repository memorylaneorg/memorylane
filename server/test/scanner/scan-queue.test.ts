import { describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/db.js";
import { ScannerService } from "../../src/scanner/scanner-service.js";
import type { AppPaths } from "../../src/config/paths.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as import("pino").Logger;

describe("scan queue", () => {
  it("starts the first folder immediately and scans later additions in order", async () => {
    const db = await createTestDb();
    const first = Number(db.prepare("INSERT INTO scan_roots (path, enabled) VALUES ('/first', 1)").run().lastInsertRowid);
    const second = Number(db.prepare("INSERT INTO scan_roots (path, enabled) VALUES ('/second', 1)").run().lastInsertRowid);
    const scanner = new ScannerService(db, { dataDir: "/data", thumbnailsDir: "/thumbs", previewsDir: "/previews" } as AppPaths, logger);
    const order: number[] = [];
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });

    (scanner as unknown as { scanRoot: (root: { id: number }) => Promise<void> }).scanRoot = async (root) => {
      order.push(root.id);
      if (root.id === first) await firstCanFinish;
    };

    expect(scanner.queueScan("manual", first)).toEqual({ queued: false });
    expect(scanner.isRunning()).toBe(true);
    expect(scanner.queueScan("manual", second)).toEqual({ queued: true });
    expect(scanner.queueScan("manual", second)).toEqual({ queued: true });
    expect(scanner.getStatus().queuedScanRootIds).toEqual([second]);

    releaseFirst();
    const deadline = Date.now() + 2_000;
    while ((scanner.isRunning() || scanner.getStatus().queuedScanRootIds.length) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(scanner.isRunning()).toBe(false);
    expect(order).toEqual([first, second]);
    expect((db.prepare("SELECT COUNT(*) AS count FROM scan_runs WHERE status = 'completed'").get() as { count: number }).count).toBe(2);
    db.close();
  });
});
