import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb } from "../helpers/db.js";
import { ScannerService } from "../../src/scanner/scanner-service.js";
import type { AppPaths } from "../../src/config/paths.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as import("pino").Logger;

describe("Photos library scanner boundary", () => {
  it("never indexes files inside a MemoryLane trash folder", async () => {
    const db = await createTestDb();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-trash-scan-"));
    const trash = path.join(root, "_MemoryLane-Trash", "123");
    fs.mkdirSync(trash, { recursive: true });
    fs.writeFileSync(path.join(trash, "photo.jpg"), "test");
    db.prepare("INSERT INTO scan_roots (path, enabled) VALUES (?, 1)").run(root);
    const paths = { dataDir: root, thumbnailsDir: path.join(root, "thumbs"), previewsDir: path.join(root, "previews") } as AppPaths;
    try {
      await new ScannerService(db, paths, logger).runScan("manual");
      expect((db.prepare("SELECT COUNT(*) AS c FROM media").get() as { c: number }).c).toBe(0);
    } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("never descends into a Photos package during a generic folder scan", async () => {
    const db = await createTestDb();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-photos-scan-"));
    const library = path.join(root, "Pictures.photoslibrary");
    fs.mkdirSync(path.join(library, "originals"), { recursive: true });
    fs.writeFileSync(path.join(library, "originals", "photo.jpg"), "test");
    db.prepare("INSERT INTO scan_roots (path, enabled) VALUES (?, 1)").run(root);
    const paths = { dataDir: root, thumbnailsDir: path.join(root, "thumbs"), previewsDir: path.join(root, "previews") } as AppPaths;
    try {
      await new ScannerService(db, paths, logger).runScan("manual");
      expect((db.prepare("SELECT COUNT(*) AS c FROM media").get() as { c: number }).c).toBe(0);
      expect((db.prepare("SELECT COUNT(*) AS c FROM folders WHERE absolute_path = ?").get(library) as { c: number }).c).toBe(0);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not treat an Apple root as a generic file tree when the plugin is disabled", async () => {
    const db = await createTestDb();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-photos-root-"));
    const library = path.join(root, "Pictures.photoslibrary");
    fs.mkdirSync(path.join(library, "originals"), { recursive: true });
    fs.writeFileSync(path.join(library, "originals", "photo.jpg"), "test");
    db.prepare("INSERT INTO scan_roots (path, enabled, kind) VALUES (?, 1, 'apple-photos')").run(library);
    const paths = { dataDir: root, thumbnailsDir: path.join(root, "thumbs"), previewsDir: path.join(root, "previews") } as AppPaths;
    try {
      await new ScannerService(db, paths, logger).runScan("manual");
      expect((db.prepare("SELECT COUNT(*) AS c FROM media").get() as { c: number }).c).toBe(0);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("delegates an enabled Apple root to catalogue sync without walking its package", async () => {
    const db = await createTestDb();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-photos-delegate-"));
    const library = path.join(root, "Pictures.photoslibrary");
    fs.mkdirSync(path.join(library, "originals"), { recursive: true });
    fs.writeFileSync(path.join(library, "originals", "photo.jpg"), "test");
    const rootId = Number(db.prepare("INSERT INTO scan_roots (path, enabled, kind) VALUES (?, 1, 'apple-photos')").run(library).lastInsertRowid);
    db.prepare("INSERT INTO plugin_settings (id, enabled) VALUES ('apple-photos', 1)").run();
    const paths = { dataDir: root, thumbnailsDir: path.join(root, "thumbs"), previewsDir: path.join(root, "previews") } as AppPaths;
    const scanner = new ScannerService(db, paths, logger);
    const called: number[] = [];
    scanner.onAppleRootSync(async (id) => { called.push(id); });
    try {
      await scanner.runScan("manual", rootId);
      expect(called).toEqual([rootId]);
      expect((db.prepare("SELECT COUNT(*) AS c FROM media").get() as { c: number }).c).toBe(0);
    } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
});
