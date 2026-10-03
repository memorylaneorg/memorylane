import type Database from 'better-sqlite3';
import { z } from 'zod';
import { isIP } from 'node:net';
import type { AppPaths } from '../config/paths.js';
import type { MediaRow } from '../api/mappers.js';
import { EXCLUDE_PAIRED_RAW } from '../query/media-query.js';
import { TvImageCache } from './images.js';
export const TV_PLUGIN_ID = 'com.memorylane.tv-sharing';
const privateIP = (ip: string) => { if (isIP(ip) !== 4)
    return false; const [a, b] = ip.split('.').map(Number); return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168); };
const folder = z.object({ id: z.number().int().positive(), recursive: z.boolean() }).strict();
export const TvSettingsSchema = z.object({ enabled: z.boolean().default(false), address: z.string().refine(ip => ip === '' || privateIP(ip)).default(''), port: z.number().int().min(1024).max(65535).default(4283), name: z.string().trim().min(1).max(80).default('MemoryLane'), folders: z.array(folder).max(100).default([]), quality: z.enum(['1080p', '4k']).default('1080p'), cacheMiB: z.number().int().min(64).max(10240).default(1024) }).strict();
export type TvSettings = z.infer<typeof TvSettingsSchema>;
const browseSchema = z.object({ objectId: z.string().max(256), flag: z.enum(['BrowseMetadata', 'BrowseDirectChildren']), start: z.number().int().min(0).max(0xffffffff), count: z.number().int().min(1).max(100), sort: z.enum(['+dc:title', '-dc:title']).default('+dc:title') }).strict();
const eligible = EXCLUDE_PAIRED_RAW + " AND media.status='active' AND media.media_type IN ('image','raw') AND media.thumbnail_status='done' AND (media.source_kind IS NULL OR media.source_kind!='apple-photos') AND media.id NOT IN (SELECT media_id FROM deletion_marks)";
export class TvSharingBroker {
    private images: TvImageCache;
    constructor(private db: Database.Database, private paths: AppPaths, private pluginEnabled: () => boolean) { this.images = new TvImageCache(paths); }
    settings(): TvSettings { const row = this.db.prepare("SELECT value FROM settings WHERE key='tvSharing'").get() as {
        value: string;
    } | undefined; try {
        return TvSettingsSchema.parse(row ? JSON.parse(row.value) : {});
    }
    catch {
        return TvSettingsSchema.parse({});
    } }
    save(patch: unknown): TvSettings {
        const parsed = TvSettingsSchema.partial().parse(patch), config = TvSettingsSchema.parse({ ...this.settings(), ...parsed });
        if (config.enabled && (!config.address || !config.folders.length))
            throw Error('Choose an interface and at least one folder');
        if (config.enabled)
            for (const selection of config.folders)
                if (!this.db.prepare("SELECT f.id FROM folders f JOIN scan_roots r ON r.id=f.scan_root_id WHERE f.id=? AND f.status='active' AND r.kind='folder' AND r.enabled=1").get(selection.id))
                    throw Error('Folder unavailable');
        this.db.prepare("INSERT INTO settings(key,value) VALUES('tvSharing',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(config));
        return config;
    }
    async diagnostics() {
        const s = this.scope();
        const sharedPhotos = (this.db.prepare(`${s.sql} SELECT COUNT(*) AS n FROM media WHERE media.parent_folder_id IN (SELECT id FROM allowed) AND ${eligible}`).get(...s.params) as {
            n: number;
        }).n;
        return { sharedPhotos, cacheBytes: await this.images.usage(), conversionFailures: this.images.failures };
    }
    private scope() {
        const config = this.settings();
        const roots = config.folders;
        return { sql: `WITH RECURSIVE roots(id,recursive) AS (${roots.length ? 'VALUES ' + roots.map(() => '(?,?)').join(',') : 'SELECT NULL,0 WHERE 0'}), allowed(id,recursive) AS (SELECT f.id,r.recursive FROM folders f JOIN roots r ON r.id=f.id JOIN scan_roots s ON s.id=f.scan_root_id WHERE f.status='active' AND s.enabled=1 AND s.kind='folder' UNION SELECT f.id,1 FROM folders f JOIN allowed a ON f.parent_id=a.id WHERE a.recursive=1 AND f.status='active')`, params: roots.flatMap(r => [r.id, r.recursive ? 1 : 0]) };
    }
    allowedMedia(id: number): MediaRow | undefined {
        if (!this.pluginEnabled() || !this.settings().enabled)
            return undefined;
        const s = this.scope();
        return this.db.prepare(`${s.sql} SELECT media.* FROM media WHERE media.id=? AND media.parent_folder_id IN (SELECT id FROM allowed) AND ${eligible}`).get(...s.params, id) as MediaRow | undefined;
    }
    async call(pluginId: string, method: string, payload: unknown): Promise<unknown> {
        if (pluginId !== TV_PLUGIN_ID)
            throw Error('Not authorized');
        const config = this.settings(), enabled = config.enabled && this.pluginEnabled();
        const updateId = (this.db.prepare('SELECT total_changes() AS n').get() as {
            n: number;
        }).n >>> 0;
        if (method === 'tv.config')
            return { ...config, enabled, updateId, apiVersion: 1 };
        if (!enabled)
            throw Error('Sharing disabled');
        if (method === 'tv.image') {
            const args = z.object({ id: z.string().regex(/^p:\d+$/), profile: z.enum(['display', 'thumbnail']) }).strict().parse(payload);
            const id = Number(args.id.slice(2)), media = this.allowedMedia(id);
            if (!media)
                throw Error('Not shared');
            const bytes = await this.images.get(media, args.profile, config.quality, config.cacheMiB, () => !!this.allowedMedia(id));
            if (!this.allowedMedia(id))
                throw Error('Sharing revoked');
            return { bytes: bytes.toString('base64'), contentType: 'image/jpeg' };
        }
        if (method !== 'tv.browse')
            throw Error('Unknown operation');
        const args = browseSchema.parse(payload), s = this.scope();
        const folderItem = (f: {
            id: number;
            name: string;
            parent_id: number | null;
        }) => ({ id: `f:${f.id}`, parentId: f.parent_id == null || config.folders.some(r => r.id === f.id) ? '0' : `f:${f.parent_id}`, kind: 'container', title: f.name });
        const rootItem = { id: '0', parentId: '-1', kind: 'container', title: config.name };
        if (args.flag === 'BrowseMetadata') {
            if (args.objectId === '0')
                return { items: [rootItem], total: 1, updateId };
            if (/^p:\d+$/.test(args.objectId)) {
                const m = this.allowedMedia(Number(args.objectId.slice(2)));
                if (!m)
                    throw Error('Not shared');
                return { items: [{ id: args.objectId, parentId: `f:${m.parent_folder_id}`, kind: 'photo', title: m.filename }], total: 1, updateId };
            }
            if (!/^f:\d+$/.test(args.objectId))
                throw Error('Not shared');
            const f = this.db.prepare(`${s.sql} SELECT id,name,parent_id FROM folders WHERE id=? AND id IN (SELECT id FROM allowed)`).get(...s.params, Number(args.objectId.slice(2))) as {
                id: number;
                name: string;
                parent_id: number | null;
            } | undefined;
            if (!f)
                throw Error('Not shared');
            return { items: [folderItem(f)], total: 1, updateId };
        }
        let query: string, params: unknown[];
        if (args.objectId === '0') {
            query = `${s.sql} SELECT 'f:'||id AS id, '0' AS parentId,'container' AS kind,name AS title FROM folders WHERE id IN (SELECT id FROM roots) AND id IN (SELECT id FROM allowed)`;
            params = s.params;
        }
        else {
            if (!/^f:\d+$/.test(args.objectId))
                throw Error('Not shared');
            const id = Number(args.objectId.slice(2));
            if (!this.db.prepare(`${s.sql} SELECT id FROM allowed WHERE id=?`).get(...s.params, id))
                throw Error('Not shared');
            query = `${s.sql} SELECT 'f:'||id AS id,'f:'||parent_id AS parentId,'container' AS kind,name AS title FROM folders WHERE parent_id=? AND id IN (SELECT id FROM allowed) UNION ALL SELECT 'p:'||media.id AS id,'f:'||media.parent_folder_id AS parentId,'photo' AS kind,media.filename AS title FROM media WHERE media.parent_folder_id=? AND ${eligible}`;
            params = [...s.params, id, id];
        }
        const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM (${query})`).get(...params) as {
            n: number;
        }).n;
        const items = this.db.prepare(`SELECT * FROM (${query}) ORDER BY title COLLATE NOCASE ${args.sort === '-dc:title' ? 'DESC' : 'ASC'},id LIMIT ? OFFSET ?`).all(...params, args.count, args.start);
        return { items, total, updateId };
    }
}
