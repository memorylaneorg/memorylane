import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { TvImageCache } from '../../src/tv-sharing/images.js';
import type { AppPaths } from '../../src/config/paths.js';
import type { MediaRow } from '../../src/api/mappers.js';
it('orients and strips metadata, caches JPEGs, invalidates source revisions', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tv-images-'));
    try {
        const original = path.join(dir, 'image.jpg');
        await sharp({ create: { width: 2400, height: 1200, channels: 3, background: 'red' } }).jpeg().withMetadata({ orientation: 6 }).toFile(original);
        const row = { id: 1, absolute_path: original, media_type: 'image', file_size: 123, fs_modified_at: '2020', thumbnail_version: 1 } as MediaRow;
        const cache = new TvImageCache({ dataDir: dir } as AppPaths);
        const first = await cache.get(row, 'display', '1080p', 64), meta = await sharp(first).metadata();
        expect(meta.width).toBe(540);
        expect(meta.height).toBe(1080);
        expect(meta.exif).toBeUndefined();
        expect(meta.orientation).toBeUndefined();
        await fs.rm(original);
        expect(await cache.get(row, 'display', '1080p', 64)).toEqual(first);
        await expect(cache.get({ ...row, fs_modified_at: '2021' }, 'display', '1080p', 64)).rejects.toThrow();
    }
    finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
it.skipIf(process.platform === 'win32')('serves cached images during stalled reads and cancels revoked workers', async () => {
    const { execFileSync } = await import('node:child_process');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tv-stall-'));
    try {
        const original = path.join(dir, 'warm.jpg');
        await sharp({ create: { width: 32, height: 32, channels: 3, background: 'blue' } }).jpeg().toFile(original);
        const cache = new TvImageCache({ dataDir: dir } as AppPaths);
        const row = { id: 1, absolute_path: original, media_type: 'image', file_size: 1, fs_modified_at: '1' } as MediaRow;
        const warm = await cache.get(row, 'display', '1080p', 64);
        const fifo = path.join(dir, 'offline.jpg');
        execFileSync('mkfifo', [fifo]);
        let allowed = true;
        const blocked = [2, 3].map(id => cache.get({ ...row, id, absolute_path: fifo }, 'display', '1080p', 64, () => allowed).catch(e => e));
        await new Promise(resolve => setTimeout(resolve, 300));
        expect(await cache.get(row, 'display', '1080p', 64)).toEqual(warm);
        allowed = false;
        for (const result of await Promise.all(blocked))
            expect(result.message).toMatch(/revoked/);
        expect(await cache.get({ ...row, id: 4 }, 'display', '1080p', 64)).toEqual(warm);
    }
    finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
it('renders indexed BMP photos through the core decoder', async () => {
    const bmp = (await import('bmp-js')).default;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tv-bmp-'));
    try {
        const original = path.join(dir, 'photo.bmp');
        await fs.writeFile(original, bmp.encode({ data: Buffer.alloc(16 * 16 * 4, 255), width: 16, height: 16 }).data);
        const row = { id: 1, absolute_path: original, media_type: 'image', file_size: 1, fs_modified_at: '1' } as MediaRow;
        const bytes = await new TvImageCache({ dataDir: dir } as AppPaths).get(row, 'display', '1080p', 64);
        expect((await sharp(bytes).metadata()).format).toBe('jpeg');
    }
    finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
it.skipIf(process.platform === 'win32')('terminates a stalled worker when its parent disconnects', async () => {
    const { fork, execFileSync } = await import('node:child_process');
    const { once } = await import('node:events');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tv-orphan-'));
    const child = fork(new URL('../../src/tv-sharing/image-worker.ts', import.meta.url), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    try {
        const fifo = path.join(dir, 'offline.jpg');
        execFileSync('mkfifo', [fifo]);
        child.send({ source: fifo, width: 320, height: 320 });
        await new Promise(resolve => setTimeout(resolve, 300));
        const exited = once(child, 'exit');
        child.disconnect();
        const [code, signal] = await exited;
        expect(code).toBeNull();
        expect(signal).toBe('SIGKILL');
    }
    finally {
        child.kill('SIGKILL');
        await fs.rm(dir, { recursive: true, force: true });
    }
}, 3000);
