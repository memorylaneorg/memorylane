import type Database from "better-sqlite3";
import type { AppPaths } from "../../config/paths.js";
import { FACE_MODEL_IDS, ProviderUnavailableError, type AiProvider } from "../../providers/types.js";
import type { SettingsRepo } from "../../db/settings-repo.js";
import { renderAnalysisJpeg } from "../../media/analysis-input.js";
import { FaceRepo } from "../../persons/face-repo.js";
import { spaceFor, type VectorIndex } from "../../vectors/vector-index.js";
import type { Analyzer, AnalysisMediaRow, AnalyzerOutcome } from "../types.js";
import { isApplePhotosEnabled, isMediaSourceVisible } from "../../plugins/registry.js";

export const FACES_KEY = "faces";

// Detects faces on a 1600px render of each still, stores rows + vectors in
// the faces:<model> space, then hands new face ids to PersonService for
// incremental assignment. Disabled until People is switched on.
export function createFacesAnalyzer(
  db: Database.Database,
  paths: AppPaths,
  provider: AiProvider,
  index: VectorIndex,
  settings: SettingsRepo,
  isEnabled: () => boolean,
  onNewFaces: (faceIds: number[]) => Promise<void>,
): Analyzer {
  const repo = new FaceRepo(db);
  const modelName = () => settings.getAll().faceModel;
  return {
    key: FACES_KEY,
    // Follows Settings › People › Face model; a change makes every done row
    // stale (see AnalysisWorker.requeueStale) so photos are re-detected.
    get version() {
      return FACE_MODEL_IDS[modelName()] ?? modelName();
    },
    batchSize: 8,
    appliesTo: "media_type IN ('image', 'raw') AND thumbnail_status = 'done'",
    isEnabled,
    async run(rows: AnalysisMediaRow[]): Promise<AnalyzerOutcome[]> {
      const health = await provider.health();
      if (!health.reachable) throw new ProviderUnavailableError(health.lastError ?? "Sidecar not reachable");
      const model = modelName();
      if (!health.faceModels.some((m) => m.name === model)) {
        throw new ProviderUnavailableError(`Sidecar does not offer face model "${model}" (has: ${health.faceModels.map((m) => m.name).join(", ") || "none"})`);
      }

      const outcomes = new Map<number, AnalyzerOutcome>();
      const inputs: { row: AnalysisMediaRow; jpeg: Buffer }[] = [];
      for (const row of rows) {
        if (!isMediaSourceVisible(db, row.id)) {
          outcomes.set(row.id, { mediaId: row.id, status: "unsupported", error: "Media source disabled" });
          continue;
        }
        const jpeg = await renderAnalysisJpeg(paths, row);
        if (!jpeg) outcomes.set(row.id, { mediaId: row.id, status: "unsupported", error: "No analysable image" });
        else inputs.push({ row, jpeg });
      }

      const activeInputs = inputs.filter((i) => isMediaSourceVisible(db, i.row.id));
      for (const input of inputs) if (!activeInputs.includes(input)) outcomes.set(input.row.id, { mediaId: input.row.id, status: "unsupported", error: "Media source disabled" });
      if (activeInputs.length > 0) {
        const batch = await provider.detectFaces(activeInputs.map((i) => i.jpeg), model);
        if (batch.images.length !== activeInputs.length) throw new Error(`Sidecar returned ${batch.images.length} results for ${activeInputs.length} images`);
        const space = spaceFor("faces", batch.model);
        const newIds: number[] = [];
        const upserts: { id: number; vector: Float32Array }[] = [];
        const removals: number[] = [];
        activeInputs.forEach((input, k) => {
          if (!isMediaSourceVisible(db, input.row.id)) {
            outcomes.set(input.row.id, { mediaId: input.row.id, status: "unsupported", error: "Media source disabled" });
            return;
          }
          const dets = batch.images[k];
          const { ids, removed } = repo.replaceForMedia(input.row.id, batch.model, dets);
          removals.push(...removed);
          ids.forEach((id, j) => upserts.push({ id, vector: dets[j].embedding }));
          newIds.push(...ids);
          outcomes.set(input.row.id, { mediaId: input.row.id, status: "done" });
        });
        await index.remove(space, removals);
        await index.upsert(space, upserts);
        if (isApplePhotosEnabled(db)) {
          const { applyApplePersonSuggestions } = await import("../../plugins/apple-photos/people.js");
          for (const input of activeInputs) if (isMediaSourceVisible(db, input.row.id)) applyApplePersonSuggestions(db, input.row.id);
        }
        await onNewFaces(newIds);
      }
      return rows.map((r) => outcomes.get(r.id) as AnalyzerOutcome);
    },
  };
}
