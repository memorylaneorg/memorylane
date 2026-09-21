import { describe, it, expect } from "vitest";
import { groupBursts, cosine, type StackCandidate } from "../../src/stacks/stacker.js";

const H0 = "0000000000000000";
const H1 = "0000000000000001"; // 1 bit from H0
const HFAR = "ffffffffffffffff";
let n = 0;
const c = (o: Partial<StackCandidate>): StackCandidate => ({
  id: ++n,
  filename: `IMG_${String(n).padStart(4, "0")}.jpg`,
  capturedAt: "2024-05-12T10:31:44.000",
  body: "R5-1",
  phash: H0,
  burstId: null,
  ...o,
});
const t = (ms: number) => new Date(Date.UTC(2024, 4, 12, 10, 31, 44, 0) + ms).toISOString().slice(0, 23);

describe("groupBursts", () => {
  it("groups a tight sequence with matching hashes; leaves singles alone", () => {
    n = 0;
    const rows = [c({ capturedAt: t(0) }), c({ capturedAt: t(100), phash: H1 }), c({ capturedAt: t(200) }), c({ capturedAt: t(10_000), phash: HFAR })];
    expect(groupBursts(rows)).toEqual([[1, 2, 3]]);
  });
  it("splits on time gap, body change, and visual distance", () => {
    n = 0;
    const rows = [
      c({ capturedAt: t(0) }), c({ capturedAt: t(500) }), // pair 1
      c({ capturedAt: t(3500) }), c({ capturedAt: t(3600) }), // gap > 2s -> pair 2
      c({ capturedAt: t(3700), body: "5D" }), // other body -> alone
      c({ capturedAt: t(3800), phash: HFAR }), // far hash -> alone
    ];
    // Burst rule only (series gap off): the 3s gap splits the pairs.
    expect(groupBursts(rows, { gapSeconds: 2, maxHamming: 14, minCosine: 0.9, seriesGapSeconds: 0 })).toEqual([[1, 2], [3, 4]]);
    // With the series rule, identical frames 3s apart are one tripod series.
    expect(groupBursts(rows)).toEqual([[1, 2, 3, 4]]);
  });
  it("trusts a shared camera burst id even when hashes differ", () => {
    n = 0;
    const rows = [c({ capturedAt: t(0), burstId: "B1", phash: H0 }), c({ capturedAt: t(100), burstId: "B1", phash: HFAR })];
    expect(groupBursts(rows)).toEqual([[1, 2]]);
  });
  it("skips rows without a capture time or body, and sorts by time then filename", () => {
    n = 0;
    const rows = [
      c({ capturedAt: t(100), filename: "b.jpg" }), c({ capturedAt: t(0), filename: "a.jpg" }),
      c({ capturedAt: null }), c({ capturedAt: t(200), body: null }),
    ];
    expect(groupBursts(rows)).toEqual([[2, 1]]);
  });
  it("requires hashes on both sides unless a burst id matches", () => {
    n = 0;
    expect(groupBursts([c({ capturedAt: t(0), phash: null }), c({ capturedAt: t(50) })])).toEqual([]);
  });
  it("honours custom thresholds", () => {
    n = 0;
    const rows = [c({ capturedAt: t(0) }), c({ capturedAt: t(2500) })];
    // Identical hashes qualify for the series rule, so pin that off to test the burst gap alone.
    expect(groupBursts(rows, { gapSeconds: 2, maxHamming: 14, minCosine: 0.9, seriesGapSeconds: 0 })).toEqual([]);
    expect(groupBursts(rows, { gapSeconds: 3, maxHamming: 14, minCosine: 0.9, seriesGapSeconds: 0 })).toEqual([[1, 2]]);
  });
  it("v2: embedding similarity rescues frames whose hashes drifted", () => {
    n = 0;
    const e = (x: number, y: number) => {
      const len = Math.hypot(x, y);
      return Float32Array.from([x / len, y / len]);
    };
    expect(cosine(e(1, 0), e(1, 0))).toBeCloseTo(1, 6);
    const close = [c({ capturedAt: t(0), phash: H0, embedding: e(1, 0) }), c({ capturedAt: t(100), phash: HFAR, embedding: e(1, 0.2) })]; // cos ≈ 0.98
    expect(groupBursts(close)).toEqual([[1, 2]]);
    n = 0;
    const far = [c({ capturedAt: t(0), phash: H0, embedding: e(1, 0) }), c({ capturedAt: t(100), phash: HFAR, embedding: e(1, 1) })]; // cos ≈ 0.71
    expect(groupBursts(far)).toEqual([]);
    n = 0;
    const oneSide = [c({ capturedAt: t(0), phash: H0, embedding: e(1, 0) }), c({ capturedAt: t(100), phash: H1, embedding: null })]; // hash rule still applies
    expect(groupBursts(oneSide)).toEqual([[1, 2]]);
  });

  it("v3: tripod series - long gaps group only near-identical frames, measured from exposure end", () => {
    n = 0;
    // 30s exposures a minute apart with (near-)identical hashes: a series.
    const series = [
      c({ capturedAt: t(0), shutterSeconds: 30 }),
      c({ capturedAt: t(60_000), shutterSeconds: 30, phash: H1 }),
      c({ capturedAt: t(120_000), shutterSeconds: 30 }),
    ];
    expect(groupBursts(series)).toEqual([[1, 2, 3]]);
    n = 0;
    // Same timing but hashes only "burst-close" (10 bits), not tight: no series.
    const H10 = "00000000000003ff";
    expect(groupBursts([c({ capturedAt: t(0), shutterSeconds: 30 }), c({ capturedAt: t(60_000), shutterSeconds: 30, phash: H10 })])).toEqual([]);
    n = 0;
    // Beyond the series gap even if identical.
    expect(groupBursts([c({ capturedAt: t(0) }), c({ capturedAt: t(200_000) })])).toEqual([]);
    n = 0;
    // A 121s exposure followed 122s later: gap from exposure end is 1s -> burst rule applies.
    expect(groupBursts([c({ capturedAt: t(0), shutterSeconds: 121, phash: H0 }), c({ capturedAt: t(122_000), phash: H10 })])).toEqual([[1, 2]]);
  });
});
