import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestApp } from "../helpers/app.js";
import { seedScanRoot, seedFolder, seedMedia } from "../helpers/db.js";
import { thumbnailPathForMediaId } from "../../src/config/paths.js";

describe("data directory move", () => {
  it("reports the location, copies everything to a new empty folder, and validates input", async () => {
    const t = await createTestApp();
    const root = seedScanRoot(t.db), folder = seedFolder(t.db, root, "/lib");
    const id = seedMedia(t.db, folder, root);
    const thumb = thumbnailPathForMediaId(t.ctx.paths.thumbnailsDir, id);
    fs.mkdirSync(path.dirname(thumb), { recursive: true });
    fs.writeFileSync(thumb, "jpegbytes");
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-moved-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-home-"));
    const prevEnv = { HOME: process.env.HOME, LOCALAPPDATA: process.env.LOCALAPPDATA, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
    process.env.HOME = home;
    process.env.XDG_DATA_HOME = path.join(home, "xdg");
    process.env.LOCALAPPDATA = path.join(home, "local");
    try {
      const call = (method: "GET" | "POST", url: string, payload?: unknown) => t.app.inject({ method, url, headers: { cookie: t.cookie }, payload });
      const before = await call("GET", "/api/settings/storage");
      expect(before.json()).toMatchObject({ dataDir: t.ctx.paths.dataDir, dataDirSource: "default", pendingMoveTo: null });
      expect(before.json().totalBytes).toBeGreaterThan(0);

      expect((await call("POST", "/api/settings/data-dir", { path: "relative/dir" })).statusCode).toBe(400);
      expect((await call("POST", "/api/settings/data-dir", { path: t.ctx.paths.dataDir })).statusCode).toBe(400);
      expect((await call("POST", "/api/settings/data-dir", { path: path.join(t.ctx.paths.dataDir, "inner") })).statusCode).toBe(400);

      const moved = await call("POST", "/api/settings/data-dir", { path: target });
      expect(moved.statusCode).toBe(200);
      expect(moved.json()).toMatchObject({ to: target, restartRequired: true });
      expect(moved.json().copiedBytes).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(target, "memorylane.sqlite")) || fs.existsSync(path.join(target, "db.sqlite"))).toBe(true);
      expect(fs.readFileSync(path.join(target, "thumbnails", path.relative(t.ctx.paths.thumbnailsDir, thumb)), "utf8")).toBe("jpegbytes");
      // the copied database is a real, consistent SQLite file with our rows
      const Database = (await import("better-sqlite3")).default;
      const copy = new Database(path.join(target, path.basename(t.ctx.paths.dbPath)), { readonly: true });
      expect((copy.prepare("SELECT COUNT(*) c FROM media").get() as { c: number }).c).toBe(1);
      copy.close();

      const after = await call("GET", "/api/settings/storage");
      expect(after.json().pendingMoveTo).toBe(target);
      // a second move into the now non-empty folder is refused
      expect((await call("POST", "/api/settings/data-dir", { path: target })).statusCode).toBe(400);
    } finally {
      process.env.HOME = prevEnv.HOME;
      if (prevEnv.LOCALAPPDATA === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = prevEnv.LOCALAPPDATA;
      if (prevEnv.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prevEnv.XDG_DATA_HOME;
      await t.close();
      fs.rmSync(target, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
