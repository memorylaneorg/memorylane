import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createTestApp } from "../helpers/app.js";

const originalControlUrl = process.env.MEMORYLANE_DESKTOP_CONTROL_URL;
const originalControlToken = process.env.MEMORYLANE_DESKTOP_TOKEN;

afterEach(() => {
  if (originalControlUrl === undefined) delete process.env.MEMORYLANE_DESKTOP_CONTROL_URL;
  else process.env.MEMORYLANE_DESKTOP_CONTROL_URL = originalControlUrl;
  if (originalControlToken === undefined) delete process.env.MEMORYLANE_DESKTOP_TOKEN;
  else process.env.MEMORYLANE_DESKTOP_TOKEN = originalControlToken;
});

describe("desktop folder picker", () => {
  it("is unavailable outside the desktop host", async () => {
    delete process.env.MEMORYLANE_DESKTOP_CONTROL_URL;
    delete process.env.MEMORYLANE_DESKTOP_TOKEN;
    const t = await createTestApp();
    try {
      const headers = { cookie: t.cookie };
      expect((await t.app.inject({ method: "GET", url: "/api/scan-roots/folder-picker", headers })).json()).toEqual({ available: false });
      expect((await t.app.inject({ method: "POST", url: "/api/scan-roots/folder-picker", headers })).statusCode).toBe(409);
    } finally {
      await t.close();
    }
  });

  it("returns the path selected by the token-protected desktop host", async () => {
    const token = "test-desktop-token";
    const control = createServer((request, response) => {
      expect(request.url).toBe("/select-folder");
      expect(request.headers["x-memorylane-desktop-token"]).toBe(token);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ path: "C:\\Users\\tester\\Pictures" }));
    });
    await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
    const address = control.address();
    if (!address || typeof address === "string") throw new Error("Control server did not bind to TCP");
    process.env.MEMORYLANE_DESKTOP_CONTROL_URL = `http://127.0.0.1:${address.port}`;
    process.env.MEMORYLANE_DESKTOP_TOKEN = token;

    const t = await createTestApp();
    try {
      const headers = { cookie: t.cookie };
      expect((await t.app.inject({ method: "GET", url: "/api/scan-roots/folder-picker", headers })).json()).toEqual({ available: true });
      const selected = await t.app.inject({ method: "POST", url: "/api/scan-roots/folder-picker", headers });
      expect(selected.statusCode).toBe(200);
      expect(selected.json()).toEqual({ path: "C:\\Users\\tester\\Pictures" });
    } finally {
      await t.close();
      await new Promise<void>((resolve, reject) => control.close((error) => error ? reject(error) : resolve()));
    }
  });
});
