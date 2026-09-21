// Nearest-neighbour index over embeddings (design doc §6.3a). Everything
// vector-shaped goes through this interface so the backing library can be
// swapped without touching features. Spaces keep models apart.

export function spaceFor(kind: "media" | "faces", model: string): string {
  return `${kind}:${model}`;
}

export interface VectorRow {
  id: number;
  vector: Float32Array;
}

export interface VectorHit {
  id: number;
  score: number; // cosine similarity, higher = closer
}

export interface VectorIndex {
  upsert(space: string, rows: VectorRow[]): Promise<void>;
  remove(space: string, ids: number[]): Promise<void>;
  search(space: string, query: Float32Array, k: number, opts?: { excludeIds?: number[] }): Promise<VectorHit[]>;
  count(space: string): Promise<number>;
  rebuild(space: string, rows: Iterable<VectorRow>, dim: number): Promise<void>;
  // Rebuilds when the index disagrees with the durable store's row count.
  ensureSynced(space: string, expectedCount: number, rows: () => Iterable<VectorRow>, dim: number | null): Promise<"ok" | "rebuilt">;
}
