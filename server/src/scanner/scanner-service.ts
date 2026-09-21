import fs from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import type { Logger } from "pino";
import pLimit from "p-limit";
import type { ScanRunDto, ScanStatusDto, ScanTrigger } from "@memorylane/shared";
import type { AppPaths } from "../config/paths.js";
import { classifyExtension } from "./media-types.js";
import { computeFingerprint } from "./fingerprint.js";
import { getOrCreateFolder } from "./folder-repo.js";
import { processMediaItem } from "../media/media-processor.js";
import { AnalysisRepo } from "../analysis/analysis-repo.js";
import { markFoldersDirty } from "../stacks/dirty.js";
import { isApplePhotosEnabled } from "../plugins/registry.js";
import { DeferredMediaToolCapabilities, type MediaToolCapabilities } from "../capabilities/media-tools.js";

interface ScanRootRow {
  id: number;
  path: string;
  enabled: number;
  kind: "folder" | "apple-photos";
}

interface MediaLookupRow {
  id: number;
  fingerprint: string;
  thumbnail_status: string;
}

interface ScanRunRow {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: string;
  files_scanned: number;
  files_new: number;
  files_changed: number;
  files_removed: number;
  error_count: number;
  trigger_source: string;
  scan_root_id: number | null;
  current_scan_root_id: number | null;
  thumbnails_queued: number;
  thumbnails_processed: number;
}

function toScanRunDto(row: ScanRunRow): ScanRunDto {
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status as ScanRunDto["status"],
    filesScanned: row.files_scanned,
    filesNew: row.files_new,
    filesChanged: row.files_changed,
    filesRemoved: row.files_removed,
    errorCount: row.error_count,
    trigger: row.trigger_source as ScanTrigger,
    scanRootId: row.scan_root_id,
    currentScanRootId: row.current_scan_root_id,
    thumbnailsQueued: row.thumbnails_queued,
    thumbnailsProcessed: row.thumbnails_processed,
  };
}

interface Stats {
  filesScanned: number;
  filesNew: number;
  filesChanged: number;
  filesRemoved: number;
  errorCount: number;
  thumbnailsQueued: number;
  thumbnailsProcessed: number;
  // Which root is actively being walked right now - distinct from the run's
  // own scan_root_id (the run's fixed scope, null for an all-folders run).
  // Lets the client attribute live progress to a specific folder even during
  // a multi-folder run.
  currentScanRootId: number | null;
}

const THUMBNAIL_QUEUE_CONCURRENCY = 4;
const THUMBNAIL_QUEUE_FLUSH_SIZE = 200;

export class ScannerService {
  private running = false;
  private scheduleTimer: NodeJS.Timeout | null = null;
  private finishedListeners: (() => void)[] = [];
  private appleRootSync: ((rootId: number) => Promise<void>) | null = null;
  private analysisRepo: AnalysisRepo;

  constructor(
    private db: Database.Database,
    private paths: AppPaths,
    private logger: Logger,
    private mediaTools: MediaToolCapabilities = new DeferredMediaToolCapabilities(),
  ) {
    this.analysisRepo = new AnalysisRepo(db);
  }

  isRunning(): boolean {
    return this.running;
  }

  // Fired after every run (completed or failed) - the AnalysisWorker uses
  // this to queue newly indexed media without the scanner importing it.
  onScanFinished(cb: () => void): void {
    this.finishedListeners.push(cb);
  }

  onAppleRootSync(cb: (rootId: number) => Promise<void>): void {
    this.appleRootSync = cb;
  }

  getStatus(): ScanStatusDto {
    const currentRun = this.running ? this.getLatestRun() : null;
    const lastRun = this.getLatestRun();
    const lastSuccessfulRun = this.db
      .prepare("SELECT * FROM scan_runs WHERE status = 'completed' ORDER BY id DESC LIMIT 1")
      .get() as ScanRunRow | undefined;
    return {
      running: this.running,
      currentRun,
      lastRun: lastRun ?? null,
      lastSuccessfulRun: lastSuccessfulRun ? toScanRunDto(lastSuccessfulRun) : null,
      nextScheduledAt: null,
    };
  }

  private getLatestRun(): ScanRunDto | null {
    const row = this.db.prepare("SELECT * FROM scan_runs ORDER BY id DESC LIMIT 1").get() as
      | ScanRunRow
      | undefined;
    return row ? toScanRunDto(row) : null;
  }

  getHistory(limit = 20): ScanRunDto[] {
    const rows = this.db
      .prepare("SELECT * FROM scan_runs ORDER BY id DESC LIMIT ?")
      .all(limit) as ScanRunRow[];
    return rows.map(toScanRunDto);
  }

  // scanRootId scopes the run to a single folder ("Scan Now" on one scan root
  // in Settings); omitted, it scans every enabled root as before.
  async runScan(trigger: ScanTrigger, scanRootId?: number): Promise<void> {
    if (this.running) {
      throw new Error("A scan is already running");
    }

    let roots: ScanRootRow[];
    if (scanRootId !== undefined) {
      const root = this.db.prepare("SELECT * FROM scan_roots WHERE id = ?").get(scanRootId) as
        | ScanRootRow
        | undefined;
      if (!root) throw new Error("Scan root not found");
      if (!root.enabled) throw new Error("Scan root is disabled");
      roots = [root];
    } else {
      roots = this.db.prepare("SELECT * FROM scan_roots WHERE enabled = 1").all() as ScanRootRow[];
    }

    this.running = true;
    const runStartedAt = new Date().toISOString();
    const runInfo = this.db
      .prepare("INSERT INTO scan_runs (status, trigger_source, scan_root_id) VALUES ('running', ?, ?)")
      .run(trigger, scanRootId ?? null);
    const runId = Number(runInfo.lastInsertRowid);

    const stats: Stats = {
      filesScanned: 0, filesNew: 0, filesChanged: 0, filesRemoved: 0, errorCount: 0,
      thumbnailsQueued: 0, thumbnailsProcessed: 0, currentScanRootId: null,
    };
    // Snapshot once per run rather than querying per-directory - the list is
    // small and only changes via explicit user action, never mid-scan.
    const ignoredPaths = new Set(
      (this.db.prepare("SELECT path FROM ignored_paths").all() as { path: string }[]).map((r) => r.path),
    );
    const limiter = pLimit(THUMBNAIL_QUEUE_CONCURRENCY);
    let pendingJobs: Promise<void>[] = [];

    const enqueueProcessing = (mediaId: number, absolutePath: string, mediaType: "image" | "raw" | "video", parentFolderId: number) => {
      stats.thumbnailsQueued++;
      pendingJobs.push(
        limiter(() =>
          processMediaItem(this.db, this.paths, this.logger, {
            id: mediaId,
            parent_folder_id: parentFolderId,
            absolute_path: absolutePath,
            media_type: mediaType,
          }, this.mediaTools).finally(() => {
            stats.thumbnailsProcessed++;
          }),
        ),
      );
    };

    const flushIfNeeded = async (force = false) => {
      if (pendingJobs.length >= THUMBNAIL_QUEUE_FLUSH_SIZE || force) {
        const batch = pendingJobs;
        pendingJobs = [];
        await Promise.all(batch);
      }
    };

    // Indexing can finish in seconds while thumbnail generation (rate-limited
    // to THUMBNAIL_QUEUE_CONCURRENCY at a time) continues for much longer on a
    // large backlog - without this, the scan_runs row (and so /api/scans/status)
    // never changed until the whole run finished, making a long-running scan
    // look identical to a stalled one. Same cadence as the client's poll.
    const persistProgress = () => {
      this.db
        .prepare(
          `UPDATE scan_runs SET
            files_scanned = ?, files_new = ?, files_changed = ?, files_removed = ?, error_count = ?,
            thumbnails_queued = ?, thumbnails_processed = ?, current_scan_root_id = ?
           WHERE id = ?`,
        )
        .run(
          stats.filesScanned, stats.filesNew, stats.filesChanged, stats.filesRemoved, stats.errorCount,
          stats.thumbnailsQueued, stats.thumbnailsProcessed, stats.currentScanRootId, runId,
        );
    };
    const progressTimer = setInterval(persistProgress, 2000);

    this.logger.info({ runId, trigger, scanRootId: scanRootId ?? "all" }, "Scan started");

    try {
      const scannedRootIds: number[] = [];
      for (const root of roots) {
        stats.currentScanRootId = root.id;
        persistProgress();
        if (root.kind === "apple-photos") {
          if (isApplePhotosEnabled(this.db)) {
            try {
              if (!this.appleRootSync) throw new Error("Apple Photos sync is not configured");
              await this.appleRootSync(root.id);
            } catch (err) {
              stats.errorCount++;
              this.logger.error({ err, root: root.path }, "Apple Photos catalogue sync failed");
            }
          }
          continue;
        }
        try {
          await this.scanRoot(root, stats, ignoredPaths, enqueueProcessing, flushIfNeeded);
          scannedRootIds.push(root.id);
        } catch (err) {
          stats.errorCount++;
          this.logger.error({ err, root: root.path }, "Failed to scan root - continuing with remaining roots");
        }
      }

      await flushIfNeeded(true);

      // Anything not touched during this run (last_seen_at before this run started) is
      // now missing - but only within the root(s) this run actually covered. A scan
      // scoped to one folder (or a run that skips disabled roots) must never mark media
      // in untouched roots as missing just because this run didn't visit them.
      const placeholders = scannedRootIds.map(() => "?").join(",");

      const missingMedia = scannedRootIds.length
        ? (this.db
            .prepare(
              `UPDATE media SET status = 'missing'
               WHERE status = 'active' AND last_seen_at < ? AND scan_root_id IN (${placeholders})
               RETURNING id, parent_folder_id`,
            )
            .all(runStartedAt, ...scannedRootIds) as { id: number; parent_folder_id: number }[])
        : [];
      stats.filesRemoved = missingMedia.length;
      // A vanished frame may have been a stack member - its folder needs re-stacking.
      markFoldersDirty(this.db, missingMedia.map((m) => m.parent_folder_id));

      if (scannedRootIds.length) {
        this.db
          .prepare(
            `UPDATE folders SET status = 'missing'
             WHERE status = 'active' AND updated_at < ? AND scan_root_id IN (${placeholders})`,
          )
          .run(runStartedAt, ...scannedRootIds);
      }

      this.db
        .prepare(
          `UPDATE scan_runs SET status = 'completed', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           files_scanned = ?, files_new = ?, files_changed = ?, files_removed = ?, error_count = ?,
           thumbnails_queued = ?, thumbnails_processed = ? WHERE id = ?`,
        )
        .run(
          stats.filesScanned, stats.filesNew, stats.filesChanged, stats.filesRemoved, stats.errorCount,
          stats.thumbnailsQueued, stats.thumbnailsProcessed, runId,
        );

      this.logger.info({ runId, stats }, "Scan completed");
      // Consider all tables, including those not queried by this connection
      // yet. SQLite bounds this work and refreshes statistics when needed
      // after library growth; keep it off the request path.
      try {
        this.db.pragma("optimize = 0x10002");
      } catch (err) {
        this.logger.warn({ err }, "Could not refresh database planner statistics");
      }
    } catch (err) {
      this.logger.error({ err, runId }, "Scan failed");
      this.db
        .prepare(
          `UPDATE scan_runs SET status = 'failed', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           files_scanned = ?, files_new = ?, files_changed = ?, files_removed = ?, error_count = ?,
           thumbnails_queued = ?, thumbnails_processed = ? WHERE id = ?`,
        )
        .run(
          stats.filesScanned, stats.filesNew, stats.filesChanged, stats.filesRemoved, stats.errorCount + 1,
          stats.thumbnailsQueued, stats.thumbnailsProcessed, runId,
        );
    } finally {
      clearInterval(progressTimer);
      this.running = false;
      for (const cb of this.finishedListeners) {
        try {
          cb();
        } catch (err) {
          this.logger.error({ err }, "Scan-finished listener failed");
        }
      }
    }
  }

  private async scanRoot(
    root: ScanRootRow,
    stats: Stats,
    ignoredPaths: Set<string>,
    enqueueProcessing: (mediaId: number, absolutePath: string, mediaType: "image" | "raw" | "video", parentFolderId: number) => void,
    flushIfNeeded: (force?: boolean) => Promise<void>,
  ): Promise<void> {
    let rootStat;
    try {
      rootStat = await fs.stat(root.path);
    } catch {
      this.logger.warn({ root: root.path }, "Scan root is not accessible - skipping");
      stats.errorCount++;
      return;
    }
    if (!rootStat.isDirectory()) {
      this.logger.warn({ root: root.path }, "Scan root is not a directory - skipping");
      return;
    }

    const rootFolder = getOrCreateFolder(this.db, root.id, null, path.basename(root.path), root.path);
    await this.walkDirectory(root, rootFolder.id, root.path, stats, ignoredPaths, enqueueProcessing, flushIfNeeded);
  }

  private async walkDirectory(
    root: ScanRootRow,
    parentFolderId: number,
    dirPath: string,
    stats: Stats,
    ignoredPaths: Set<string>,
    enqueueProcessing: (mediaId: number, absolutePath: string, mediaType: "image" | "raw" | "video", parentFolderId: number) => void,
    flushIfNeeded: (force?: boolean) => Promise<void>,
  ): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch (err) {
      this.logger.warn({ err, dir: dirPath }, "Could not read directory - skipping (permission or I/O error)");
      stats.errorCount++;
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        // Ignored folders are skipped entirely - never indexed, no folder row
        // created for them - rather than indexed then filtered out later.
        if (ignoredPaths.has(entryPath) || entry.name === "_MemoryLane-Trash" || entry.name.toLowerCase().endsWith(".photoslibrary")) continue;
        const folder = getOrCreateFolder(this.db, root.id, parentFolderId, entry.name, entryPath);
        await this.walkDirectory(root, folder.id, entryPath, stats, ignoredPaths, enqueueProcessing, flushIfNeeded);
        continue;
      }

      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).slice(1).toLowerCase();
      const mediaType = classifyExtension(ext);
      if (!mediaType) continue; // unsupported file type, skip silently (not an error)

      try {
        await this.indexFile(root, parentFolderId, entryPath, entry.name, ext, mediaType, stats, enqueueProcessing);
      } catch (err) {
        stats.errorCount++;
        this.logger.warn({ err, file: entryPath }, "Failed to index file - continuing scan");
      }

      await flushIfNeeded();
    }
  }

  private async indexFile(
    root: ScanRootRow,
    parentFolderId: number,
    absolutePath: string,
    filename: string,
    extension: string,
    mediaType: "image" | "raw" | "video",
    stats: Stats,
    enqueueProcessing: (mediaId: number, absolutePath: string, mediaType: "image" | "raw" | "video", parentFolderId: number) => void,
  ): Promise<void> {
    const stat = await fs.stat(absolutePath);
    const fingerprint = computeFingerprint(stat.size, stat.mtimeMs);
    const fsCreatedAt = stat.birthtimeMs > 0 ? stat.birthtime.toISOString() : null;

    const existing = this.db
      .prepare("SELECT id, fingerprint, thumbnail_status FROM media WHERE absolute_path = ?")
      .get(absolutePath) as MediaLookupRow | undefined;

    stats.filesScanned++;

    if (!existing) {
      const info = this.db
        .prepare(
          `INSERT INTO media (parent_folder_id, scan_root_id, absolute_path, filename, extension, media_type,
            file_size, fs_created_at, fs_modified_at, fingerprint, thumbnail_status, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'active')`,
        )
        .run(
          parentFolderId, root.id, absolutePath, filename, extension, mediaType,
          stat.size, fsCreatedAt, stat.mtime.toISOString(), fingerprint,
        );
      stats.filesNew++;
      markFoldersDirty(this.db, [parentFolderId]);
      enqueueProcessing(Number(info.lastInsertRowid), absolutePath, mediaType, parentFolderId);
      return;
    }

    if (existing.fingerprint !== fingerprint) {
      this.db
        .prepare(
          `UPDATE media SET file_size = ?, fs_modified_at = ?, fingerprint = ?, thumbnail_status = 'pending',
           status = 'active', last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), parent_folder_id = ?
           WHERE id = ?`,
        )
        .run(stat.size, stat.mtime.toISOString(), fingerprint, parentFolderId, existing.id);
      // Every analyzer's stored result was computed from the old bytes.
      this.analysisRepo.resetForMedia(existing.id);
      markFoldersDirty(this.db, [parentFolderId]);
      stats.filesChanged++;
      enqueueProcessing(existing.id, absolutePath, mediaType, parentFolderId);
      return;
    }

    this.db
      .prepare(
        "UPDATE media SET status = 'active', last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), parent_folder_id = ? WHERE id = ?",
      )
      .run(parentFolderId, existing.id);

    // Unchanged file, but its thumbnail/preview never finished successfully
    // (interrupted scan, failure, or - for RAW - scanned before a newer
    // preview tier existed) - retry it even though the fingerprint matches,
    // so problems self-heal on the next scan instead of persisting forever.
    if (existing.thumbnail_status !== "done") {
      enqueueProcessing(existing.id, absolutePath, mediaType, parentFolderId);
    }
  }

  // Called once at startup - if scheduled scanning is enabled and the interval
  // has elapsed since the last run, kicks off a scan; otherwise arms a timer
  // for the remaining interval.
  scheduleFromSettings(scanIntervalDays: number | null, scanScheduleEnabled: boolean): void {
    if (this.scheduleTimer) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = null;
    }
    if (!scanScheduleEnabled || !scanIntervalDays) return;

    const intervalMs = scanIntervalDays * 24 * 60 * 60 * 1000;
    const lastRun = this.db
      .prepare("SELECT started_at FROM scan_runs WHERE status = 'completed' ORDER BY id DESC LIMIT 1")
      .get() as { started_at: string } | undefined;

    const elapsedMs = lastRun ? Date.now() - new Date(lastRun.started_at).getTime() : Infinity;
    const delayMs = Math.max(0, intervalMs - elapsedMs);

    this.scheduleTimer = setTimeout(() => {
      this.runScan("scheduled")
        .catch((err) => this.logger.error({ err }, "Scheduled scan failed"))
        .finally(() => this.scheduleFromSettings(scanIntervalDays, scanScheduleEnabled));
    }, delayMs);
    this.scheduleTimer.unref();
  }
}
