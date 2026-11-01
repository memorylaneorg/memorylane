import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fork, type ChildProcess } from 'node:child_process';
import { getDirectorySize, getFileSize } from '../util/dir-size.js';
import type Database from 'better-sqlite3';
import sharp from 'sharp';
import type { AppPaths } from '../config/paths.js';
import { previewPathForMediaId } from '../config/paths.js';
import type { MediaRow } from '../api/mappers.js';

export type PreviewScope = { sql: string; params: unknown[] };
export type UpgradeState = 'queued' | 'running' | 'ready' | 'limited' | 'failed' | 'blocked';
export const DEFAULT_PREVIEW_MIB = 4096;
export const MAX_PREVIEW_MIB = 1048576;
const MiB = 1024 ** 2;
const DISK_RESERVE = 512 * MiB;
type FailureCode = 'budget' | 'disk' | 'source' | 'decode' | 'timeout' | 'worker' | 'io';
class UpgradeError extends Error {
  constructor(readonly code: FailureCode, message: string) { super(message); }
}
export function suggestedPreviewMiB(usage: number, limitMiB: number, remaining: number, average: number, free: number, budgetBlocked = false) {
  const estimate = Math.ceil((usage + Math.max(1, remaining) * Math.max(MiB, average) * 1.25) / (1024 * MiB)) * 1024;
  if (!budgetBlocked && estimate <= limitMiB && usage < limitMiB * MiB) return null;
  const affordable = Math.floor((usage + Math.max(0, free - DISK_RESERVE)) / MiB);
  const suggestion = Math.min(MAX_PREVIEW_MIB, affordable, Math.max(limitMiB + 1024, estimate));
  return suggestion > limitMiB && suggestion * MiB > usage ? suggestion : null;
}
export function previewTarget(width: number, height: number, orientation: number | null) {
  if (orientation && orientation >= 5) [width, height] = [height, width];
  const scale = Math.min(1, 3840 / width, 2160 / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}
const fingerprint = (m: MediaRow) => JSON.stringify([m.absolute_path, m.file_size, m.fs_modified_at, m.orientation, 1]);
export class PreviewUpgrades {
  private stopped = false;
  private usageCache: {at:number;value:Promise<number>} | null = null;
  private usage() {
    if (!this.usageCache || Date.now()-this.usageCache.at > 30000) this.usageCache = {at:Date.now(),value:getDirectorySize(this.paths.previewsDir)};
    return this.usageCache.value;
  }
  private eligible: (id: number) => boolean = () => true;
  setEligibility(check: (id: number) => boolean) { this.eligible = check; }
  private enabled: () => boolean = () => true;
  private active: {id:number; cancelled:boolean} | null = null;
  setEnabled(check: () => boolean) { this.enabled = check; this.reconcile(); }
  isEligible(id: number) { return this.enabled() && this.eligible(id); }
  reconcile() {
    if (this.active && (!this.enabled() || !this.eligible(this.active.id))) {
      this.active.cancelled = true;
      this.kill();
    }
  }
  private child: ChildProcess | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private work: Promise<void> | null = null;
  constructor(private db: Database.Database, private paths: AppPaths, private renderer?: (job: {source:string;destination:string;orientation:number|null;width:number;height:number}) => Promise<UpgradeState>) {
    db.prepare("UPDATE preview_upgrades SET state='queued' WHERE state='running'").run();
    this.schedule();
  }
  enqueue(media: MediaRow, retry = false, priority = 0) {
    if (this.stopped || !this.isEligible(media.id) || media.media_type !== 'raw' || media.status !== 'active') return;
    const old = this.db.prepare('SELECT fingerprint,state FROM preview_upgrades WHERE media_id=?').get(media.id) as {fingerprint:string;state:string}|undefined;
    if (old?.fingerprint === fingerprint(media) && !(retry && ['failed','limited','blocked'].includes(old.state))) {
      if (priority) this.db.prepare("UPDATE preview_upgrades SET priority=MAX(priority,?) WHERE media_id=? AND state='queued'").run(priority,media.id);
      return;
    }
    this.db.prepare("DELETE FROM preview_upgrades WHERE state='queued' AND media_id NOT IN (SELECT media.id FROM media JOIN scan_roots r ON r.id=media.scan_root_id WHERE media.status='active' AND r.enabled=1)").run();
    const pending = this.db.prepare("SELECT COUNT(*) n FROM preview_upgrades WHERE state IN ('queued','running')").get() as {n:number};
    if (pending.n >= 1000) {
      const displaced = this.db.prepare("SELECT media_id FROM preview_upgrades WHERE state='queued' AND priority<? ORDER BY priority,updated_at LIMIT 1").get(priority) as {media_id:number}|undefined;
      if (!displaced) return;
      this.db.prepare('DELETE FROM preview_upgrades WHERE media_id=?').run(displaced.media_id);
    }
    this.db.prepare("INSERT INTO preview_upgrades(media_id,fingerprint,state) VALUES (?,?,'queued') ON CONFLICT(media_id) DO UPDATE SET fingerprint=excluded.fingerprint,state='queued',error_code=NULL,error_message=NULL,retry_requested=0,updated_at=CURRENT_TIMESTAMP").run(media.id, fingerprint(media));
    this.db.prepare('UPDATE preview_upgrades SET priority=? WHERE media_id=?').run(priority,media.id);
    this.schedule();
  }
  status(id: number) {
    return (this.db.prepare('SELECT state FROM preview_upgrades WHERE media_id=?').get(id) as {state:UpgradeState}|undefined)?.state ?? null;
  }
  summary(scope?: PreviewScope) {
    const result = { queued: 0, running: 0, ready: 0, limited: 0, failed: 0, blocked: 0 };
    // Include eligible RAWs not yet admitted to the bounded worker queue.
    const sql = scope
      ? `SELECT COALESCE(j.state,'queued') state,COUNT(*) n FROM (${scope.sql}) selected LEFT JOIN preview_upgrades j ON j.media_id=selected.id AND j.fingerprint=selected.fingerprint GROUP BY COALESCE(j.state,'queued')`
      : 'SELECT state,COUNT(*) n FROM preview_upgrades GROUP BY state';
    for (const row of this.db.prepare(sql).all(...(scope?.params ?? [])) as {state:UpgradeState;n:number}[]) result[row.state] = row.n;
    return result;
  }
  budgetMiB() {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='tvSharing'").get() as {value:string}|undefined;
    try {
      const value = JSON.parse(row?.value ?? '{}').previewCacheMiB;
      return Number.isInteger(value) && value >= 1024 && value <= MAX_PREVIEW_MIB ? value : DEFAULT_PREVIEW_MIB;
    } catch { return DEFAULT_PREVIEW_MIB; }
  }
  async storage(remaining: number, scope?: PreviewScope) {
    const usageBytes = await this.usage();
    const stat = await fs.statfs(this.paths.dataDir);
    const freeBytes = stat.bavail * stat.bsize;
    const limitMiB = this.budgetMiB();
    const sample = this.db.prepare("SELECT AVG(output_bytes) average FROM preview_upgrades WHERE output_bytes>0 AND state IN ('ready','limited')").get() as {average:number|null};
    const scopedJobs = scope
      ? `preview_upgrades j JOIN (${scope.sql}) selected ON selected.id=j.media_id AND selected.fingerprint=j.fingerprint`
      : 'preview_upgrades';
    const failures = this.db.prepare(`SELECT COALESCE(error_code,'unknown') code,COUNT(*) count FROM ${scopedJobs} WHERE state IN ('failed','blocked') AND retry_requested=0 GROUP BY error_code`).all(...(scope?.params ?? [])) as {code:string;count:number}[];
    const retryPending = (this.db.prepare(`SELECT COUNT(*) n FROM ${scopedJobs} WHERE retry_requested=1`).get(...(scope?.params ?? [])) as {n:number}).n;
    return {usageBytes,limitMiB,freeBytes,remaining,failures,retryPending,
      suggestedMiB:suggestedPreviewMiB(usageBytes,limitMiB,remaining,sample.average ?? 8*MiB,freeBytes,failures.some(f=>f.code==='budget'))};
  }
  private schedule() {
    if (this.stopped || this.timer || this.work) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.work = this.next().finally(() => { this.work = null; if (!this.stopped) this.schedule(); });
    }, 1000);
    this.timer.unref();
  }
  private async next() {
    if (!this.enabled()) return;
    const media = this.db.prepare("SELECT media.* FROM preview_upgrades j JOIN media ON media.id=j.media_id JOIN scan_roots r ON r.id=media.scan_root_id WHERE j.state='queued' AND media.status='active' AND r.enabled=1 ORDER BY j.priority DESC,j.updated_at,media.id LIMIT 1").get() as MediaRow | undefined;
    if (!media) return;
    if (!this.eligible(media.id)) {
      this.db.prepare('DELETE FROM preview_upgrades WHERE media_id=?').run(media.id);
      return;
    }
    const active = this.active = {id:media.id, cancelled:false};
    const monitor = setInterval(() => this.reconcile(), 250);
    monitor.unref();
    const interrupted = () => { this.reconcile(); return this.stopped || active.cancelled; };
    const stamp = fingerprint(media);
    const dest = previewPathForMediaId(this.paths.previewsDir, media.id);
    const temp = dest + '.upgrade.jpg';
    let state: UpgradeState = 'failed';
    let errorCode: FailureCode | null = null, errorMessage: string | null = null, outputBytes: number | null = null;
    this.db.prepare("UPDATE preview_upgrades SET state='running',fingerprint=? WHERE media_id=?").run(stamp, media.id);
    try {
      const stat = await fs.statfs(this.paths.dataDir);
      if (stat.bavail * stat.bsize < DISK_RESERVE) throw new UpgradeError('disk', 'Insufficient disk space');
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.mkdir(path.join(this.paths.dataDir, "tmp"), { recursive: true });
      const target = previewTarget(media.width || 3840, media.height || 2160, media.orientation);
      const old = await sharp(dest).metadata().catch(() => null);
      if (old && (old.width ?? 0) >= target.width && (old.height ?? 0) >= target.height) { state = 'ready'; outputBytes = await getFileSize(dest); return; }
      if (await this.usage() >= this.budgetMiB() * MiB) throw new UpgradeError('budget', 'RAW preview storage limit reached');
      if (interrupted()) return;
      state = await (this.renderer ?? this.convert.bind(this))({source:media.absolute_path,destination:temp,orientation:media.orientation,...target});
      if (state === 'failed') throw new UpgradeError('decode', 'No usable preview');
      if (interrupted()) return;
      if (!this.eligible(media.id)) { this.db.prepare('DELETE FROM preview_upgrades WHERE media_id=?').run(media.id); return; }
      const current = this.db.prepare("SELECT * FROM media WHERE id=? AND status='active'").get(media.id) as MediaRow|undefined;
      if (!current || fingerprint(current) !== stamp) { state = 'queued'; return; }
      if (current.thumbnail_version !== media.thumbnail_version) { state = 'queued'; return; }
      if (state === 'ready' || state === 'limited') {
        const next = await sharp(temp).metadata();
        if ((next.width ?? 0) * (next.height ?? 0) > (old?.width ?? 0) * (old?.height ?? 0)) {
          // Bound background-generated previews while preserving existing files.
          const usage = await getDirectorySize(this.paths.previewsDir);
          const replacementBytes = await getFileSize(temp);
          // The directory scan includes our temporary output; subtract the old file
          // to measure the final size after atomic replacement.
          if (usage - await getFileSize(dest) > this.budgetMiB() * MiB) throw new UpgradeError('budget', 'RAW preview storage limit reached');
          const available = await fs.statfs(this.paths.dataDir);
          if (available.bavail * available.bsize < DISK_RESERVE) throw new UpgradeError('disk', 'Insufficient disk space');
          if (interrupted()) return;
          outputBytes = replacementBytes;
          await fs.rename(temp, dest);
          this.usageCache = null;
          this.db.prepare('UPDATE media SET thumbnail_version=thumbnail_version+1 WHERE id=?').run(media.id);
        }
      }
      outputBytes ??= await getFileSize(dest);
    } catch (error) {
      errorCode = error instanceof UpgradeError ? error.code : 'io';
      errorMessage = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
      state = errorCode === 'budget' || errorCode === 'disk' ? 'blocked' : 'failed';
    }
    finally {
      clearInterval(monitor);
      this.active = null;
      await fs.rm(temp, {force:true}).catch(() => {});
      await fs.rm(temp + '.decoded.jpg', {force:true}).catch(() => {});
      if (active.cancelled) {
        state = 'queued'; errorCode = null; errorMessage = null; outputBytes = null;
      }
      // A pause retains work; removal from the share discards only unfinished work.
      if (this.enabled() && !this.eligible(media.id)) this.db.prepare('DELETE FROM preview_upgrades WHERE media_id=?').run(media.id);
      if (!this.stopped) this.db.prepare('UPDATE preview_upgrades SET state=?,error_code=?,error_message=?,output_bytes=COALESCE(?,output_bytes),updated_at=CURRENT_TIMESTAMP WHERE media_id=? AND fingerprint=?').run(state, errorCode, errorMessage, outputBytes, media.id, stamp);
    }
  }
  private convert(job: object): Promise<UpgradeState> {
    return new Promise((resolve, reject) => {
      const js = new URL('./preview-upgrade-worker.js', import.meta.url);
      const worker = existsSync(js) ? js : new URL('./preview-upgrade-worker.ts', import.meta.url);
      const child = fork(worker, [], { env: {...process.env, TMPDIR:path.join(this.paths.dataDir,'tmp'), TMP:path.join(this.paths.dataDir,'tmp'), TEMP:path.join(this.paths.dataDir,'tmp')}, execArgv: existsSync(js) ? [] : ['--import','tsx'], detached: process.platform !== 'win32', stdio:['ignore','ignore','ignore','ipc'] });
      this.child = child;
      try { if (child.pid) os.setPriority(child.pid, 10); } catch {}
      let state: UpgradeState = 'failed';
      let failure: UpgradeError | null = null;
      const timer = setTimeout(() => { failure = new UpgradeError('timeout', 'Preview conversion exceeded 60 seconds'); this.kill(); }, 60000);
      child.on('message', message => {
        const result = message as {state?:string;errorCode?:string;errorMessage?:string};
        if (result.state === 'ready' || result.state === 'limited') state = result.state;
        if (result.state === 'failed') failure = new UpgradeError(result.errorCode === 'source' ? 'source' : 'decode', result.errorMessage ?? 'No usable preview');
      });
      const done = () => { clearTimeout(timer); if (this.child === child) this.child = null; if (failure) reject(failure); else if (state === 'failed') reject(new UpgradeError('worker', 'Preview worker exited without a result')); else resolve(state); };
      child.once('error', done); child.once('exit', done);
      child.send(job);
    });
  }
  private kill() {
    if (!this.child?.pid) return;
    try { if (process.platform !== 'win32') process.kill(-this.child.pid, 'SIGKILL'); else this.child.kill('SIGKILL'); } catch {}
  }
  async close() { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.kill(); await this.work; }
}
