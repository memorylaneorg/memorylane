import { describe, it, expect } from 'vitest';
import { createTestDb, seedScanRoot, seedFolder, seedMedia } from '../helpers/db.js';
import { TvSharingBroker, TV_PLUGIN_ID } from '../../src/tv-sharing/broker.js';
import type { AppPaths } from '../../src/config/paths.js';
describe('TV sharing policy', () => {
    it('defaults off and enforces current folder policy for direct photo IDs', async () => {
        const db = await createTestDb();
        let plugin = true;
        try {
            const root = seedScanRoot(db), a = seedFolder(db, root, '/library/a'), b = seedFolder(db, root, '/library/b'), child = seedFolder(db, root, '/library/a/child', a);
            const photo = seedMedia(db, a, root), nested = seedMedia(db, child, root), privatePhoto = seedMedia(db, b, root);
            const broker = new TvSharingBroker(db, {} as AppPaths, () => plugin);
            expect(broker.settings().enabled).toBe(false);
            await expect(broker.call(TV_PLUGIN_ID, 'tv.browse', { objectId: '0', flag: 'BrowseDirectChildren', start: 0, count: 100 })).rejects.toThrow();
            broker.save({ enabled: true, address: '192.168.1.2', folders: [{ id: a, recursive: false }] });
            expect(broker.allowedMedia(photo)).toBeTruthy();
            expect(broker.allowedMedia(nested)).toBeUndefined();
            expect(broker.allowedMedia(privatePhoto)).toBeUndefined();
            broker.save({ folders: [{ id: a, recursive: true }] });
            expect(broker.allowedMedia(nested)).toBeTruthy();
            const results = await broker.call(TV_PLUGIN_ID, 'tv.browse', { objectId: `f:${a}`, flag: 'BrowseDirectChildren', start: 0, count: 100 }) as {
                items: unknown[];
            };
            expect(results.items).toHaveLength(2);
            await expect(broker.call('com.memorylane.people', 'tv.config', {})).rejects.toThrow();
            broker.save({ folders: [], enabled: false });
            expect(broker.allowedMedia(photo)).toBeUndefined();
            plugin = false;
            expect((await broker.call(TV_PLUGIN_ID, 'tv.config', {}) as {
                enabled: boolean;
            }).enabled).toBe(false);
        }
        finally {
            db.close();
        }
    });
    it('excludes video, missing, Apple Photos and deletion-marked records', async () => {
        const db = await createTestDb();
        try {
            const root = seedScanRoot(db), folder = seedFolder(db, root, '/library'), broker = new TvSharingBroker(db, {} as AppPaths, () => true);
            broker.save({ enabled: true, address: '10.0.0.5', folders: [{ id: folder, recursive: true }] });
            const video = seedMedia(db, folder, root, { media_type: 'video' }), missing = seedMedia(db, folder, root, { status: 'missing' }), apple = seedMedia(db, folder, root);
            db.prepare("UPDATE media SET source_kind='apple-photos' WHERE id=?").run(apple);
            for (const id of [video, missing, apple])
                expect(broker.allowedMedia(id)).toBeUndefined();
            expect(() => broker.save({ address: '8.8.8.8' })).toThrow();
            const raw = seedMedia(db, folder, root, { media_type: 'raw' }), jpeg = seedMedia(db, folder, root);
            db.prepare('UPDATE media SET raw_pair_id=? WHERE id=?').run(raw, jpeg);
            expect(broker.allowedMedia(raw)).toBeUndefined();
            db.prepare('INSERT INTO deletion_marks(media_id) VALUES(?)').run(jpeg);
            expect(broker.allowedMedia(jpeg)).toBeUndefined();
            db.prepare("UPDATE folders SET status='missing' WHERE id=?").run(folder);
            expect(broker.save({ enabled: false }).enabled).toBe(false);
        }
        finally {
            db.close();
        }
    });
});
