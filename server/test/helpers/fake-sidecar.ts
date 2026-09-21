import Fastify, { type FastifyInstance } from "fastify";

// Minimal in-process stand-in for memorylane-ai implementing the /v1
// contract with deterministic, tiny vectors so provider/analyzer/route tests
// never need the real model. Image vectors derive from the byte content
// (same bytes -> same vector), text vectors from the words.
export interface FakeSidecar {
  url: string;
  model: string;
  dim: number;
  calls: { images: number; texts: number; faces: number; cluster: number };
  setFailing(status: number | null): void;
  close(): Promise<void>;
}

function normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

export function vectorForBytes(bytes: Uint8Array, dim: number): number[] {
  const v = new Array(dim).fill(0);
  for (let i = 0; i < bytes.length; i++) v[i % dim] += bytes[i] + 1;
  return normalize(v);
}

export function vectorForText(text: string, dim: number): number[] {
  const v = new Array(dim).fill(0);
  for (const word of text.toLowerCase().split(/\s+/)) {
    let h = 7;
    for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % dim] += 1;
  }
  return normalize(v);
}

// Splits a multipart body on its boundary and returns each file part's bytes.
function parseMultipart(body: Buffer, contentType: string): Buffer[] {
  const boundary = contentType.match(/boundary=([^;]+)/)?.[1];
  if (!boundary) return [];
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: Buffer[] = [];
  let start = body.indexOf(delimiter);
  while (start !== -1) {
    const next = body.indexOf(delimiter, start + delimiter.length);
    if (next === -1) break;
    const chunk = body.subarray(start + delimiter.length, next);
    const headerEnd = chunk.indexOf("\r\n\r\n");
    if (headerEnd !== -1) parts.push(chunk.subarray(headerEnd + 4, chunk.length - 2)); // strip trailing CRLF
    start = next;
  }
  return parts;
}

// Deterministic "faces" for a JPEG: the number of faces is bytes[0] % 3 (so
// tests can pick 0/1/2-face images by their first byte), each face gets a
// distinct bbox and an embedding derived from the bytes rotated by its index.
export function facesForBytes(bytes: Uint8Array, dim: number): { bbox: number[]; landmarks: number[][]; det_score: number; embedding: number[] }[] {
  const n = bytes.length ? bytes[0] % 3 : 0;
  const base = vectorForBytes(bytes, dim);
  return Array.from({ length: n }, (_, i) => ({
    bbox: [0.1 + i * 0.4, 0.2, 0.25, 0.3],
    landmarks: [[0.15, 0.3], [0.3, 0.3], [0.22, 0.38], [0.17, 0.45], [0.28, 0.45]],
    det_score: 0.9,
    embedding: normalize(base.map((_, k) => base[(k + i) % dim])),
  }));
}

// Connected components over cosine >= threshold, dropping small clusters.
export function clusterVectors(vectors: number[][], threshold: number, minClusterSize: number): number[] {
  const n = vectors.length;
  const labels = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (labels[i] === i ? i : (labels[i] = find(labels[i])));
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const s = vectors[i].reduce((acc, v, k) => acc + v * vectors[j][k], 0);
      if (s >= threshold) labels[find(i)] = find(j);
    }
  const roots = labels.map((_, i) => find(i));
  const sizes = new Map<number, number>();
  for (const r of roots) sizes.set(r, (sizes.get(r) ?? 0) + 1);
  const order = [...sizes.entries()].filter(([, c]) => c >= minClusterSize).sort((a, b) => b[1] - a[1]).map(([r]) => r);
  return roots.map((r) => (order.includes(r) ? order.indexOf(r) : -1));
}

export async function startFakeSidecar(opts: { model?: string; dim?: number; faceModel?: string } = {}): Promise<FakeSidecar> {
  const model = opts.model ?? "clip-vit-base-patch32@1";
  const dim = opts.dim ?? 8;
  const faceModel = opts.faceModel ?? "yunet-sface@1";
  let failing: number | null = null;
  const calls = { images: 0, texts: 0, faces: 0, cluster: 0 };
  const app: FastifyInstance = Fastify({ logger: false });
  app.addContentTypeParser("multipart/form-data", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  app.get("/v1/health", async (_req, reply) => {
    if (failing) return reply.code(failing).send({ detail: "failing" });
    return {
      ok: true, device: "fake", providers: ["FakeExecutionProvider"], max_batch: 32,
      models: { image_embed: { id: model, dim }, text_embed: { id: model, dim }, faces: { id: faceModel, dim } },
      face_models: [
        { name: "yunet-sface", id: faceModel, dim, license: "Apache-2.0", label: "Standard" },
        { name: "buffalo_l", id: "buffalo_l@1", dim, license: "non-commercial", label: "ArcFace" },
      ],
    };
  });
  app.post("/v1/faces", async (req, reply) => {
    if (failing) return reply.code(failing).send({ detail: "failing" });
    calls.faces++;
    const parts = parseMultipart(req.body as Buffer, req.headers["content-type"] ?? "");
    // The first part may be the `model` form field (short, non-JPEG).
    const modelPart = parts.find((p) => p.length < 32 && /^[a-z_-]+$/.test(p.toString()));
    const files = parts.filter((p) => p !== modelPart);
    const requested = modelPart?.toString() ?? "yunet-sface";
    if (files.length === 0) return reply.code(422).send({ detail: "no files" });
    return { model: requested === "buffalo_l" ? "buffalo_l@1" : faceModel, dim, images: files.map((f) => facesForBytes(f, dim)) };
  });
  app.post("/v1/cluster", async (req, reply) => {
    if (failing) return reply.code(failing).send({ detail: "failing" });
    calls.cluster++;
    const { vectors, threshold, min_cluster_size } = req.body as { vectors: number[][]; threshold: number; min_cluster_size: number };
    return { labels: clusterVectors(vectors, threshold, min_cluster_size) };
  });
  app.post("/v1/embed/image", async (req, reply) => {
    if (failing) return reply.code(failing).send({ detail: "failing" });
    calls.images++;
    const files = parseMultipart(req.body as Buffer, req.headers["content-type"] ?? "");
    if (files.length === 0) return reply.code(422).send({ detail: "no files" });
    return { model, dim, vectors: files.map((f) => vectorForBytes(f, dim)) };
  });
  app.post("/v1/embed/text", async (req, reply) => {
    if (failing) return reply.code(failing).send({ detail: "failing" });
    calls.texts++;
    const { texts } = req.body as { texts: string[] };
    if (!texts?.length) return reply.code(422).send({ detail: "no texts" });
    return { model, dim, vectors: texts.map((t) => vectorForText(t, dim)) };
  });

  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  return {
    url: address,
    model,
    dim,
    calls,
    setFailing: (status) => {
      failing = status;
    },
    close: () => app.close(),
  };
}
