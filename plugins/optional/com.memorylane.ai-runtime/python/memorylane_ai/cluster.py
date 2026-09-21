"""Chinese-whispers clustering over a cosine kNN graph (as used by dlib for
face clustering). Numpy only - no scikit-learn/scipy - and linear memory:
similarities are computed in row blocks, so 200k faces don't need an NxN
matrix. Deterministic for a given seed.
"""
import numpy as np

BLOCK = 512


def chinese_whispers(vectors: np.ndarray, threshold: float, min_cluster_size: int, iterations: int = 20, seed: int = 0) -> list[int]:
    n = len(vectors)
    if n == 0:
        return []
    v = vectors.astype(np.float32)
    v /= np.clip(np.linalg.norm(v, axis=1, keepdims=True), 1e-12, None)
    neighbours: list[np.ndarray] = [np.empty(0, dtype=np.int64)] * n
    weights: list[np.ndarray] = [np.empty(0, dtype=np.float32)] * n
    for start in range(0, n, BLOCK):
        sims = v[start : start + BLOCK] @ v.T
        for r in range(sims.shape[0]):
            i = start + r
            row = sims[r]
            row[i] = -1.0  # no self edge
            idx = np.where(row >= threshold)[0]
            neighbours[i] = idx
            weights[i] = row[idx]

    labels = np.arange(n)
    rng = np.random.default_rng(seed)
    for _ in range(iterations):
        changed = False
        for i in rng.permutation(n):
            nb = neighbours[i]
            if nb.size == 0:
                continue
            totals: dict[int, float] = {}
            for j, w in zip(nb, weights[i]):
                lab = int(labels[j])
                totals[lab] = totals.get(lab, 0.0) + float(w)
            best = max(totals.items(), key=lambda kv: (kv[1], -kv[0]))[0]
            if best != labels[i]:
                labels[i] = best
                changed = True
        if not changed:
            break

    # Drop small clusters, then densify labels by descending cluster size.
    uniq, counts = np.unique(labels, return_counts=True)
    keep = {int(u): int(c) for u, c in zip(uniq, counts) if c >= min_cluster_size}
    order = sorted(keep, key=lambda u: (-keep[u], u))
    remap = {u: k for k, u in enumerate(order)}
    return [remap.get(int(l), -1) for l in labels]
