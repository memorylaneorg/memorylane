import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

const MiB = 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * MiB;
const DISK_RESERVE_BYTES = 512 * MiB;
const SETTINGS_KEY = "applePhotoPreparation";
type State = "queued" | "running" | "ready" | "failed" | "blocked";
interface Settings { paused: boolean; cacheMiB: number }
export interface ApplePhotoPreparationStatus extends Settings {
  usageBytes: number;
  queued: number;
  running: number;
  ready: number;
  failed: number;
  blocked: number;
  lastError: string | null;
}

/** Explicit selection intents only: this worker never discovers favorites or collections. */
export class ApplePhotoPreparation {
  private readonly cacheDir: string;
  private settings: Settings = { paused: false, cacheMiB: 2048 };
  private readonly timer: ReturnType<typeof setInterval>;
  private active: { id: number; controller: AbortController } | null = null;
  private work: Promise<void> | null = null;
  private closed = false;
  private queueCursor = 0;
  private movePauses = 0;

  constructor(
    private readonly db: Database.Database,
    paths: { dataDir: string },
    private readonly download: (mediaId: number, signal: AbortSignal) => Promise<Buffer>,
    private readonly allowed: (mediaId: number) => boolean,
    private readonly enabled: (mediaId: number) => boolean = () => true,
  ) {
    this.cacheDir = path.join(paths.dataDir, "apple-photos-cache");
    fs.mkdirSync(this.cacheDir, { recursive: true });
    const stored = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(SETTINGS_KEY) as { value: string } | undefined;
    try {
      const value = JSON.parse(stored?.value ?? "null");
      if (typeof value?.paused === "boolean") this.settings.paused = value.paused;
      if (Number.isInteger(value?.cacheMiB) && value.cacheMiB >= 1) this.settings.cacheMiB = value.cacheMiB;
    } catch { /* Malformed settings use safe defaults. */ }
    this.db.prepare("UPDATE apple_photo_preparation SET state = 'queued', error = NULL WHERE state = 'running'").run();
    // Only unfinished temporary output is disposable after a process interruption.
    for (const name of fs.readdirSync(this.cacheDir)) {
      if (/^\d+\.jpg\.tmp$/.test(name)) fs.rmSync(path.join(this.cacheDir, name), { force: true });
    }
    this.timer = setInterval(() => this.tick(), 250);
    this.timer.unref();
  }

  enqueue(ids: number[]): number { return this.add(ids, false); }
  retry(ids: number[]): number { return this.add(ids, true); }

  private add(ids: number[], retry: boolean): number {
    if (this.closed) return 0;
    if (ids.length > 1000 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error("Preparation requires at most 1000 positive media IDs");
    const insert = this.db.prepare(`INSERT INTO apple_photo_preparation (media_id, state) VALUES (?, 'queued') ON CONFLICT(media_id) DO NOTHING`);
    const reset = this.db.prepare(`UPDATE apple_photo_preparation SET state = 'queued', error = NULL, updated_at = CURRENT_TIMESTAMP WHERE media_id = ? AND state IN ('failed', 'blocked')`);
    return this.db.transaction(() => {
      let count = 0;
      for (const id of new Set(ids)) {
        if (!this.allowed(id)) continue;
        // A stale selection may refer to a media row removed by source cleanup.
        if (!this.db.prepare("SELECT 1 FROM media WHERE id = ?").get(id)) continue;
        count += insert.run(id).changes;
        if (retry) count += reset.run(id).changes;
      }
      return count;
    })();
  }

  configure(patch: Partial<Settings>): ApplePhotoPreparationStatus {
    if (patch.paused !== undefined && typeof patch.paused !== "boolean") throw new Error("Invalid paused setting");
    if (patch.cacheMiB !== undefined && (!Number.isSafeInteger(patch.cacheMiB) || patch.cacheMiB < 1)) throw new Error("Cache budget must be a positive integer MiB value");
    const previousBudget = this.settings.cacheMiB;
    this.settings = { ...this.settings, ...patch };
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(SETTINGS_KEY, JSON.stringify(this.settings));
    if (this.settings.paused) this.active?.controller.abort();
    if (this.settings.cacheMiB > previousBudget) {
      this.db.prepare("UPDATE apple_photo_preparation SET state = 'queued', error = NULL WHERE state = 'blocked' AND error = 'cache-budget'").run();
    }
    return this.status();
  }

  status(): ApplePhotoPreparationStatus {
    const counts: Record<State, number> = { queued: 0, running: 0, ready: 0, failed: 0, blocked: 0 };
    let lastError: string | null = null;
    // Retain history and cached bytes, but report work only for current explicit selections.
    // Disabled sources remain selected so users can see the work that resumes on enable.
    for (const row of this.db.prepare("SELECT media_id, state, error FROM apple_photo_preparation ORDER BY updated_at DESC, media_id DESC").iterate() as Iterable<{ media_id: number; state: State; error: string | null }>) {
      if (!this.allowed(row.media_id)) continue;
      counts[row.state]++;
      if (lastError === null && row.error !== null) lastError = row.error;
    }
    return { ...this.settings, usageBytes: this.usageBytes(), ...counts, lastError };
  }

  readPath(mediaId: number): string | null {
    if (!Number.isSafeInteger(mediaId) || mediaId <= 0 || !this.allowed(mediaId) || !this.enabled(mediaId)) return null;
    const file = path.join(this.cacheDir, `${mediaId}.jpg`);
    return fs.existsSync(file) ? file : null;
  }

  async clear(): Promise<ApplePhotoPreparationStatus> {
    this.configure({ paused: true });
    await this.work;
    // Do not remove any other core cache, thumbnail, or original.
    for (const name of fs.readdirSync(this.cacheDir)) {
      if (!/^\d+\.jpg(?:\.tmp)?$/.test(name)) continue;
      fs.rmSync(path.join(this.cacheDir, name), { force: true });
      if (/^\d+\.jpg$/.test(name)) this.bumpThumbnailVersion(Number(name.slice(0, -4)));
    }
    this.db.prepare("DELETE FROM apple_photo_preparation").run();
    return this.status();
  }

  async pauseForMove(): Promise<() => void> {
    this.movePauses++;
    this.active?.controller.abort();
    await this.work;
    let released = false;
    return () => { if (!released) { released = true; this.movePauses--; } };
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    this.active?.controller.abort();
    await this.work;
  }

  private usageBytes(): number {
    let total = 0;
    for (const name of fs.readdirSync(this.cacheDir)) {
      if (!/^\d+\.jpg$/.test(name)) continue;
      try { total += fs.statSync(path.join(this.cacheDir, name)).size; } catch { /* Concurrent cache removal. */ }
    }
    return total;
  }

  private setState(id: number, state: State, error: string | null = null, bytes = 0): void {
    this.db.prepare("UPDATE apple_photo_preparation SET state = ?, error = ?, bytes = ?, updated_at = CURRENT_TIMESTAMP WHERE media_id = ?").run(state, error, bytes, id);
  }

  private tick(): void {
    if (this.closed) return;
    if (this.active) {
      if (this.settings.paused || !this.allowed(this.active.id) || !this.enabled(this.active.id)) this.active.controller.abort();
      return;
    }
    if (this.settings.paused || this.movePauses > 0 || this.work) return;
    // Read bounded pages. Do not hold a SQLite iterator open while writing job states.
    const rows = this.db.prepare("SELECT media_id FROM apple_photo_preparation WHERE state = 'queued' AND media_id > ? ORDER BY media_id LIMIT 1000").all(this.queueCursor) as Array<{ media_id: number }>;
    if (rows.length === 0) this.queueCursor = 0;
    for (const row of rows) {
      const id = row.media_id;
      this.queueCursor = id;
      if (!this.allowed(id)) {
        this.db.prepare("DELETE FROM apple_photo_preparation WHERE media_id = ?").run(id);
        continue;
      }
      if (!this.enabled(id)) continue;
      this.work = this.prepare(id).finally(() => { this.work = null; });
      break;
    }
  }

  private bumpThumbnailVersion(id: number): void {
    this.db.prepare("UPDATE media SET thumbnail_version = COALESCE(thumbnail_version, 1) + 1 WHERE id = ?").run(id);
  }

  private markReady(id: number, bytes: number): void {
    this.db.transaction(() => {
      this.setState(id, "ready", null, bytes);
      this.bumpThumbnailVersion(id);
    })();
  }

  private async prepare(id: number): Promise<void> {
    const controller = new AbortController();
    this.active = { id, controller };
    const file = path.join(this.cacheDir, `${id}.jpg`);
    const temporary = `${file}.tmp`;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let onAbort: (() => void) | undefined;
    try {
      // Reuse completed output after a crash between rename and the state update.
      if (fs.existsSync(file)) {
        this.markReady(id, fs.statSync(file).size);
        return;
      }
      if (this.usageBytes() + MAX_IMAGE_BYTES > this.settings.cacheMiB * MiB) {
        this.setState(id, "blocked", "cache-budget"); return;
      }
      const disk = fs.statfsSync(this.cacheDir);
      if (disk.bavail * disk.bsize < DISK_RESERVE_BYTES + MAX_IMAGE_BYTES) {
        this.setState(id, "blocked", "disk-reserve"); return;
      }
      this.setState(id, "running");
      timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 120_000);
      timeout.unref();
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error(timedOut ? "download-timeout" : "cancelled"));
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      const bytes = await Promise.race([this.download(id, controller.signal), aborted]);
      if (controller.signal.aborted || this.closed || this.settings.paused || !this.allowed(id) || !this.enabled(id)) throw new Error("cancelled");
      if (bytes.length > MAX_IMAGE_BYTES || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("invalid-jpeg-output");
      const remaining = fs.statfsSync(this.cacheDir);
      if (remaining.bavail * remaining.bsize < DISK_RESERVE_BYTES + bytes.length) { this.setState(id, "blocked", "disk-reserve"); return; }
      if (this.usageBytes() + bytes.length > this.settings.cacheMiB * MiB) { this.setState(id, "blocked", "cache-budget"); return; }
      fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, file);
      this.markReady(id, bytes.length);
    } catch (error) {
      if (!this.allowed(id)) this.db.prepare("DELETE FROM apple_photo_preparation WHERE media_id = ?").run(id);
      else if (!timedOut && (controller.signal.aborted || this.closed || this.settings.paused || !this.enabled(id))) this.setState(id, "queued");
      else this.setState(id, "failed", timedOut ? "download-timeout" : error instanceof Error ? error.message.slice(0, 300) : "download-failed");
    } finally {
      if (timeout) clearTimeout(timeout);
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      fs.rmSync(temporary, { force: true });
      this.active = null;
    }
  }
}
