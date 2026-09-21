import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryVectorIndex } from "../../src/vectors/memory-vector-index.js";
import { spaceFor } from "../../src/vectors/vector-index.js";

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-lance-"));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function unit(seed: number, dim = 16): Float32Array {
  const v = new Float32Array(dim);
  let s = seed * 9973 + 1;
  for (let i = 0; i < dim; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    v[i] = (s % 1000) / 1000 - 0.5;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

describe("MemoryVectorIndex", () => {
  const space = spaceFor("media", "test-model@1");

  it("upserts, searches by cosine, excludes, updates, removes, counts", async () => {
    const idx = new MemoryVectorIndex();
    expect(await idx.count(space)).toBe(0);
    expect(await idx.search(space, unit(1), 3)).toEqual([]);
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, vector: unit(i + 1) }));
    await idx.upsert(space, rows.slice(0, 120));
    await idx.upsert(space, rows.slice(120));
    expect(await idx.count(space)).toBe(200);

    const hits = await idx.search(space, unit(7), 3);
    expect(hits[0].id).toBe(7);
    expect(hits[0].score).toBeCloseTo(1, 4);
    expect(hits.length).toBe(3);

    const without = await idx.search(space, unit(7), 3, { excludeIds: [7] });
    expect(without.map((h) => h.id)).not.toContain(7);
    expect(without.length).toBe(3);

    await idx.upsert(space, [{ id: 7, vector: unit(999) }]);
    expect(await idx.count(space)).toBe(200);
    expect((await idx.search(space, unit(999), 1))[0].id).toBe(7);

    await idx.remove(space, [7, 8]);
    expect(await idx.count(space)).toBe(198);
  });

  it("rebuild overwrites and ensureSynced detects drift", async () => {
    const idx = new MemoryVectorIndex();
    const s2 = spaceFor("media", "other@1");
    await idx.upsert(s2, [{ id: 1, vector: unit(1) }, { id: 2, vector: unit(2) }]);
    const source = () => [{ id: 5, vector: unit(5) }, { id: 6, vector: unit(6) }, { id: 7, vector: unit(7) }];
    expect(await idx.ensureSynced(s2, 3, source, 16)).toBe("rebuilt");
    expect(await idx.count(s2)).toBe(3);
    expect((await idx.search(s2, unit(6), 1))[0].id).toBe(6);
    expect(await idx.ensureSynced(s2, 3, source, 16)).toBe("ok");
    expect(await idx.ensureSynced(s2, 0, () => [], 16)).toBe("rebuilt");
    expect(await idx.count(s2)).toBe(0);
  });
});
