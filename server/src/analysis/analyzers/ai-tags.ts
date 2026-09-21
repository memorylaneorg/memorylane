import type Database from "better-sqlite3";
import { ProviderUnavailableError, type EmbeddingProvider } from "../../providers/types.js";
import { EmbeddingRepo } from "../../vectors/embedding-repo.js";
import { TagRepo } from "../../tags/tag-repo.js";
import { isMediaSourceVisible } from "../../plugins/registry.js";
import type { Analyzer, AnalysisMediaRow, AnalyzerOutcome } from "../types.js";

export const AI_TAG_KEY = "ai_tags";
const VOCAB_VERSION = "scene-v2";
const LABELS = [
  "animal", "architecture", "art", "beach", "bird", "boat", "building", "car", "city", "concert",
  "dance", "desert", "document", "dog", "family", "flower", "food", "forest", "garden", "lake",
  "landscape", "mountain", "museum", "night", "ocean", "park", "party", "person", "pet", "portrait",
  "receipt", "river", "snow", "sports", "street", "sunset", "travel", "tree", "wildlife",
] as const;

function selectTags(image: Float32Array, labels: Float32Array[]): { name: string; score: number }[] {
  const ranked = labels.map((vector, index) => ({ name: LABELS[index], score: vector.reduce((sum, n, i) => sum + n * image[i], 0) }))
    .filter((item) => Number.isFinite(item.score)).sort((a, b) => b.score - a.score);
  const best = ranked[0]?.score ?? 0;
  // Conservative relative shortlist. Similarity is a ranking signal, not a calibrated probability.
  return ranked.filter((item) => item.score >= 0.23 && item.score >= best - 0.04).slice(0, 3);
}

export function createAiTagAnalyzer(db: Database.Database, provider: EmbeddingProvider, isEnabled: () => boolean): Analyzer {
  const embeddings = new EmbeddingRepo(db);
  const tags = new TagRepo(db);
  const model = provider.expectedModel;
  const version = `${model}:${VOCAB_VERSION}`;
  const sqlModel = model.replace(/'/g, "''");
  let labelVectors: Promise<Float32Array[]> | null = null;
  const getLabels = () => {
    labelVectors ??= provider.embedText(LABELS.map((label) => `a photo of ${label}`)).then((batch) => {
      if (batch.model !== model || batch.vectors.length !== LABELS.length) throw new ProviderUnavailableError("Tag model mismatch");
      return batch.vectors;
    }).catch((error: unknown) => { labelVectors = null; throw error; });
    return labelVectors;
  };

  return {
    key: AI_TAG_KEY,
    version,
    batchSize: 64,
    requires: ["embed_image"],
    appliesTo: `media.media_type IN ('image', 'raw') AND EXISTS (
      SELECT 1 FROM media_embeddings e JOIN media_analysis a ON a.media_id = e.media_id AND a.analyzer = 'embed_image'
      WHERE e.media_id = media.id AND e.model = '${sqlModel}' AND a.status = 'done'
        AND a.model_version = '${sqlModel}' AND a.input_fingerprint = media.fingerprint)`,
    isEnabled,
    async run(rows: AnalysisMediaRow[]): Promise<AnalyzerOutcome[]> {
      const health = await provider.health();
      if (!health.reachable) throw new ProviderUnavailableError(health.lastError ?? "AI provider unavailable");
      const vectors = await getLabels();
      return rows.map((row) => {
        if (!isMediaSourceVisible(db, row.id)) return { mediaId: row.id, status: "unsupported", error: "Media source disabled" };
        const image = embeddings.get(row.id, model);
        if (!image || vectors.some((v) => v.length !== image.length)) return { mediaId: row.id, status: "unsupported", error: "Image embedding unavailable" };
        tags.replaceAi(row.id, selectTags(image, vectors), version);
        return { mediaId: row.id, status: "done" };
      });
    },
  };
}
