import { describe, it, expect } from "vitest";
import { createTestApp } from "../helpers/app.js";

describe("analysis routes", () => {
  it("requires auth and returns status", async () => {
    const t = await createTestApp();
    try {
      const anon = await t.app.inject({ method: "GET", url: "/api/analysis/status" });
      expect(anon.statusCode).toBe(401);
      const res = await t.app.inject({ method: "GET", url: "/api/analysis/status", headers: { cookie: t.cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ paused: false, analyzers: [], provider: null });
    } finally {
      await t.close();
    }
  });

  it("retry returns the re-queued count", async () => {
    const t = await createTestApp();
    try {
      const res = await t.app.inject({ method: "POST", url: "/api/analysis/retry", headers: { cookie: t.cookie }, payload: {} });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ requeued: 0 });
    } finally {
      await t.close();
    }
  });
});
