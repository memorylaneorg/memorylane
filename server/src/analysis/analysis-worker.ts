import type Database from "better-sqlite3";
import type { Logger } from "pino";
import type { AnalysisStatusDto, AnalysisStatus } from "@memorylane/shared";
import { AnalysisRepo } from "./analysis-repo.js";
import { isMediaSourceVisible } from "../plugins/registry.js";
import type { Analyzer } from "./types.js";
import { ProviderUnavailableError, type AiProvider } from "../providers/types.js";
import { CapabilityUnavailableError } from "../capabilities/errors.js";

const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 300_000;

const EMPTY_COUNTS = (): Record<AnalysisStatus, number> => ({ pending: 0, running: 0, done: 0, failed: 0, unsupported: 0 });

// Drains media_analysis for every registered analyzer, in registration
// order. Polling loop rather than event-driven: work arrives in bulk (a scan,
// a startup backfill), and a 2s idle poll costs one indexed query.
// Yields entirely while a scan is running so thumbnail generation keeps its
// I/O budget (design doc §6.2).
export class AnalysisWorker {
  private repo: AnalysisRepo;
  private stopped = true;
  private loopPromise: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private needsEnqueue = false;
  private idleMs: number;
  private pausedMs: number;
  // Runs when every analyzer is drained (e.g. stack recompute, which wants
  // hashes finished first). Returns how much work it did; 0 = sleep.
  private onIdle: (() => number | Promise<number>) | undefined;
  private provider: AiProvider | null;
  // Per-analyzer exponential backoff while its provider is unreachable.
  private backoff = new Map<string, { until: number; delayMs: number }>();

  constructor(
    private db: Database.Database,
    private logger: Logger,
    private analyzers: Analyzer[],
    private isPaused: () => boolean,
    opts: { idleMs?: number; pausedMs?: number; onIdle?: () => number | Promise<number>; provider?: AiProvider | null } = {},
  ) {
    this.repo = new AnalysisRepo(db);
    this.idleMs = opts.idleMs ?? 2000;
    this.pausedMs = opts.pausedMs ?? 5000;
    this.onIdle = opts.onIdle;
    this.provider = opts.provider ?? null;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const reset = this.repo.resetRunning();
    if (reset > 0) this.logger.warn({ count: reset }, "Re-queued analysis rows interrupted by a restart");
    // Failures are usually environmental (unmounted volume, missing
    // permission, sidecar down) and a restart is when those get fixed - give
    // every failed row another round; a truly bad file fails again quickly.
    const retried = this.repo.retryFailed();
    if (retried > 0) this.logger.info({ count: retried }, "Re-queued previously failed analysis rows for another attempt");
    this.requeueStale();
    this.enqueueAll();
    this.loopPromise = this.loop();
  }

  // Re-queues every done row whose model_version no longer matches its
  // analyzer (startup, or after a model setting changed at runtime).
  requeueStale(): number {
    let total = 0;
    for (const a of this.analyzers) {
      const stale = this.repo.requeueStaleVersions(a);
      if (stale > 0) this.logger.info({ analyzer: a.key, version: a.version, count: stale }, "Re-queued analysis rows from an older version");
      total += stale;
    }
    if (total > 0) this.wake?.();
    return total;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.loopPromise;
    this.loopPromise = null;
  }

  // Called after a scan, and after a plugin install/enable/sync (see
  // plugin-routes.ts) - new media needs queue rows, the loop may be idle,
  // and (the plugin case) a provider an analyzer had backed off on may have
  // just become reachable. Clearing backoff here means "enable AI Runtime"
  // retries right away instead of waiting out a stale window (up to 5min)
  // from before it was available - a no-op if nothing was actually backed off,
  // and if the provider is still down the very next attempt just re-enters
  // backoff at the base delay.
  kick(): void {
    this.needsEnqueue = true;
    this.backoff.clear();
    this.wake?.();
  }

  enqueueAll(): number {
    let total = 0;
    for (const a of this.analyzers) total += this.repo.ensureQueued(a);
    if (total > 0) this.logger.info({ count: total }, "Queued media for analysis");
    return total;
  }

  retryFailed(analyzerKey?: string): number {
    const n = this.repo.retryFailed(analyzerKey);
    this.wake?.();
    return n;
  }

  // One pass: for each analyzer, claim and process one batch. Returns the
  // number of rows processed so callers (and tests) can tell idle from busy.
  async runOnce(): Promise<number> {
    let processed = 0;
    for (const a of this.analyzers) {
      if (this.stopped && this.loopPromise) break;
      if (a.isEnabled && !a.isEnabled()) continue;
      const backoff = this.backoff.get(a.key);
      if (backoff && backoff.until > Date.now()) continue;
      const rows = this.repo.claimBatch(a);
      if (rows.length === 0) continue;
      const runnable = rows.filter((row) => isMediaSourceVisible(this.db, row.id));
      this.repo.unclaim(a.key, rows.filter((row) => !isMediaSourceVisible(this.db, row.id)).map((row) => row.id));
      if (runnable.length === 0) continue;
      try {
        const outcomes = await a.run(runnable);
        const completed = outcomes.filter((outcome) => isMediaSourceVisible(this.db, outcome.mediaId));
        this.repo.unclaim(a.key, runnable.filter((row) => !isMediaSourceVisible(this.db, row.id)).map((row) => row.id));
        this.repo.complete(a.key, a.version, completed);
        const doneIds = completed.filter((outcome) => outcome.status === "done").map((outcome) => outcome.mediaId);
        if (doneIds.length > 0) {
          for (const dependent of this.analyzers) {
            if (dependent.requires?.includes(a.key)) this.repo.refreshDependentForIds(dependent, doneIds);
          }
        }
        if (backoff) {
          this.backoff.delete(a.key);
          this.logger.info({ analyzer: a.key }, "Provider reachable again - resuming");
        }
      } catch (err) {
        if (err instanceof ProviderUnavailableError || err instanceof CapabilityUnavailableError) {
          // Not the rows' fault: release them untouched and wait before
          // trying this analyzer again (5s, 10s, ... capped at 5min).
          this.repo.unclaim(a.key, runnable.map((r) => r.id));
          const delayMs = Math.min(backoff ? backoff.delayMs * 2 : BACKOFF_MIN_MS, BACKOFF_MAX_MS);
          this.backoff.set(a.key, { until: Date.now() + delayMs, delayMs });
          this.logger.warn({ analyzer: a.key, retryInMs: delayMs, reason: err.message }, "Provider unavailable - backing off");
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error({ err, analyzer: a.key, count: runnable.length }, "Analyzer batch failed");
        this.repo.unclaim(a.key, runnable.filter((row) => !isMediaSourceVisible(this.db, row.id)).map((row) => row.id));
        this.repo.complete(a.key, a.version, runnable.filter((row) => isMediaSourceVisible(this.db, row.id))
          .map((r) => ({ mediaId: r.id, status: "failed" as const, error: message })));
      }
      processed += runnable.length;
    }
    return processed;
  }

  getStatus(): AnalysisStatusDto {
    // Analyzers only check provider health when they have work, so an idle
    // server would report a stale "not connected" forever - refresh in the
    // background when the last check is old; the next poll shows the result.
    if (this.provider) {
      const info = this.provider.getInfo();
      if (!info.checkedAt || Date.now() - Date.parse(info.checkedAt) > 30_000) void this.provider.health(true).catch(() => undefined);
    }
    const errors = this.repo.lastErrors();
    const byKey = new Map(
      this.analyzers.map((a) => {
        const b = this.backoff.get(a.key);
        return [
          a.key,
          {
            key: a.key,
            version: a.version,
            counts: EMPTY_COUNTS(),
            backoffUntil: b && b.until > Date.now() ? new Date(b.until).toISOString() : null,
            enabled: a.isEnabled ? a.isEnabled() : true,
            lastError: errors.get(a.key) ?? null,
          },
        ];
      }),
    );
    for (const row of this.repo.counts()) {
      const entry = byKey.get(row.analyzer);
      if (entry) entry.counts[row.status] = row.count;
    }
    return { paused: this.isPaused(), analyzers: [...byKey.values()], provider: this.provider?.getInfo() ?? null };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      t.unref();
      this.wake = () => {
        clearTimeout(t);
        this.wake = null;
        resolve();
      };
    });
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      if (this.isPaused()) {
        await this.sleep(this.pausedMs);
        continue;
      }
      if (this.needsEnqueue) {
        this.needsEnqueue = false;
        this.enqueueAll();
      }
      let processed = 0;
      try {
        processed = await this.runOnce();
      } catch (err) {
        this.logger.error({ err }, "Analysis loop iteration failed");
      }
      if (processed === 0) {
        let idleWork = 0;
        try {
          idleWork = (await this.onIdle?.()) ?? 0;
        } catch (err) {
          this.logger.error({ err }, "Idle task failed");
        }
        if (idleWork === 0) await this.sleep(this.idleMs);
      }
    }
  }
}
