import { describe, it, expect } from "vitest";
import { createTestApp } from "../helpers/app.js";
import { seedScanRoot, seedFolder, seedMedia } from "../helpers/db.js";

async function seeded() {
  const t = await createTestApp();
  const root = seedScanRoot(t.db);
  const folder = seedFolder(t.db, root, "/library");
  const ids = [1, 2, 3].map(() => seedMedia(t.db, folder, root));
  return { t, root, folder, ids };
}
type T = Awaited<ReturnType<typeof createTestApp>>;
const call = (t: T, method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) =>
  t.app.inject({ method, url, headers: { cookie: t.cookie }, payload });

describe("stack routes", () => {
  it("full lifecycle: create, read, cover, collapse in folder listing, remove, recompute", async () => {
    const S = await seeded();
    const [a, b, c] = S.ids;
    try {
      expect((await S.t.app.inject({ method: "GET", url: "/api/stacks/1" })).statusCode).toBe(401);

      const created = await call(S.t, "POST", "/api/stacks", { mediaIds: [a, b] });
      expect(created.statusCode).toBe(201);
      const stack = created.json();
      expect(stack).toMatchObject({ kind: "manual", coverMediaId: a, count: 2, userModified: true });

      const detail = await call(S.t, "GET", `/api/stacks/${stack.id}`);
      expect(detail.json().items.map((m: { id: number }) => m.id)).toEqual([a, b]);
      expect(detail.json().items[0].stack).toEqual({ id: stack.id, count: 2, isCover: true });

      const cover = await call(S.t, "POST", `/api/stacks/${stack.id}/cover`, { mediaId: b });
      expect(cover.json().coverMediaId).toBe(b);

      expect((await call(S.t, "POST", "/api/stacks", { mediaIds: [a, c] })).statusCode).toBe(400);

      const collapsed = await call(S.t, "GET", `/api/folders/${S.folder}/media`);
      expect(collapsed.json().total).toBe(2);
      const coverItem = collapsed.json().items.find((m: { id: number }) => m.id === b);
      expect(coverItem.stack).toEqual({ id: stack.id, count: 2, isCover: true });
      const expanded = await call(S.t, "GET", `/api/folders/${S.folder}/media?expandStacks=true`);
      expect(expanded.json().total).toBe(3);

      const removed = await call(S.t, "DELETE", `/api/stacks/${stack.id}/members/${a}`);
      expect(removed.json()).toEqual({ stack: null }); // dissolved
      expect((await call(S.t, "GET", `/api/stacks/${stack.id}`)).statusCode).toBe(404);

      const recompute = await call(S.t, "POST", "/api/stacks/recompute", {});
      expect(recompute.json()).toEqual({ folders: 1 });
    } finally {
      await S.t.close();
    }
  });

  it("split, merge and delete", async () => {
    const S = await seeded();
    const [a, b, c] = S.ids;
    try {
      const s = (await call(S.t, "POST", "/api/stacks", { mediaIds: [a, b, c] })).json();
      const s2 = (await call(S.t, "POST", `/api/stacks/${s.id}/split`, { mediaIds: [b, c] })).json();
      expect(s2.count).toBe(2);
      expect((await call(S.t, "GET", `/api/stacks/${s.id}`)).statusCode).toBe(404); // a alone -> dissolved
      const merged = await call(S.t, "POST", `/api/stacks/${s2.id}/merge`, { stackId: 9999 });
      expect(merged.statusCode).toBe(404);
      expect((await call(S.t, "DELETE", `/api/stacks/${s2.id}`)).statusCode).toBe(204);
      expect((await call(S.t, "DELETE", `/api/stacks/${s2.id}`)).statusCode).toBe(404);
    } finally {
      await S.t.close();
    }
  });
});
