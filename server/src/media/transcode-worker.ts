import fs from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import type { Logger } from "pino";
import pLimit from "p-limit";
import type { VideoTranscodeQuality, ArchiveTranscodedResultDto } from "@memorylane/shared";
import { transcodingPathForMediaId, transcodingThumbnailPathForMediaId, type AppPaths } from "../config/paths.js";
import { generateThumbnailFromBuffer } from "./thumbnail-generator.js";
import type { TranscodeJobRow } from "../api/mappers.js";
import type { ScannerService } from "../scanner/scanner-service.js";
import { DeferredMediaToolCapabilities, type MediaToolCapabilities } from "../capabilities/media-tools.js";

interface MediaRowForTranscode {
  id: number;
  scan_root_id: number;
  absolute_path: string;
  filename: string;
  duration_seconds: number | null;
  file_size: number;
}

// A finished duration that's this close to the original (in seconds, or 2%
// of the original's length if that's larger - short clips need an absolute
// floor, long ones need a proportional one) counts as a match. Frame-rate
// rounding alone can account for a fraction of a second either way.
const DURATION_TOLERANCE_SECONDS = 1;
const DURATION_TOLERANCE_RATIO = 0.02;

// Sibling folder created inside a scan root the first time anything in it is
// archived - visible, ordinary files the user can always get to directly,
// auto-registered in ignored_paths so the scanner never re-indexes them.
const ARCHIVE_FOLDER_NAME = "_MemoryLane-Archived-Originals";

function replaceExtensionMp4(filename: string): string {
  return `${path.basename(filename, path.extname(filename))}.mp4`;
}

function nowIso(): string {
  return new Date().toISOString();
}

// Runs video transcode jobs one at a time (concurrency 1 - encoding is CPU-
// heavy, unlike the thumbnail queue's concurrency-4, and shouldn't compete
// with itself during a batch) and handles archiving verified results into
// the real library. See PLAN discussion: encode target is always local
// cache (paths.transcodingDir), never the library folder directly - keeps a
// slow/flaky network scan root out of the whole encode, and means nothing
// in the user's library is ever touched until an explicit, already-verified
// Archive action.
export class TranscodeWorker {
  private limiter = pLimit(1);

  constructor(
    private db: Database.Database,
    private paths: AppPaths,
    private logger: Logger,
    private scanner: ScannerService,
    private mediaTools: MediaToolCapabilities = new DeferredMediaToolCapabilities(),
  ) {}

  // Called once at server startup. A job stuck at 'transcoding' means the
  // process died mid-encode last time - it can't be trusted to still be
  // running (nothing here persists across a restart), so it's surfaced as a
  // failure requiring an explicit retry rather than silently retried forever
  // (a poison file could otherwise loop on every restart). Jobs that were
  // merely queued ('pending', never started) are safe to just resume.
  reconcileAndResume(): void {
    const interrupted = this.db
      .prepare(`SELECT media_id FROM video_transcode_jobs WHERE status = 'transcoding'`)
      .all() as { media_id: number }[];
    if (interrupted.length > 0) {
      this.db
        .prepare(
          `UPDATE video_transcode_jobs SET status = 'failed', error = 'Interrupted by a restart - retry', updated_at = ?
           WHERE status = 'transcoding'`,
        )
        .run(nowIso());
      this.logger.warn({ count: interrupted.length }, "Reconciled video transcode jobs interrupted by a restart");
    }

    const pending = this.db
      .prepare(`SELECT media_id, quality FROM video_transcode_jobs WHERE status = 'pending'`)
      .all() as { media_id: number; quality: string }[];
    for (const job of pending) {
      this.enqueue(job.media_id, job.quality as VideoTranscodeQuality);
    }
  }

  startTranscode(mediaIds: number[], quality: VideoTranscodeQuality): void {
    const upsert = this.db.prepare(
      `INSERT INTO video_transcode_jobs (media_id, status, quality, error, verified, created_at, updated_at)
       VALUES (?, 'pending', ?, NULL, 0, ?, ?)
       ON CONFLICT(media_id) DO UPDATE SET
         status = 'pending', quality = excluded.quality, error = NULL, verified = 0, updated_at = excluded.updated_at`,
    );
    for (const mediaId of mediaIds) {
      upsert.run(mediaId, quality, nowIso(), nowIso());
      this.enqueue(mediaId, quality);
    }
  }

  private enqueue(mediaId: number, quality: VideoTranscodeQuality): void {
    void this.limiter(() => this.runOne(mediaId, quality));
  }

  private markStatus(mediaId: number, status: string, error: string | null = null): void {
    this.db
      .prepare(`UPDATE video_transcode_jobs SET status = ?, error = ?, updated_at = ? WHERE media_id = ?`)
      .run(status, error, nowIso(), mediaId);
  }

  private async runOne(mediaId: number, quality: VideoTranscodeQuality): Promise<void> {
    const media = this.db
      .prepare(
        `SELECT id, scan_root_id, absolute_path, filename, duration_seconds, file_size
         FROM media WHERE id = ? AND status = 'active' AND media_type = 'video'`,
      )
      .get(mediaId) as MediaRowForTranscode | undefined;
    if (!media) {
      this.markStatus(mediaId, "failed", "Original file is no longer indexed");
      return;
    }

    // Fail fast if a file already sits at the eventual destination name -
    // never silently overwrite something unrelated. This check runs before
    // the (possibly long) encode rather than at Archive time, so Archive can
    // safely treat "destination exists" later as "our own prior copy" - see
    // archive() below.
    const destPath = path.join(path.dirname(media.absolute_path), replaceExtensionMp4(media.filename));
    try {
      await fs.access(destPath);
      this.markStatus(mediaId, "failed", "A file already exists at the destination filename - rename or remove it first");
      return;
    } catch {
      // Good - nothing in the way.
    }

    this.markStatus(mediaId, "transcoding");
    const cachePath = transcodingPathForMediaId(this.paths.transcodingDir, mediaId);
    const thumbPath = transcodingThumbnailPathForMediaId(this.paths.transcodingDir, mediaId);

    try {
      // Clean up any scrap left behind by a previous crashed attempt at this
      // same job before writing fresh output over it.
      await fs.rm(cachePath, { force: true });
      await fs.rm(thumbPath, { force: true });

      if (!this.mediaTools.video.available()) throw new Error("video tools capability is unavailable");
      const ok = await this.mediaTools.video.transcode(media.absolute_path, cachePath, quality);
      if (!ok) throw new Error("ffmpeg exited with an error");

      const outStat = await fs.stat(cachePath);
      const probe = await this.mediaTools.video.probe(cachePath);

      const tolerance =
        media.duration_seconds != null
          ? Math.max(DURATION_TOLERANCE_SECONDS, media.duration_seconds * DURATION_TOLERANCE_RATIO)
          : DURATION_TOLERANCE_SECONDS;
      const durationOk =
        probe?.durationSeconds != null &&
        media.duration_seconds != null &&
        Math.abs(probe.durationSeconds - media.duration_seconds) <= tolerance;
      const verified = outStat.size > 0 && probe?.codec != null && durationOk;

      // Best-effort - a missing preview thumbnail just means the row shows a
      // generic placeholder instead of a poster frame, never worth failing
      // an otherwise-good transcode over.
      if (verified) {
        try {
          const frame = await this.mediaTools.video.poster(cachePath);
          if (frame) await generateThumbnailFromBuffer(frame, thumbPath, null);
        } catch (err) {
          this.logger.warn({ err, mediaId }, "Could not generate a preview thumbnail for the transcoded video");
        }
      }

      this.db
        .prepare(
          `UPDATE video_transcode_jobs SET
            status = ?, verified = ?, error = ?,
            original_duration_seconds = ?, output_duration_seconds = ?,
            original_size_bytes = ?, output_size_bytes = ?, updated_at = ?
           WHERE media_id = ?`,
        )
        .run(
          verified ? "done" : "failed",
          verified ? 1 : 0,
          verified ? null : "Verification failed - the new file's duration or size didn't match the original closely enough",
          media.duration_seconds,
          probe?.durationSeconds ?? null,
          media.file_size,
          outStat.size,
          nowIso(),
          mediaId,
        );
      if (!verified) {
        await fs.rm(cachePath, { force: true });
        await fs.rm(thumbPath, { force: true }).catch(() => {});
      }
    } catch (err) {
      this.logger.error({ err, mediaId }, "Video transcode failed");
      await fs.rm(cachePath, { force: true }).catch(() => {});
      await fs.rm(thumbPath, { force: true }).catch(() => {});
      this.markStatus(mediaId, "failed", err instanceof Error ? err.message : "Transcode failed");
    }
  }

  // Copies the verified local-cache output into the real library folder,
  // then moves the original out - only for jobs already done+verified,
  // re-checked here server-side rather than trusting the client's request.
  // Both filesystem steps are individually idempotent (check-before-act) so
  // a retry after a partial failure (crash, disconnected share) resumes
  // rather than redoing work or erroring on its own prior progress.
  async archive(mediaIds: number[]): Promise<ArchiveTranscodedResultDto> {
    const archived: number[] = [];
    const failed: { mediaId: number; error: string }[] = [];
    const touchedRootIds = new Set<number>();

    for (const mediaId of mediaIds) {
      try {
        const job = this.db.prepare(`SELECT * FROM video_transcode_jobs WHERE media_id = ?`).get(mediaId) as
          | TranscodeJobRow
          | undefined;
        if (!job || job.status !== "done" || job.verified !== 1) {
          failed.push({ mediaId, error: "Not verified yet - transcode it first" });
          continue;
        }

        const media = this.db
          .prepare(`SELECT id, scan_root_id, absolute_path, filename FROM media WHERE id = ?`)
          .get(mediaId) as MediaRowForTranscode | undefined;
        if (!media) {
          failed.push({ mediaId, error: "Original is no longer indexed" });
          continue;
        }

        const root = this.db.prepare(`SELECT path FROM scan_roots WHERE id = ?`).get(media.scan_root_id) as
          | { path: string }
          | undefined;
        if (!root) {
          failed.push({ mediaId, error: "Scan root no longer exists" });
          continue;
        }

        const sourceDir = path.dirname(media.absolute_path);
        const destPath = path.join(sourceDir, replaceExtensionMp4(media.filename));
        const cachePath = transcodingPathForMediaId(this.paths.transcodingDir, mediaId);
        const archiveDir = path.join(root.path, ARCHIVE_FOLDER_NAME);

        // Step 1: land the new file at its real destination, if it isn't
        // already there (a retry of a previously-interrupted archive).
        const destExists = await fs
          .access(destPath)
          .then(() => true)
          .catch(() => false);
        if (!destExists) {
          const tmpDest = `${destPath}.copying`;
          await fs.copyFile(cachePath, tmpDest);
          await fs.rename(tmpDest, destPath);
        }

        // Step 2: move the original out of the way, if it hasn't been
        // already (same retry-safety as step 1).
        await fs.mkdir(archiveDir, { recursive: true });
        this.db.prepare(`INSERT OR IGNORE INTO ignored_paths (path) VALUES (?)`).run(archiveDir);
        const archivedOriginalPath = path.join(archiveDir, media.filename);
        try {
          await fs.rename(media.absolute_path, archivedOriginalPath);
        } catch (err) {
          if (!(err instanceof Error) || !("code" in err) || (err as NodeJS.ErrnoException).code !== "ENOENT") {
            throw err;
          }
          // ENOENT here means the original's already gone from its old spot -
          // a previous attempt got this far before failing later. Fine.
        }

        this.db
          .prepare(
            `UPDATE video_transcode_jobs SET status = 'archived', archived_at = ?, updated_at = ? WHERE media_id = ?`,
          )
          .run(nowIso(), nowIso(), mediaId);
        await fs.rm(cachePath, { force: true }).catch(() => {});
        await fs.rm(transcodingThumbnailPathForMediaId(this.paths.transcodingDir, mediaId), { force: true }).catch(() => {});

        archived.push(mediaId);
        touchedRootIds.add(media.scan_root_id);
      } catch (err) {
        this.logger.error({ err, mediaId }, "Failed to archive transcoded video");
        failed.push({ mediaId, error: err instanceof Error ? err.message : "Archive failed" });
      }
    }

    // Lets the existing scan pipeline do the rest: index the new .mp4 as a
    // normal new file, and mark the now-relocated original's row 'missing'
    // via the standard not-seen-this-run check - no special-cased indexing
    // logic needed here at all.
    for (const rootId of touchedRootIds) {
      this.scanner
        .runScan("manual", rootId)
        .catch((err) => this.logger.error({ err, rootId }, "Post-archive rescan failed"));
    }

    return { archived, failed };
  }
}
