import type Database from "better-sqlite3";
import type { Analyzer, AnalyzerOutcome, AnalysisMediaRow, AnalysisStatus } from "./types.js";
import { ACTIVE_SOURCE_SQL, UNMARKED_MEDIA_SQL } from "../query/media-query.js";

// A row that fails this many times stays 'failed' until an explicit retry
// (Settings > Analysis > Retry failed) - a poison file must not loop forever.
export const MAX_ATTEMPTS = 3;

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export class AnalysisRepo {
  constructor(private db: Database.Database) {}

  // Pending rows for every active media item the analyzer applies to that
  // has no row yet. Safe to call repeatedly (PK conflict = ignored).
  ensureQueued(a: Analyzer): number {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO media_analysis (media_id, analyzer, status, updated_at)
         SELECT id, ?, 'pending', ${NOW} FROM media
         WHERE media.status = 'active' AND ${ACTIVE_SOURCE_SQL} AND ${UNMARKED_MEDIA_SQL} AND (${a.appliesTo})`,
      )
      .run(a.key);
    return info.changes;
  }

  // Use completed upstream IDs instead of scanning the whole library after
  // every analysis batch. This also lets an updated result refresh tags that
  // were already marked done for an older EXIF/embedding result.
  ensureQueuedForIds(a: Analyzer, mediaIds: number[]): number {
    if (mediaIds.length === 0) return 0;
    const placeholders = mediaIds.map(() => "?").join(",");
    return this.db.prepare(`INSERT OR IGNORE INTO media_analysis (media_id, analyzer, status, updated_at)
      SELECT media.id, ?, 'pending', ${NOW} FROM media
      WHERE media.id IN (${placeholders}) AND media.status = 'active' AND ${ACTIVE_SOURCE_SQL}
        AND ${UNMARKED_MEDIA_SQL} AND (${a.appliesTo})`).run(a.key, ...mediaIds).changes;
  }

  refreshDependentForIds(a: Analyzer, mediaIds: number[]): void {
    if (mediaIds.length === 0) return;
    const placeholders = mediaIds.map(() => "?").join(",");
    this.db.transaction(() => {
      this.db.prepare(`UPDATE media_analysis SET status = 'pending', attempts = 0, error = NULL, updated_at = ${NOW}
        WHERE analyzer = ? AND media_id IN (${placeholders}) AND status IN ('done', 'unsupported', 'failed')`)
        .run(a.key, ...mediaIds);
      this.ensureQueuedForIds(a, mediaIds);
    })();
  }

  requeueStaleVersions(a: Analyzer): number {
    return this.db
      .prepare(
        `UPDATE media_analysis SET status = 'pending', attempts = 0, error = NULL, updated_at = ${NOW}
         WHERE analyzer = ? AND status = 'done' AND (model_version IS NULL OR model_version != ?)`,
      )
      .run(a.key, a.version).changes;
  }

  // Used by the scan path, which produces the analyzer's result inline
  // (e.g. media_exif written by processMediaItem) without going through the queue.
  markDone(mediaId: number, analyzerKey: string, version: string): void {
    this.db
      .prepare(
        `INSERT INTO media_analysis (media_id, analyzer, status, model_version, input_fingerprint, attempts, error, updated_at)
         VALUES (?, ?, 'done', ?, (SELECT fingerprint FROM media WHERE id = ?), 0, NULL, ${NOW})
         ON CONFLICT(media_id, analyzer) DO UPDATE SET
           status = 'done', model_version = excluded.model_version, input_fingerprint = excluded.input_fingerprint,
           attempts = 0, error = NULL, updated_at = excluded.updated_at`,
      )
      .run(mediaId, analyzerKey, version, mediaId);
  }

  // Explicitly queue one row (used by the scan path when its inline attempt
  // failed for a retryable reason, e.g. an unreadable file).
  markPending(mediaId: number, analyzerKey: string, error: string | null): void {
    this.db
      .prepare(
        `INSERT INTO media_analysis (media_id, analyzer, status, error, updated_at) VALUES (?, ?, 'pending', ?, ${NOW})
         ON CONFLICT(media_id, analyzer) DO UPDATE SET status = 'pending', error = excluded.error, updated_at = excluded.updated_at`,
      )
      .run(mediaId, analyzerKey, error);
  }

  // The file changed on disk (fingerprint mismatch) - every analyzer's result is stale.
  resetForMedia(mediaId: number): void {
    this.db
      .prepare(`UPDATE media_analysis SET status = 'pending', attempts = 0, error = NULL, updated_at = ${NOW} WHERE media_id = ?`)
      .run(mediaId);
  }

  claimBatch(analyzer: Analyzer): AnalysisMediaRow[] {
    const claim = this.db.transaction((): AnalysisMediaRow[] => {
      const rows = this.db
        .prepare(
          `SELECT media.id, media.parent_folder_id, media.absolute_path, media.media_type, media.file_size
           FROM media_analysis ma JOIN media ON media.id = ma.media_id
           WHERE ma.analyzer = ? AND ma.status = 'pending' AND media.status = 'active' AND ${ACTIVE_SOURCE_SQL} AND ${UNMARKED_MEDIA_SQL}
             AND (${analyzer.appliesTo})
           ORDER BY ma.media_id LIMIT ?`,
        )
        .all(analyzer.key, analyzer.batchSize) as AnalysisMediaRow[];
      if (rows.length === 0) return rows;
      const placeholders = rows.map(() => "?").join(",");
      this.db
        .prepare(`UPDATE media_analysis SET status = 'running', updated_at = ${NOW} WHERE analyzer = ? AND media_id IN (${placeholders})`)
        .run(analyzer.key, ...rows.map((r) => r.id));
      return rows;
    });
    return claim();
  }

  complete(analyzerKey: string, version: string, outcomes: AnalyzerOutcome[]): void {
    const done = this.db.prepare(
      `UPDATE media_analysis SET status = ?, model_version = ?, input_fingerprint = (SELECT fingerprint FROM media WHERE id = media_analysis.media_id),
         attempts = attempts + 1, error = NULL, updated_at = ${NOW}
       WHERE media_id = ? AND analyzer = ?`,
    );
    const failed = this.db.prepare(
      `UPDATE media_analysis SET
         attempts = attempts + 1,
         status = CASE WHEN attempts + 1 >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END,
         error = ?, updated_at = ${NOW}
       WHERE media_id = ? AND analyzer = ?`,
    );
    const tx = this.db.transaction((items: AnalyzerOutcome[]) => {
      for (const o of items) {
        if (o.status === "failed") failed.run(o.error ?? "unknown error", o.mediaId, analyzerKey);
        else done.run(o.status, version, o.mediaId, analyzerKey);
      }
    });
    tx(outcomes);
  }

  // Puts claimed rows back without counting an attempt - used when the
  // provider (not the file) was the problem.
  unclaim(analyzerKey: string, mediaIds: number[]): void {
    if (mediaIds.length === 0) return;
    const placeholders = mediaIds.map(() => "?").join(",");
    this.db
      .prepare(`UPDATE media_analysis SET status = 'pending', updated_at = ${NOW} WHERE analyzer = ? AND status = 'running' AND media_id IN (${placeholders})`)
      .run(analyzerKey, ...mediaIds);
  }

  // Nothing survives a process restart, so 'running' can only mean "was
  // interrupted" at startup - same reasoning as TranscodeWorker.reconcileAndResume.
  resetRunning(): number {
    return this.db
      .prepare(`UPDATE media_analysis SET status = 'pending', updated_at = ${NOW} WHERE status = 'running'`)
      .run().changes;
  }

  retryFailed(analyzerKey?: string): number {
    const sql = `UPDATE media_analysis SET status = 'pending', attempts = 0, error = NULL, updated_at = ${NOW}
                 WHERE status IN ('failed', 'unsupported')${analyzerKey ? " AND analyzer = ?" : ""}`;
    const stmt = this.db.prepare(sql);
    return (analyzerKey ? stmt.run(analyzerKey) : stmt.run()).changes;
  }

  lastErrors(): Map<string, string> {
    const rows = this.db
      .prepare(
        `SELECT analyzer, error FROM media_analysis m
         WHERE status = 'failed' AND error IS NOT NULL
           AND updated_at = (SELECT MAX(updated_at) FROM media_analysis WHERE analyzer = m.analyzer AND status = 'failed' AND error IS NOT NULL)`,
      )
      .all() as { analyzer: string; error: string }[];
    return new Map(rows.map((r) => [r.analyzer, r.error]));
  }

  counts(): { analyzer: string; status: AnalysisStatus; count: number }[] {
    return this.db
      .prepare("SELECT analyzer, status, COUNT(*) as count FROM media_analysis GROUP BY analyzer, status ORDER BY analyzer, status")
      .all() as { analyzer: string; status: AnalysisStatus; count: number }[];
  }
}
