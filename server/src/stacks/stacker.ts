import { hammingHex } from "./phash.js";

// Bump when the grouping rule changes so existing auto stacks are recomputed.
// v2: embedding cosine similarity also counts as "same moment" (design §8.4).
// v3: tripod/long-exposure series - a long gap is allowed when the frames
// are visually near-identical, and gaps are measured from the end of the
// previous exposure rather than its start.
export const STACK_RULE_VERSION = "burst-v3";

export interface StackCandidate {
  id: number;
  filename: string;
  capturedAt: string | null; // media_exif.captured_at_precise (wall clock, ms)
  body: string | null; // camera serial, else model
  phash: string | null;
  burstId: string | null; // maker-note burst UUID when present
  // CLIP image embedding (L2-normalised) when the AI sidecar has run; null otherwise.
  embedding?: Float32Array | null;
  // Exposure length; a 30s frame "ends" 30s after its capture time.
  shutterSeconds?: number | null;
}

export interface StackerOptions {
  gapSeconds: number;
  maxHamming: number;
  // Cosine similarity at or above which two frames count as the same scene
  // even when their hashes differ (subject moved, hash broke).
  minCosine: number;
  // Tripod / long-exposure series: frames this far apart still group, but
  // only when they are visually near-identical (half the hash distance, or
  // cosine >= the midpoint between minCosine and 1).
  seriesGapSeconds: number;
}

export const DEFAULT_STACKER_OPTIONS: StackerOptions = { gapSeconds: 2, maxHamming: 14, minCosine: 0.9, seriesGapSeconds: 120 };

export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function parseMs(s: string): number {
  // Wall-clock strings carry no offset; treating them as UTC keeps
  // differences correct within one camera's stream, which is all we need.
  return Date.parse(`${s}Z`);
}

// Single time-sorted pass per folder (design doc §8.3): O(n), no pairwise
// blow-up. Photo j joins the open group when it shares a body with the
// previous member, follows it within gapSeconds, and is visually close
// (hash distance, or embedding cosine when both have one) OR carries the
// same camera burst id.
export function groupBursts(rows: StackCandidate[], opts: StackerOptions = DEFAULT_STACKER_OPTIONS): number[][] {
  const eligible = rows
    .filter((r) => r.capturedAt && r.body)
    .map((r) => ({ ...r, ms: parseMs(r.capturedAt as string) }))
    .filter((r) => Number.isFinite(r.ms))
    .sort((a, b) => a.ms - b.ms || a.filename.localeCompare(b.filename));

  const groups: number[][] = [];
  let current: typeof eligible = [];
  const flush = () => {
    if (current.length >= 2) groups.push(current.map((r) => r.id));
    current = [];
  };

  for (const r of eligible) {
    const prev = current[current.length - 1];
    if (prev) {
      const sameBody = prev.body === r.body;
      const prevEnd = prev.ms + Math.max(0, prev.shutterSeconds ?? 0) * 1000;
      const gap = r.ms - prevEnd;
      const sameBurst = !!r.burstId && r.burstId === prev.burstId;
      const hamming = r.phash && prev.phash ? hammingHex(r.phash, prev.phash) : null;
      const cos = r.embedding && prev.embedding ? cosine(r.embedding, prev.embedding) : null;
      const hashClose = hamming !== null && hamming <= opts.maxHamming;
      const embedClose = cos !== null && cos >= opts.minCosine;
      const burstJoin = gap <= opts.gapSeconds * 1000 && (sameBurst || hashClose || embedClose);
      const hashTight = hamming !== null && hamming <= Math.floor(opts.maxHamming / 2);
      const embedTight = cos !== null && cos >= (1 + opts.minCosine) / 2;
      const seriesJoin = gap <= opts.seriesGapSeconds * 1000 && (hashTight || embedTight);
      if (sameBody && (burstJoin || seriesJoin)) {
        current.push(r);
        continue;
      }
      flush();
    }
    current.push(r);
  }
  flush();
  return groups;
}
