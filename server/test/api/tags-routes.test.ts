import { expect, it } from "vitest";
import { createTestApp } from "../helpers/app.js";
import { seedFolder, seedMedia, seedScanRoot } from "../helpers/db.js";
import type { AiProvider } from "../../src/providers/types.js";

it("adds a manual tag and browses only visible matching photos", async () => {
  const t = await createTestApp();
  try {
    const root = seedScanRoot(t.db);
    const folder = seedFolder(t.db, root, "/library");
    const visible = seedMedia(t.db, folder, root);
    const marked = seedMedia(t.db, folder, root);
    const headers = { cookie: t.cookie };
    expect((await t.app.inject({ method: "GET", url: "/api/tags", headers: {} })).statusCode).toBe(401);
    const add = await t.app.inject({ method: "POST", url: `/api/media/${visible}/tags`, headers, payload: { name: "  Mountain  " } });
    expect(add.statusCode).toBe(200);
    expect(add.json().name).toBe("mountain");
    await t.app.inject({ method: "POST", url: `/api/media/${marked}/tags`, headers, payload: { name: "mountain" } });
    t.db.prepare("INSERT INTO deletion_marks (media_id) VALUES (?)").run(marked);
    const facets = await t.app.inject({ method: "GET", url: "/api/tags", headers });
    expect(facets.statusCode).toBe(200);
    expect(facets.json()).toEqual({ items: [{ id: add.json().id, name: "mountain", count: 1 }], total: 1, offset: 0, limit: 100 });
    const list = await t.app.inject({ method: "GET", url: `/api/tags/${add.json().id}/media`, headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((m: { id: number }) => m.id)).toEqual([visible]);
  } finally { await t.close(); }
});

it("pages and searches tag facets without treating search text as SQL wildcards", async () => {
  const t = await createTestApp();
  try {
    const root = seedScanRoot(t.db), folder = seedFolder(t.db, root, "/library"), media = seedMedia(t.db, folder, root);
    const headers = { cookie: t.cookie };
    for (const name of ["mountain", "lake", "100% fun"]) {
      await t.app.inject({ method: "POST", url: `/api/media/${media}/tags`, headers, payload: { name } });
    }
    const first = await t.app.inject({ method: "GET", url: "/api/tags?limit=1", headers });
    expect(first.json().items).toHaveLength(1);
    expect(first.json().total).toBe(3);
    const searched = await t.app.inject({ method: "GET", url: "/api/tags?q=%25", headers });
    expect(searched.json().items.map((tag: { name: string }) => tag.name)).toEqual(["100% fun"]);
  } finally { await t.close(); }
});

it("starts a backfill only when an AI provider is configured", async () => {
  const t = await createTestApp();
  try {
    const res = await t.app.inject({ method: "POST", url: "/api/tags/generate", headers: { cookie: t.cookie } });
    expect(res.statusCode).toBe(503);
  } finally { await t.close(); }
});

it("explains when AI tagging is switched off", async () => {
  const t = await createTestApp({ provider: { expectedModel: "test-model" } as AiProvider });
  try {
    t.db.prepare("INSERT INTO settings (key, value) VALUES ('aiEnabled', 'false')").run();
    const res = await t.app.inject({ method: "POST", url: "/api/tags/generate", headers: { cookie: t.cookie } });
    expect(res.statusCode).toBe(409);
  } finally { await t.close(); }
});

it("schedules AI tag backfill without scanning the library in the request", async () => {
  const provider = { expectedModel: "test-model" } as AiProvider;
  const t = await createTestApp({ provider });
  try {
    const res = await t.app.inject({ method: "POST", url: "/api/tags/generate", headers: { cookie: t.cookie } });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ scheduled: true });
  } finally { await t.close(); }
});
