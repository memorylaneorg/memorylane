import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestApp } from "../helpers/app.js";
import { seedScanRoot, seedFolder, seedMedia } from "../helpers/db.js";
import { startFakeSidecar, vectorForText, type FakeSidecar } from "../helpers/fake-sidecar.js";
import { SidecarProvider } from "../../src/providers/sidecar-provider.js";
import { spaceFor } from "../../src/vectors/vector-index.js";

let fake: FakeSidecar;
beforeAll(async () => {
  fake = await startFakeSidecar();
});
afterAll(() => fake.close());

function unit(values: number[]): Float32Array {
  const n = Math.hypot(...values) || 1;
  return Float32Array.from(values.map((v) => v / n));
}

async function seeded(withProvider = true) {
  const provider = withProvider ? new SidecarProvider(fake.url, { expectedModel: fake.model }) : null;
  const t = await createTestApp({ provider });
  const root = seedScanRoot(t.db);
  const folder = seedFolder(t.db, root, "/lib");
  const a = seedMedia(t.db, folder, root, { filename: "a.jpg" });
  const b = seedMedia(t.db, folder, root, { filename: "b.jpg" });
  const c = seedMedia(t.db, folder, root, { filename: "c.jpg" });
  const raw = seedMedia(t.db, folder, root, { filename: "a.cr3", media_type: "raw" });
  const unanalysed = seedMedia(t.db, folder, root, { filename: "z.jpg" });
  t.db.prepare("UPDATE media SET raw_pair_id = ? WHERE id = ?").run(raw, a);
  const vectors = [
    { mediaId: a, vector: unit([1, 0, 0, 0, 0, 0, 0, 0]) },
    { mediaId: b, vector: unit([0.9, 0.1, 0, 0, 0, 0, 0, 0]) },
    { mediaId: c, vector: unit([0, 0, 1, 0, 0, 0, 0, 0]) },
    { mediaId: raw, vector: unit([1, 0, 0, 0, 0, 0, 0, 0]) },
  ];
  t.ctx.embeddings.upsertMany(fake.model, vectors);
  await t.ctx.vectorIndex.upsert(spaceFor("media", fake.model), vectors.map((v) => ({ id: v.mediaId, vector: v.vector })));
  return { t, a, b, c, raw, unanalysed };
}
const get = (t: Awaited<ReturnType<typeof createTestApp>>, url: string) => t.app.inject({ method: "GET", url, headers: { cookie: t.cookie } });

describe("find similar", () => {
  it("returns neighbours by score, excluding self and hidden companions", async () => {
    const S = await seeded();
    try {
      const r = await get(S.t, `/api/media/${S.a}/similar?limit=10`);
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.source.id).toBe(S.a);
      expect(body.items.map((i: { media: { id: number } }) => i.media.id)).toEqual([S.b, S.c]);
      expect(body.items[0].score).toBeGreaterThan(body.items[1].score);
      expect(body.items[0].score).toBeGreaterThan(0.9);
    } finally {
      await S.t.close();
    }
  });
  it("409 when not analysed, 404 unknown, 503 without provider", async () => {
    const S = await seeded();
    try {
      expect((await get(S.t, `/api/media/${S.unanalysed}/similar`)).statusCode).toBe(409);
      expect((await get(S.t, `/api/media/99999/similar`)).statusCode).toBe(404);
    } finally {
      await S.t.close();
    }
    const N = await seeded(false);
    try {
      expect((await get(N.t, `/api/media/${N.a}/similar`)).statusCode).toBe(503);
    } finally {
      await N.t.close();
    }
  });
});

describe("semantic search", () => {
  it("ranks media by text similarity and reports scores", async () => {
    const S = await seeded();
    try {
      // The fake text vector for a word is a one-hot on hash(word) % dim - seed
      // a vector at exactly that slot so the ranking is deterministic.
      const slot = vectorForText("osprey", 8).findIndex((v) => v > 0);
      const hot = new Array(8).fill(0);
      hot[slot] = 1;
      S.t.ctx.embeddings.upsertMany(fake.model, [{ mediaId: S.c, vector: unit(hot) }]);
      await S.t.ctx.vectorIndex.upsert(spaceFor("media", fake.model), [{ id: S.c, vector: unit(hot) }]);
      const r = await get(S.t, "/api/search?q=osprey&mode=semantic&limit=5");
      expect(r.statusCode).toBe(200);
      const items = r.json().items;
      expect(items[0].type).toBe("media");
      expect(items[0].media.id).toBe(S.c);
      expect(items[0].score).toBeCloseTo(1, 4);
      expect(items.length).toBe(3); // a, b, c - paired RAW hidden
    } finally {
      await S.t.close();
    }
  });
  it("text mode is unchanged and semantic 503s without a provider", async () => {
    const N = await seeded(false);
    try {
      expect((await get(N.t, "/api/search?q=a&mode=text")).statusCode).toBe(200);
      expect((await get(N.t, "/api/search?q=a&mode=semantic")).statusCode).toBe(503);
    } finally {
      await N.t.close();
    }
  });
});
