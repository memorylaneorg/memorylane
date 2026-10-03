import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { thumbnailPathForMediaId, previewPathForMediaId, type AppPaths } from '../config/paths.js';
import type { MediaRow } from '../api/mappers.js';
export class TvImageCache {
    private running = 0;
    private queue: Array<() => void> = [];
    failures = 0;
    constructor(private paths: AppPaths) { }
    async usage(): Promise<number> {
        const dir = path.join(this.paths.dataDir, 'tv-sharing-cache');
        try {
            return (await Promise.all((await fs.readdir(dir)).filter(n => n.endsWith('.jpg')).map(async (n) => (await fs.stat(path.join(dir, n)).catch(() => ({ size: 0 }))).size))).reduce((a, b) => a + b, 0);
        }
        catch {
            return 0;
        }
    }
    async get(media: MediaRow, profile: 'thumbnail' | 'display', quality: '1080p' | '4k', limitMiB: number, authorized = () => true): Promise<Buffer> {
        if (!authorized())
            throw Error('Sharing revoked');
        const dir = path.join(this.paths.dataDir, 'tv-sharing-cache');
        await fs.mkdir(dir, { recursive: true });
        const key = createHash('sha256').update(JSON.stringify([media.id, media.file_size, media.fs_modified_at, media.thumbnail_version, profile, quality, 1])).digest('hex');
        const file = path.join(dir, key + '.jpg');
        // Warm images never wait behind a slow original or conversion queue.
        try {
            const data = await fs.readFile(file);
            await fs.utimes(file, new Date(), new Date());
            return data;
        }
        catch { }
        if (this.running >= 2) {
            if (this.queue.length >= 14)
                throw Error('Image queue full');
            await new Promise<void>((resolve, reject) => {
                const ready = () => { clearTimeout(timer); resolve(); };
                const timer = setTimeout(() => { this.queue = this.queue.filter(f => f !== ready); reject(Error('Image queue timed out')); }, 20000);
                this.queue.push(ready);
            });
        }
        else
            this.running++;
        try {
            if (!authorized())
                throw Error('Sharing revoked');
            const stat = await fs.statfs(dir);
            if (stat.bavail * stat.bsize < 128 * 1024 * 1024)
                throw Error('Insufficient free space for TV image');
            const source = profile === 'thumbnail' ? thumbnailPathForMediaId(this.paths.thumbnailsDir, media.id) : media.media_type === 'raw' ? previewPathForMediaId(this.paths.previewsDir, media.id) : media.absolute_path;
            const [width, height] = profile === 'thumbnail' ? [320, 320] : quality === '4k' ? [3840, 2160] : [1920, 1080];
            const data = await this.convert(source, width, height, authorized);
            if (!authorized())
                throw Error('Sharing revoked');
            const temp = file + '.' + randomUUID();
            try {
                await fs.writeFile(temp, data);
                await fs.rename(temp, file);
            }
            finally {
                await fs.rm(temp, { force: true });
            }
            const entries = await Promise.all((await fs.readdir(dir)).filter(n => n.endsWith('.jpg')).map(async (n) => { const p = path.join(dir, n); try {
                return { p, ...await fs.stat(p) };
            }
            catch {
                return null;
            } }));
            const files = entries.filter((e): e is NonNullable<typeof e> => !!e).sort((a, b) => a.mtimeMs - b.mtimeMs);
            let total = files.reduce((s, e) => s + e.size, 0);
            for (const f of files) {
                if (total <= limitMiB * 1024 * 1024)
                    break;
                if (f.p === file)
                    continue;
                await fs.rm(f.p, { force: true });
                total -= f.size;
            }
            return data;
        }
        catch (error) {
            this.failures++;
            throw error;
        }
        finally {
            const next = this.queue.shift();
            if (next)
                next();
            else
                this.running--;
        }
    }
    private convert(source: string, width: number, height: number, authorized: () => boolean): Promise<Buffer> {
        const development = import.meta.url.endsWith('.ts');
        return new Promise((resolve, reject) => {
            const child = fork(new URL(development ? './image-worker.ts' : './image-worker.js', import.meta.url), [], { execArgv: development ? ['--import', 'tsx'] : [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
            let done = false;
            const finish = (error: Error | null, bytes?: Buffer) => {
                if (done)
                    return;
                done = true;
                clearTimeout(deadline);
                clearInterval(revocation);
                child.kill('SIGKILL');
                if (error)
                    reject(error);
                else
                    resolve(bytes!);
            };
            const deadline = setTimeout(() => finish(Error('Photo conversion timed out')), 15000);
            const revocation = setInterval(() => { if (!authorized())
                finish(Error('Sharing revoked')); }, 250);
            child.once('error', () => finish(Error('Photo worker unavailable')));
            child.once('exit', () => finish(Error('Photo worker exited')));
            child.once('message', (result: {
                bytes?: string;
                error?: string;
            }) => {
                if (result.error || typeof result.bytes !== 'string')
                    finish(Error('Could not convert photo'));
                else
                    finish(null, Buffer.from(result.bytes, 'base64'));
            });
            child.send({ source, width, height }, error => { if (error)
                finish(Error('Photo worker unavailable')); });
        });
    }
}
