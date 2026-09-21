import type Database from "better-sqlite3";
import type { Logger } from "pino";
import type { AppPaths } from "../config/paths.js";
import type { SettingsRepo } from "../db/settings-repo.js";
import type { AiProvider } from "../providers/types.js";
import type { VectorIndex } from "../vectors/vector-index.js";
import type { Analyzer } from "./types.js";
import { createExifFullAnalyzer } from "./analyzers/exif-full.js";
import { createPhashAnalyzer } from "./analyzers/phash.js";
import { createEmbedImageAnalyzer } from "./analyzers/embed-image.js";
import { createFacesAnalyzer } from "./analyzers/faces.js";
import { createAiTagAnalyzer } from "./analyzers/ai-tags.js";
import { createImportedTagAnalyzer } from "./analyzers/import-tags.js";
import type { PersonService } from "../persons/person-service.js";
import type { MediaToolCapabilities } from "../capabilities/media-tools.js";

export interface AnalyzerDeps {
  paths: AppPaths;
  settings: SettingsRepo;
  // null when MEMORYLANE_AI_PROVIDER=none - provider-backed analyzers are then not registered at all.
  provider: AiProvider | null;
  vectorIndex: VectorIndex;
  persons: PersonService;
  mediaTools: MediaToolCapabilities;
}

// Registration order is execution order. Phase 1: EXIF; Phase 2: perceptual
// hash for stacks; Phase 3: image embeddings via the sidecar. Faces follow.
export function createAnalyzers(db: Database.Database, _logger: Logger, deps: AnalyzerDeps): Analyzer[] {
  const analyzers: Analyzer[] = [createExifFullAnalyzer(db, deps.mediaTools), createImportedTagAnalyzer(db), createPhashAnalyzer(db, deps.paths)];
  if (deps.provider) {
    analyzers.push(createEmbedImageAnalyzer(db, deps.paths, deps.provider, deps.vectorIndex, () => deps.settings.getAll().aiEnabled));
    analyzers.push(createAiTagAnalyzer(db, deps.provider, () => deps.settings.getAll().aiEnabled));
    analyzers.push(
      createFacesAnalyzer(
        db, deps.paths, deps.provider, deps.vectorIndex, deps.settings,
        () => {
          const s = deps.settings.getAll();
          return s.aiEnabled && s.personsEnabled;
        },
        async (ids) => {
          await deps.persons.assignNewFaces(ids);
        },
      ),
    );
  }
  return analyzers;
}
