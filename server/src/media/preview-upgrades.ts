import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fork, type ChildProcess } from 'node:child_process';
import { getDirectorySize } from '../util/dir-size.js';
import type Database from 'better-sqlite3';
import sharp from 'sharp';
import type { AppPaths } from '../config/paths.js';
import { previewPathForMediaId } from '../config/paths.js';
import type { MediaRow } from '../api/mappers.js';

export type UpgradeState = 'queued' | 'running' | 'ready' | 'limited' | 'failed';
export function previewTarget(width: number, height: number, orientation: number | null) {
  if (orientation && orientation >= 5) [width, height] = [height, width];
  const scale = Math.min(1, 3840 / width, 2160 / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}
const fingerprint = (m: MediaRow) => JSON.stringify([m.absolute_path, m.file_size, m.fs_modified_at, m.orientation, 1]);
export class PreviewUpgrades {
  private stopped = false;
  private child: ChildProcess | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private work: Promise<void> | null = null;
  constructor(private db: Database.Database, private paths: AppPaths, private renderer?: (job: {source:string;destination:string;orientation:number|null;width:number;height:number}) => Promise<UpgradeState>) {
    db.prepare("UPDATE preview_upgrades SET state='queued' WHERE state='running'").run();
    this.schedule();
  }
  enqueue(media: MediaRow, retry = false, priority = 0) {
    if (this.stopped || media.media_type !== 'raw' || media.status !== 'active') return;
    const old = this.db.prepare('SELECT fingerprint,state FROM preview_upgrades WHERE media_id=?').get(media.id) as {fingerprint:string;state:string}|undefined;
    if (old?.fingerprint === fingerprint(media) && !(retry && ['failed','limited'].includes(old.state))) {
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
    this.db.prepare("INSERT INTO preview_upgrades(media_id,fingerprint,state) VALUES (?,?,'queued') ON CONFLICT(media_id) DO UPDATE SET fingerprint=excluded.fingerprint,state='queued',updated_at=CURRENT_TIMESTAMP").run(media.id, fingerprint(media));
    this.db.prepare('UPDATE preview_upgrades SET priority=? WHERE media_id=?').run(priority,media.id);
    this.schedule();
  }
  status(id: number) {
    return (this.db.prepare('SELECT state FROM preview_upgrades WHERE media_id=?').get(id) as {state:UpgradeState}|undefined)?.state ?? null;
  }
  summary() {
    const result = { queued: 0, running: 0, ready: 0, limited: 0, failed: 0 };
    for (const row of this.db.prepare('SELECT state,COUNT(*) n FROM preview_upgrades GROUP BY state').all() as {state:UpgradeState;n:number}[]) result[row.state] = row.n;
    return result;
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
    const media = this.db.prepare("SELECT media.* FROM preview_upgrades j JOIN media ON media.id=j.media_id JOIN scan_roots r ON r.id=media.scan_root_id WHERE j.state='queued' AND media.status='active' AND r.enabled=1 ORDER BY j.priority DESC,j.updated_at,media.id LIMIT 1").get() as MediaRow | undefined;
    if (!media) return;
    const stamp = fingerprint(media);
    const dest = previewPathForMediaId(this.paths.previewsDir, media.id);
    const temp = dest + '.upgrade.jpg';
    let state: UpgradeState = 'failed';
    this.db.prepare("UPDATE preview_upgrades SET state='running',fingerprint=? WHERE media_id=?").run(stamp, media.id);
    try {
      const stat = await fs.statfs(this.paths.dataDir);
      if (stat.bavail * stat.bsize < 512 * 1024 * 1024) throw Error('Insufficient disk space');
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.mkdir(path.join(this.paths.dataDir, "tmp"), { recursive: true });
      const target = previewTarget(media.width || 3840, media.height || 2160, media.orientation);
      const old = await sharp(dest).metadata().catch(() => null);
      if (old && (old.width ?? 0) >= target.width && (old.height ?? 0) >= target.height) { state = 'ready'; return; }
      state = await (this.renderer ?? this.convert.bind(this))({source:media.absolute_path,destination:temp,orientation:media.orientation,...target});
      if (this.stopped) return;
      const current = this.db.prepare("SELECT * FROM media WHERE id=? AND status='active'").get(media.id) as MediaRow|undefined;
      if (!current || fingerprint(current) !== stamp) { state = 'queued'; return; }
      if (current.thumbnail_version !== media.thumbnail_version) { state = 'queued'; return; }
      if (state !== 'failed') {
        const next = await sharp(temp).metadata();
        if ((next.width ?? 0) * (next.height ?? 0) > (old?.width ?? 0) * (old?.height ?? 0)) {
          // Bound background-generated previews while preserving existing files.
          const usage = await getDirectorySize(this.paths.previewsDir);
          if (usage > 4 * 1024 ** 3) throw Error('Preview storage budget reached');
          await fs.rename(temp, dest);
          this.db.prepare('UPDATE media SET thumbnail_version=thumbnail_version+1 WHERE id=?').run(media.id);
        }
      }
    } catch { state = 'failed'; }
    finally {
      await fs.rm(temp, {force:true}).catch(() => {});
      await fs.rm(temp + '.decoded.jpg', {force:true}).catch(() => {});
      if (!this.stopped) this.db.prepare('UPDATE preview_upgrades SET state=?,updated_at=CURRENT_TIMESTAMP WHERE media_id=? AND fingerprint=?').run(state, media.id, stamp);
    }
  }
  private convert(job: object): Promise<UpgradeState> {
    return new Promise(resolve => {
      const js = new URL('./preview-upgrade-worker.js', import.meta.url);
      const worker = existsSync(js) ? js : new URL('./preview-upgrade-worker.ts', import.meta.url);
      const child = fork(worker, [], { env: {...process.env, TMPDIR:path.join(this.paths.dataDir,'tmp'), TMP:path.join(this.paths.dataDir,'tmp'), TEMP:path.join(this.paths.dataDir,'tmp')}, execArgv: existsSync(js) ? [] : ['--import','tsx'], detached: process.platform !== 'win32', stdio:['ignore','ignore','ignore','ipc'] });
      this.child = child;
      try { if (child.pid) os.setPriority(child.pid, 10); } catch {}
      let state: UpgradeState = 'failed';
      const timer = setTimeout(() => this.kill(), 60000);
      child.on('message', message => { const value = (message as {state?:string}).state; if (value === 'ready' || value === 'limited') state = value; });
      const done = () => { clearTimeout(timer); if (this.child === child) this.child = null; resolve(state); };
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
