import { expect, it } from 'vitest';
import { createTestApp } from '../helpers/app.js';
import { seedFolder, seedMedia, seedScanRoot } from '../helpers/db.js';
it('creates explicit snapshots, deduplicates additions and preserves membership across rename', async () => {
    const t = await createTestApp();
    try {
        const headers = { cookie: t.cookie };
        const root = seedScanRoot(t.db), folder = seedFolder(t.db, root, '/library'), child = seedFolder(t.db, root, '/library/child', folder);
        const a = seedMedia(t.db, folder, root), b = seedMedia(t.db, child, root);
        expect((await t.app.inject({ url: '/api/collections' })).statusCode).toBe(401);
        const created = await t.app.inject({ method: 'POST', url: '/api/collections', headers, payload: { name: ' Holidays ' } });
        expect(created.statusCode).toBe(201);
        const id = created.json().id;
        expect(created.json().name).toBe('Holidays');
        const add = await t.app.inject({ method: 'POST', url: `/api/collections/${id}/members`, headers, payload: { folderId: folder, recursive: true } });
        expect(add.json().added).toBe(2);
        seedMedia(t.db, child, root);
        expect((await t.app.inject({ method: 'POST', url: `/api/collections/${id}/members`, headers, payload: { mediaIds: [a, a, b] } })).json().added).toBe(0);
        await t.app.inject({ method: 'PATCH', url: `/api/collections/${id}`, headers, payload: { name: 'Trips' } });
        const photos = (await t.app.inject({ url: `/api/collections/${id}/media`, headers })).json();
        expect(photos.total).toBe(2);
        expect(photos.items.map((m: {
            id: number;
        }) => m.id).sort()).toEqual([a, b].sort());
        expect((await t.app.inject({ url: '/api/collections', headers })).json().find((c: {
            id: number;
        }) => c.id === id)).toMatchObject({ name: 'Trips', count: 2 });
        await t.app.inject({ method: 'DELETE', url: `/api/collections/${id}/members`, headers, payload: { mediaIds: [a] } });
        expect((await t.app.inject({ url: `/api/collections/${id}/media`, headers })).json().total).toBe(1);
        await t.app.inject({ method: 'DELETE', url: `/api/collections/${id}`, headers });
        expect(t.db.prepare('SELECT id FROM media WHERE id=?').get(a)).toBeTruthy();
        expect((await t.app.inject({ url: `/api/collections/${id}/media`, headers })).statusCode).toBe(404);
    }
    finally {
        await t.close();
    }
});
it('excludes hidden and non-photo records, supports nonrecursive snapshots and validates mutations', async () => {
    const t = await createTestApp();
    try {
        const headers = { cookie: t.cookie }, root = seedScanRoot(t.db), folder = seedFolder(t.db, root, '/library'), child = seedFolder(t.db, root, '/library/child', folder);
        const visible = seedMedia(t.db, folder, root), nested = seedMedia(t.db, child, root), marked = seedMedia(t.db, folder, root), raw = seedMedia(t.db, folder, root, { media_type: 'raw' });
        t.db.prepare('UPDATE media SET raw_pair_id=? WHERE id=?').run(raw, visible);
        t.db.prepare('INSERT INTO deletion_marks(media_id) VALUES(?)').run(marked);
        const hidden = [marked, raw, seedMedia(t.db, folder, root, { status: 'missing' }), seedMedia(t.db, folder, root, { media_type: 'video' })];
        const id = (await t.app.inject({ method: 'POST', url: '/api/collections', headers, payload: { name: 'One' } })).json().id;
        expect((await t.app.inject({ method: 'POST', url: `/api/collections/${id}/members`, headers, payload: { folderId: folder, recursive: false } })).json().added).toBe(1);
        expect((await t.app.inject({ method: 'POST', url: `/api/collections/${id}/members`, headers, payload: { mediaIds: hidden } })).json().added).toBe(0);
        expect((await t.app.inject({ url: `/api/collections/${id}/media`, headers })).json().items.map((m: {
            id: number;
        }) => m.id)).toEqual([visible]);
        expect((await t.app.inject({ method: 'POST', url: '/api/collections', headers, payload: { name: 'one' } })).statusCode).toBe(409);
        expect((await t.app.inject({ method: 'POST', url: `/api/collections/${id}/members`, headers, payload: { mediaIds: [nested], folderId: folder } })).statusCode).toBe(400);
        expect((await t.app.inject({ method: 'POST', url: '/api/collections', headers, payload: { name: ' ' } })).statusCode).toBe(400);
        expect((await t.app.inject({ method: 'DELETE', url: '/api/collections/favorites', headers })).statusCode).toBe(400);
        t.db.prepare('INSERT INTO media_engagement(media_id,favorite) VALUES(?,1)').run(visible);
        expect((await t.app.inject({ url: '/api/collections/favorites/media', headers })).json().items.map((m: {
            id: number;
        }) => m.id)).toEqual([visible]);
    }
    finally {
        await t.close();
    }
});
