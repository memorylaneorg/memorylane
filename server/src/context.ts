import type Database from "better-sqlite3";
import type { AppPaths } from "./config/paths.js";
import { SessionStore } from "./auth/sessions.js";
import type { ScannerService } from "./scanner/scanner-service.js";
import type { RandomSelectionService } from "./media/random-selection-service.js";
import type { TranscodeWorker } from "./media/transcode-worker.js";
import type { AnalysisWorker } from "./analysis/analysis-worker.js";
import type { StackService } from "./stacks/stack-service.js";
import type { AiProvider } from "./providers/types.js";
import type { VectorIndex } from "./vectors/vector-index.js";
import type { EmbeddingRepo } from "./vectors/embedding-repo.js";
import type { PersonService } from "./persons/person-service.js";
import type { PluginManager } from "./plugin-platform/manager.js";
import type { PluginUpdateCoordinator } from "./plugin-platform/update-coordinator.js";

// Central set of app-wide singletons, built once at startup and passed to every
// route module. Keeps routes free of import-order/singleton-init footguns.
export interface AppContext {
  db: Database.Database;
  paths: AppPaths;
  sessions: SessionStore;
  scanner: ScannerService;
  randomSelection: RandomSelectionService;
  transcodeWorker: TranscodeWorker;
  analysisWorker: AnalysisWorker;
  stacks: StackService;
  // null when no AI provider is configured (MEMORYLANE_AI_PROVIDER=none).
  provider: AiProvider | null;
  vectorIndex: VectorIndex;
  embeddings: EmbeddingRepo;
  persons: PersonService;
  pluginManager?: PluginManager;
  pluginUpdates?: PluginUpdateCoordinator;
}
