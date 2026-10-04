import { momentHighlights, momentHighlightsRevision } from '../moments/highlights.js';
import { DEFAULT_PREVIEW_MIB, MAX_PREVIEW_MIB } from '../media/preview-upgrades.js';
import type { CollectionId } from '@memorylane/shared';
import { CollectionRepo, collectionMembership } from '../collections/collection-repo.js';
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
type TvCollectionId = CollectionId | 'moments-highlights';
const collectionIdSchema = z.union([z.literal('favorites'), z.number().int().positive().max(Number.MAX_SAFE_INTEGER)]);
const tvCollectionIdSchema = z.union([collectionIdSchema,z.literal('moments-highlights')]);
export const TvSettingsSchema = z.object({ enabled: z.boolean().default(false), address: z.string().refine(ip => ip === '' || privateIP(ip)).default(''), port: z.number().int().min(1024).max(65535).default(4283), name: z.string().trim().min(1).max(80).default('MemoryLane'), folders: z.array(folder).max(100).default([]), collections: z.array(collectionIdSchema).max(100).default([]), quality: z.enum(['1080p', '4k']).default('4k'), momentsHighlights: z.boolean().default(false), upgradePreviews: z.boolean().default(false), previewCacheMiB: z.number().int().min(1024).max(MAX_PREVIEW_MIB).default(DEFAULT_PREVIEW_MIB), cacheMiB: z.number().int().min(64).max(10240).default(2048) }).strict();
export type TvSettings = z.infer<typeof TvSettingsSchema>;
const browseSchema = z.object({ objectId: z.string().max(256), flag: z.enum(['BrowseMetadata', 'BrowseDirectChildren']), start: z.number().int().min(0).max(0xffffffff), count: z.number().int().min(1).max(100), sort: z.enum(['+dc:title', '-dc:title']).default('+dc:title') }).strict();
const eligible = "EXISTS (SELECT 1 FROM scan_roots sr JOIN folders f ON f.scan_root_id=sr.id WHERE sr.id=media.scan_root_id AND f.id=media.parent_folder_id AND sr.enabled=1 AND sr.kind='folder' AND f.status='active') AND " + EXCLUDE_PAIRED_RAW + " AND media.status='active' AND media.media_type IN ('image','raw') AND media.thumbnail_status='done' AND (media.source_kind IS NULL OR media.source_kind!='apple-photos') AND media.id NOT IN (SELECT media_id FROM deletion_marks)";
export class TvSharingBroker {
    private images: TvImageCache;
    constructor(private db: Database.Database, private paths: AppPaths, private pluginEnabled: () => boolean, private upgrades?: import("../media/preview-upgrades.js").PreviewUpgrades) { this.images = new TvImageCache(paths); }
    settings(): TvSettings { const row = this.db.prepare("SELECT value FROM settings WHERE key='tvSharing'").get() as {
        value: string;
    } | undefined; try {
        const config = TvSettingsSchema.parse(row ? JSON.parse(row.value) : {});
        config.collections = config.collections.filter(id => new CollectionRepo(this.db).exists(id));
        return config;
    }
    catch {
        return TvSettingsSchema.parse({});
    } }
    save(patch: unknown): TvSettings {
        const previousLimit = this.settings().previewCacheMiB;
        const parsed = TvSettingsSchema.partial().parse(patch), config = TvSettingsSchema.parse({ ...this.settings(), ...parsed });
        if (config.enabled && (!config.address || (!config.folders.length && !config.collections.length && !config.momentsHighlights)))
            throw Error('Choose an interface and at least one sharing source');
        if (config.enabled)
            for (const selection of config.folders)
                if (!this.db.prepare("SELECT f.id FROM folders f JOIN scan_roots r ON r.id=f.scan_root_id WHERE f.id=? AND f.status='active' AND r.kind='folder' AND r.enabled=1").get(selection.id))
                    throw Error('Folder unavailable');
        config.collections = [...new Set(config.collections)];
        if (config.enabled && config.collections.some(id => !new CollectionRepo(this.db).exists(id)))
            throw Error('Collection unavailable');
        this.db.prepare("INSERT INTO settings(key,value) VALUES('tvSharing',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(config));
        if (config.previewCacheMiB > previousLimit) this.requestRetries('budget');
        this.upgrades?.reconcile();
        this.pruneUnsharedWork();
        return config;
    }
    private requestRetries(reason?: 'budget') {
        const s = this.scope(), selection = this.selection();
        return this.db.prepare(`${s.sql} UPDATE preview_upgrades SET retry_requested=1 WHERE retry_requested=0 AND state IN ('failed','blocked') ${reason ? "AND error_code='budget'" : ''} AND media_id IN (SELECT media.id FROM media WHERE (${selection.sql}) AND ${eligible} AND media.media_type='raw')`).run(...s.params,...selection.params).changes;
    }
    retryPreviews() {
        if (!this.pluginEnabled() || !this.settings().enabled || !this.settings().upgradePreviews || !this.upgrades) throw Error('Enable shared RAW preview upgrades first');
        const count = this.requestRetries();
        this.preparePreviews();
        return count;
    }
    setPreviewProcessing(enabled: boolean) {
        const config = {...this.settings(), upgradePreviews:enabled};
        this.db.prepare("INSERT INTO settings(key,value) VALUES('tvSharing',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(config));
        this.upgrades?.reconcile();
        return config;
    }
    clearCache() { return this.images.clear(); }
    async diagnostics() {
        const s = this.scope(), selection = this.selection();
        const sharedPhotos = (this.db.prepare(`${s.sql} SELECT COUNT(*) AS n FROM media WHERE (${selection.sql}) AND ${eligible}`).get(...s.params, ...selection.params) as {
            n: number;
        }).n;
        const previewSelection = selection;
        const remaining = (this.db.prepare(`${s.sql} SELECT COUNT(*) n FROM media WHERE (${previewSelection.sql}) AND ${eligible} AND media.media_type='raw' AND NOT EXISTS (SELECT 1 FROM preview_upgrades j WHERE j.media_id=media.id AND j.state IN ('ready','limited') AND j.fingerprint=json_array(media.absolute_path,media.file_size,media.fs_modified_at,media.orientation,1))`).get(...s.params,...previewSelection.params) as {n:number}).n;
        const previewScope = {
            sql: `${s.sql} SELECT media.id,json_array(media.absolute_path,media.file_size,media.fs_modified_at,media.orientation,1) fingerprint FROM media WHERE (${previewSelection.sql}) AND ${eligible} AND media.media_type='raw'`,
            params: [...s.params,...previewSelection.params],
        };
        return { previews: this.upgrades?.summary(previewScope), previewStorage: await this.upgrades?.storage(remaining, previewScope), sharedPhotos, cacheBytes: await this.images.usage(), conversionFailures: this.images.failures };
    }
    private pruneUnsharedWork() {
        const s = this.scope(), selection = this.selection();
        const visible = `SELECT media.id FROM media WHERE (${selection.sql}) AND ${eligible}`;
        this.db.prepare(`${s.sql} DELETE FROM preview_upgrades WHERE state='queued' AND media_id NOT IN (${visible})`).run(...s.params,...selection.params);
        this.db.prepare(`${s.sql} UPDATE preview_upgrades SET retry_requested=0 WHERE retry_requested=1 AND media_id NOT IN (${visible})`).run(...s.params,...selection.params);
    }
    preparePreviews() {
        this.upgrades?.reconcile();
        if (!this.pluginEnabled() || !this.settings().enabled) return;
        this.pruneUnsharedWork();
        if (!this.settings().upgradePreviews || !this.upgrades) return;
        const s = this.scope(), selection = this.selection();
        const retries = this.db.prepare(`${s.sql} SELECT media.* FROM media JOIN preview_upgrades j ON j.media_id=media.id WHERE j.retry_requested=1 AND (${selection.sql}) AND ${eligible} ORDER BY media.id LIMIT 1000`).all(...s.params,...selection.params) as MediaRow[];
        for (const media of retries) this.upgrades.enqueue(media, true, 4);
        const pending = "AND media.media_type='raw' AND NOT EXISTS (SELECT 1 FROM preview_upgrades j WHERE j.media_id=media.id AND j.fingerprint=json_array(media.absolute_path,media.file_size,media.fs_modified_at,media.orientation,1))";
        // Explicit shared collections precede bulk folder preparation.
        for (const id of this.settings().collections) {
            const membership = collectionMembership(id);
            const rows = this.db.prepare(`SELECT media.* FROM media WHERE ${membership.sql} AND ${eligible} ${pending} ORDER BY media.id LIMIT 1000`).all(...membership.params) as MediaRow[];
            for (const media of rows) this.upgrades.enqueue(media, false, 4);
        }
        const rows = this.db.prepare(`${s.sql} SELECT media.* FROM media WHERE (${selection.sql}) AND ${eligible} ${pending} ORDER BY media.id LIMIT 1000`).all(...s.params, ...selection.params) as MediaRow[];
        for (const media of rows) this.upgrades.enqueue(media);
    }
    private scope() {
        const config = this.settings();
        const roots = config.folders;
        return { sql: `WITH RECURSIVE roots(id,recursive) AS (${roots.length ? 'VALUES ' + roots.map(() => '(?,?)').join(',') : 'SELECT NULL,0 WHERE 0'}), allowed(id,recursive) AS (SELECT f.id,r.recursive FROM folders f JOIN roots r ON r.id=f.id JOIN scan_roots s ON s.id=f.scan_root_id WHERE f.status='active' AND s.enabled=1 AND s.kind='folder' UNION SELECT f.id,1 FROM folders f JOIN allowed a ON f.parent_id=a.id WHERE a.recursive=1 AND f.status='active')`, params: roots.flatMap(r => [r.id, r.recursive ? 1 : 0]) };
    }
    private highlightMembership() {
        return {sql: `media.id IN (SELECT value FROM json_each(?))`, params:[JSON.stringify(momentHighlights(this.db, eligible))]};
    }
    private membership(id: TvCollectionId) {
        return id === 'moments-highlights' ? this.highlightMembership() : collectionMembership(id);
    }
    private selection() {
        const memberships = this.settings().collections.map(collectionMembership);
        if (this.settings().momentsHighlights) memberships.push(this.highlightMembership());
        return { sql: ['media.parent_folder_id IN (SELECT id FROM allowed)', ...memberships.map(m => m.sql)].join(' OR '), params: memberships.flatMap(m => m.params) };
    }
    private collectionSelected(id: TvCollectionId): boolean {
        if (id === 'moments-highlights') return this.settings().momentsHighlights;
        return this.settings().collections.includes(id) && new CollectionRepo(this.db).exists(id);
    }
    allowedMedia(id: number, collectionId?: TvCollectionId): MediaRow | undefined {
        if (!this.pluginEnabled() || !this.settings().enabled)
            return undefined;
        if (collectionId !== undefined && !this.collectionSelected(collectionId)) return undefined;
        const s = this.scope(), selection = collectionId === undefined ? this.selection() : this.membership(collectionId);
        return this.db.prepare(`${s.sql} SELECT media.* FROM media WHERE media.id=? AND (${selection.sql}) AND ${eligible}`).get(...s.params, id, ...selection.params) as MediaRow | undefined;
    }
    async call(pluginId: string, method: string, payload: unknown): Promise<unknown> {
        if (pluginId !== TV_PLUGIN_ID)
            throw Error('Not authorized');
        const config = this.settings(), enabled = config.enabled && this.pluginEnabled();
        const updateId = ((this.db.prepare('SELECT total_changes() AS n').get() as {
            n: number;
        }).n + momentHighlightsRevision(this.db, eligible, enabled && config.momentsHighlights)) >>> 0;
        if (method === 'tv.config')
            return { ...config, enabled, updateId, apiVersion: 2 };
        if (!enabled)
            throw Error('Sharing disabled');
        if (method === 'tv.collections') {
            // Only explicitly selected collections enter the unauthenticated catalog.
            const ids = config.collections.filter((id): id is number => typeof id === 'number');
            const items: {id:TvCollectionId;name:string}[] = ids.length ? this.db.prepare(`SELECT id,name FROM collections WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY name COLLATE NOCASE,id`).all(...ids) as {id:number;name:string}[] : [];
            if (config.momentsHighlights) items.unshift({id:'moments-highlights',name:'Moments highlights'});
            if (config.collections.includes('favorites')) items.unshift({id:'favorites',name:'Favorites'});
            return {items,updateId};
        }
        if (method === 'tv.collection') {
            const args = z.object({collectionId:tvCollectionIdSchema,start:z.number().int().min(0).max(0xffffffff),count:z.number().int().min(1).max(100),sort:z.enum(['+dc:title','-dc:title']).default('+dc:title'),mediaId:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()}).strict().parse(payload);
            if (!this.collectionSelected(args.collectionId)) throw Error('Not shared');
            const membership = this.membership(args.collectionId);
            const where = `${membership.sql} AND ${eligible}${args.mediaId === undefined ? '' : ' AND media.id=?'}`;
            const params = [...membership.params, ...(args.mediaId === undefined ? [] : [args.mediaId])];
            const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM media WHERE ${where}`).get(...params) as {n:number}).n;
            const title = args.collectionId === 'moments-highlights'
                ? "COALESCE((SELECT captured_at_precise FROM media_exif WHERE media_id=media.id),'') || ' ' || media.filename" : 'media.filename';
            const items = this.db.prepare(`SELECT media.id,${title} AS title FROM media WHERE ${where} ORDER BY title COLLATE NOCASE ${args.sort === '-dc:title' ? 'DESC' : 'ASC'},media.id LIMIT ? OFFSET ?`).all(...params,args.count,args.start);
            return {items,total,updateId};
        }
        // Older TV modules pass unknown virtual IDs through to core. Keep the
        // optional source usable with those installed modules as well.
        if (method === 'tv.browse' && typeof (payload as {objectId?:unknown})?.objectId === 'string' && (payload as {objectId:string}).objectId.startsWith('c:moments-highlights')) {
            const args = browseSchema.parse(payload);
            const alias = /^c:moments-highlights(?::p:([1-9]\d*))?$/.exec(args.objectId);
            if (!alias || !this.collectionSelected('moments-highlights')) throw Error('Not shared');
            if (!alias[1] && args.flag === 'BrowseMetadata') return {items:[{id:args.objectId,parentId:'0',kind:'container',title:'Moments highlights'}],total:1,updateId};
            if (alias[1] && args.flag !== 'BrowseMetadata') throw Error('Not a folder');
            const result = await this.call(pluginId,'tv.collection',{collectionId:'moments-highlights',start:alias[1]?0:args.start,count:alias[1]?1:args.count,sort:args.sort,...(alias[1]?{mediaId:Number(alias[1])}:{})}) as {items:{id:number;title:string}[];total:number;updateId:number};
            if (alias[1] && !result.items.length) throw Error('Not shared');
            return {...result,items:result.items.map(item=>({id:`c:moments-highlights:p:${item.id}`,parentId:'c:moments-highlights',kind:'photo',title:item.title}))};
        }
        if (method === 'tv.image') {
            const args = z.object({ id: z.string().regex(/^(?:p:\d+|c:moments-highlights:p:[1-9]\d*)$/), profile: z.enum(['display', 'thumbnail']), collectionId: tvCollectionIdSchema.optional() }).strict().parse(payload);
            if (args.id.startsWith('c:moments-highlights:')) { args.id = args.id.slice('c:moments-highlights:'.length); args.collectionId = 'moments-highlights'; }
            const id = Number(args.id.slice(2)), media = this.allowedMedia(id, args.collectionId);
            if (!media)
                throw Error('Not shared');
            this.upgrades?.enqueue(media, false, 5);
            const bytes = await this.images.get(media, args.profile, config.quality, config.cacheMiB, () => !!this.allowedMedia(id, args.collectionId));
            if (!this.allowedMedia(id, args.collectionId))
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
