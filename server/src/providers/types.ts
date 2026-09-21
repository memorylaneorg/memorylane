// An inference provider turns bytes/text into
// vectors; it never sees file paths or the database.

// Thrown for outages (network, 5xx, model mismatch) - the analysis worker
// puts rows back to pending and backs off instead of marking them failed.
export class ProviderUnavailableError extends Error {}

export interface ProviderInfo {
  url: string;
  reachable: boolean;
  model: string | null;
  dim: number | null;
  faceModel: string | null;
  faceModels: { name: string; id: string; dim: number; license: string; label: string }[];
  device: string | null;
  lastError: string | null;
  checkedAt: string | null;
}

export interface EmbeddingBatch {
  model: string;
  dim: number;
  vectors: Float32Array[];
}

export interface ImageEmbeddingProvider {
  readonly id: string;
  // The model id vectors are stored under; the provider refuses to run if the
  // sidecar reports a different one so spaces never mix.
  readonly expectedModel: string;
  embedImages(jpegs: Buffer[]): Promise<EmbeddingBatch>;
}

export interface TextEmbeddingProvider {
  embedText(texts: string[]): Promise<EmbeddingBatch>;
}

export interface FaceDetection {
  bbox: [number, number, number, number]; // x, y, w, h normalised to the sent image
  landmarks: [number, number][];
  detScore: number;
  embedding: Float32Array;
}

export interface FaceBatch {
  model: string;
  dim: number;
  images: FaceDetection[][];
}

// Face model names the sidecar knows, and the ids it reports for them.
export const FACE_MODEL_IDS: Record<string, string> = { "yunet-sface": "yunet-sface@1", buffalo_l: "buffalo_l@1" };

export interface FaceProvider {
  // Sends `model` and refuses a response reporting a different id.
  detectFaces(jpegs: Buffer[], model: string): Promise<FaceBatch>;
  cluster(vectors: Float32Array[], opts: { threshold: number; minClusterSize: number }): Promise<number[]>;
}

export interface EmbeddingProvider extends ImageEmbeddingProvider, TextEmbeddingProvider {
  health(force?: boolean): Promise<ProviderInfo>;
  getInfo(): ProviderInfo;
}

// Everything the sidecar offers, behind one health check.
export interface AiProvider extends EmbeddingProvider, FaceProvider {}
