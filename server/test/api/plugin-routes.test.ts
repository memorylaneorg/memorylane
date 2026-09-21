import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestApp } from "../helpers/app.js";

describe("Apple Photos plugin lifecycle", () => {
  it("starts disabled, persists opt-in, and rejects Apple roots while disabled", async () => {
    const t = await createTestApp();
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-plugin-"));
    const library = path.join(scratch, "Test.photoslibrary");
    fs.mkdirSync(library);
    try {
      const call = (method: "GET" | "PUT" | "POST", url: string, payload?: unknown) =>
        t.app.inject({ method, url, headers: { cookie: t.cookie }, payload });
      const initial = await call("GET", "/api/plugins");
      expect(initial.statusCode).toBe(200);
      expect(initial.json()).toContainEqual(expect.objectContaining({ id: "apple-photos", enabled: false, available: process.platform === "darwin" }));
      const platformInventory = await call("GET", "/api/plugin-platform");
      expect(platformInventory.statusCode).toBe(200);
      expect(platformInventory.json()).toEqual([]);
      expect((await call("POST", "/api/scan-roots", { path: library, kind: "apple-photos" })).statusCode).toBe(409);

      const enabled = await call("PUT", "/api/plugins/apple-photos", { enabled: true });
      if (process.platform === "darwin") {
        expect(enabled.statusCode).toBe(200);
        expect(enabled.json()).toMatchObject({ id: "apple-photos", enabled: true });
        const added = await call("POST", "/api/scan-roots", { path: library, kind: "apple-photos" });
        expect(added.statusCode).toBe(201);
        expect(added.json().kind).toBe("apple-photos");
        expect((await call("GET", "/api/scan-roots")).json()[0].kind).toBe("apple-photos");
      } else {
        expect(enabled.statusCode).toBe(409);
      }
    } finally {
      await t.close();
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
