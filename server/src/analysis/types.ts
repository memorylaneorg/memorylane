import type { MediaType, AnalysisStatus } from "@memorylane/shared";

export type { AnalysisStatus };

export interface AnalysisMediaRow {
  id: number;
  parent_folder_id: number;
  absolute_path: string;
  media_type: MediaType;
  file_size?: number;
}

export interface AnalyzerOutcome {
  mediaId: number;
  status: "done" | "failed" | "unsupported";
  error?: string;
}

// One unit of per-media work the AnalysisWorker knows how to schedule.
// `appliesTo` is a SQL predicate over `media` columns so ensureQueued can
// stay a single INSERT ... SELECT rather than a per-row JS filter.
export interface Analyzer {
  key: string;
  version: string;
  batchSize: number;
  appliesTo: string;
  requires?: string[];
  // Optional runtime switch (e.g. Settings > AI). When false the worker
  // leaves the analyzer's rows pending and skips it.
  isEnabled?: () => boolean;
  run(rows: AnalysisMediaRow[]): Promise<AnalyzerOutcome[]>;
}
