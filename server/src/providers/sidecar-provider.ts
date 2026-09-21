import {
  FACE_MODEL_IDS,
  ProviderUnavailableError,
  type AiProvider,
  type EmbeddingBatch,
  type FaceBatch,
  type FaceDetection,
  type ProviderInfo,
} from "./types.js";

interface SidecarHealth {
  ok: boolean;
  device: string;
  models: { image_embed: { id: string; dim: number }; text_embed: { id: string; dim: number }; faces?: { id: string; dim: number } };
  face_models?: { name: string; id: string; dim: number; license: string; label: string }[];
}

interface SidecarFaces {
  model: string;
  dim: number;
  images: { bbox: number[]; landmarks: number[][]; det_score: number; embedding: number[] }[][];
}

interface SidecarVectors {
  model: string;
  dim: number;
  vectors: number[][];
}

export interface SidecarProviderOptions {
  token?: string;
  expectedModel: string;
  healthTtlMs?: number;
  requestTimeoutMs?: number;
}

// HTTP client for memorylane-ai (design doc §6.5). Health is cached briefly
// so the analyzer's per-batch check is free; every failure classification
// matters: outages -> ProviderUnavailableError (back off), 4xx -> Error (the
// batch is bad, mark it failed).
export class SidecarProvider implements AiProvider {
  readonly id = "sidecar";
  readonly expectedModel: string;
  private info: ProviderInfo;
  private healthTtlMs: number;
  private requestTimeoutMs: number;
  private token: string | undefined;

  constructor(
    private url: string,
    opts: SidecarProviderOptions,
  ) {
    this.expectedModel = opts.expectedModel;
    this.token = opts.token;
    this.healthTtlMs = opts.healthTtlMs ?? 30_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
    this.info = { url, reachable: false, model: null, dim: null, faceModel: null, faceModels: [], device: null, lastError: null, checkedAt: null };
  }

  getInfo(): ProviderInfo {
    return { ...this.info };
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.token ? { ...extra, Authorization: `Bearer ${this.token}` } : extra;
  }

  async health(force = false): Promise<ProviderInfo> {
    const fresh = this.info.checkedAt && Date.now() - Date.parse(this.info.checkedAt) < this.healthTtlMs;
    if (!force && fresh) return this.getInfo();
    const checkedAt = new Date().toISOString();
    try {
      const res = await fetch(`${this.url}/v1/health`, { headers: this.headers(), signal: AbortSignal.timeout(5_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as SidecarHealth;
      const model = body.models.image_embed.id;
      const faceModel = body.models.faces?.id ?? null;
      const faceModels = body.face_models ?? (faceModel ? [{ name: "yunet-sface", id: faceModel, dim: body.models.faces?.dim ?? 0, license: "", label: "" }] : []);
      const base = { url: this.url, model, dim: body.models.image_embed.dim, faceModel, faceModels, device: body.device, checkedAt };
      if (model !== this.expectedModel) {
        this.info = { ...base, reachable: false, lastError: `Sidecar model ${model} does not match configured ${this.expectedModel}` };
      } else {
        this.info = { ...base, reachable: true, lastError: null };
      }
    } catch (err) {
      this.info = { ...this.info, reachable: false, lastError: err instanceof Error ? err.message : String(err), checkedAt };
    }
    return this.getInfo();
  }

  // True when the sidecar is up and lists the given face model.
  facesAvailable(model: string): boolean {
    return this.info.reachable && this.info.faceModels.some((m) => m.name === model);
  }

  private async post<T extends object>(path: string, init: RequestInit, expectModel?: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.url}${path}`, { ...init, signal: AbortSignal.timeout(this.requestTimeoutMs) });
    } catch (err) {
      this.info = { ...this.info, reachable: false, lastError: err instanceof Error ? err.message : String(err) };
      throw new ProviderUnavailableError(`Sidecar unreachable: ${this.info.lastError}`);
    }
    if (res.status >= 500) {
      this.info = { ...this.info, reachable: false, lastError: `HTTP ${res.status}` };
      throw new ProviderUnavailableError(`Sidecar error HTTP ${res.status}`);
    }
    if (!res.ok) {
      let detail = res.statusText;
      try {
        detail = ((await res.json()) as { detail?: string }).detail ?? detail;
      } catch {
        // non-JSON error body
      }
      throw new Error(`Sidecar rejected request (${res.status}): ${detail}`);
    }
    const body = (await res.json()) as T;
    const reported = (body as { model?: string }).model;
    if (expectModel && reported !== expectModel) {
      this.info = { ...this.info, reachable: false, lastError: `Sidecar model ${reported} does not match configured ${expectModel}` };
      throw new ProviderUnavailableError(this.info.lastError as string);
    }
    return body;
  }

  private toBatch(body: SidecarVectors): EmbeddingBatch {
    return { model: body.model, dim: body.dim, vectors: body.vectors.map((v) => Float32Array.from(v)) };
  }

  async embedImages(jpegs: Buffer[]): Promise<EmbeddingBatch> {
    const form = new FormData();
    jpegs.forEach((buf, i) => form.append("files", new Blob([buf], { type: "image/jpeg" }), `${i}.jpg`));
    return this.toBatch(await this.post<SidecarVectors>("/v1/embed/image", { method: "POST", body: form, headers: this.headers() }, this.expectedModel));
  }

  async embedText(texts: string[]): Promise<EmbeddingBatch> {
    return this.toBatch(
      await this.post<SidecarVectors>(
        "/v1/embed/text",
        { method: "POST", body: JSON.stringify({ texts }), headers: this.headers({ "Content-Type": "application/json" }) },
        this.expectedModel,
      ),
    );
  }

  async detectFaces(jpegs: Buffer[], model: string): Promise<FaceBatch> {
    const form = new FormData();
    form.append("model", model);
    jpegs.forEach((buf, i) => form.append("files", new Blob([buf], { type: "image/jpeg" }), `${i}.jpg`));
    const expected = FACE_MODEL_IDS[model] ?? model;
    const body = await this.post<SidecarFaces>("/v1/faces", { method: "POST", body: form, headers: this.headers() }, expected);
    return {
      model: body.model,
      dim: body.dim,
      images: body.images.map((faces) =>
        faces.map(
          (f): FaceDetection => ({
            bbox: [f.bbox[0], f.bbox[1], f.bbox[2], f.bbox[3]],
            landmarks: f.landmarks.map((p) => [p[0], p[1]] as [number, number]),
            detScore: f.det_score,
            embedding: Float32Array.from(f.embedding),
          }),
        ),
      ),
    };
  }

  async cluster(vectors: Float32Array[], opts: { threshold: number; minClusterSize: number }): Promise<number[]> {
    if (vectors.length === 0) return [];
    const body = await this.post<{ labels: number[] }>("/v1/cluster", {
      method: "POST",
      body: JSON.stringify({ vectors: vectors.map((v) => Array.from(v)), threshold: opts.threshold, min_cluster_size: opts.minClusterSize }),
      headers: this.headers({ "Content-Type": "application/json" }),
    });
    return body.labels;
  }
}
