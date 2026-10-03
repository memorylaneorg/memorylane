import type Database from 'better-sqlite3';
import type { CollectionDto, CollectionId } from '@memorylane/shared';
import type { MediaRow } from '../api/mappers.js';
import { buildMediaQuery, mediaCountSql, mediaSelectSql, type MediaScope } from '../query/media-query.js';
// Reused by the TV broker after applying its stricter filesystem-only policy.
export function collectionMembership(id: CollectionId): {
    sql: string;
    params: unknown[];
} {
    return id === 'favorites'
        ? { sql: 'EXISTS (SELECT 1 FROM media_engagement e WHERE e.media_id=media.id AND e.favorite=1)', params: [] }
        : { sql: 'EXISTS (SELECT 1 FROM collection_media cm JOIN collections c ON c.id=cm.collection_id WHERE cm.media_id=media.id AND c.id=?)', params: [id] };
}
export class CollectionRepo {
    constructor(private db: Database.Database) { }
    exists(id: CollectionId): boolean { return id === 'favorites' || !!this.db.prepare('SELECT id FROM collections WHERE id=?').get(id); }
    query(id: CollectionId) {
        const q = buildMediaQuery({ type: 'photo' }), membership = collectionMembership(id);
        return { ...q, where: `${q.where} AND ${membership.sql}`, bindings: [...q.bindings, ...membership.params] };
    }
    list(): CollectionDto[] {
        const rows = this.db.prepare('SELECT id,name FROM collections ORDER BY name COLLATE NOCASE,id').all() as {
            id: number;
            name: string;
        }[];
        return [{ id: 'favorites' as const, name: 'Favorites' }, ...rows].map(c => ({ ...c, builtin: c.id === 'favorites', count: this.count(c.id) }));
    }
    count(id: CollectionId): number {
        const q = this.query(id);
        return (this.db.prepare(mediaCountSql(q)).get(...q.bindings) as {
            c: number;
        }).c;
    }
    create(name: string): CollectionDto {
        const id = Number(this.db.prepare('INSERT INTO collections(name,name_key) VALUES(?,?)').run(name, name.toLocaleLowerCase('en')).lastInsertRowid);
        return { id, name, count: 0, builtin: false };
    }
    rename(id: number, name: string): void {
        this.db.prepare('UPDATE collections SET name=?,name_key=? WHERE id=?').run(name, name.toLocaleLowerCase('en'), id);
    }
    delete(id: number): void { this.db.prepare('DELETE FROM collections WHERE id=?').run(id); }
    media(id: CollectionId, offset: number, limit: number) {
        const q = this.query(id);
        return { items: this.db.prepare(mediaSelectSql(q, 'media.captured_date IS NULL, media.captured_date, media.filename, media.id')).all(...q.bindings, limit, offset) as MediaRow[], total: this.count(id), offset, limit };
    }
    add(id: number, scope: MediaScope): number {
        const q = buildMediaQuery({ scope, type: 'photo' });
        // One INSERT SELECT is an atomic snapshot, regardless of folder size.
        return this.db.prepare(`${q.cte} INSERT OR IGNORE INTO collection_media(collection_id,media_id) SELECT ?,media.id FROM media ${q.joins} WHERE ${q.where}`)
            .run(...(q.cte ? [q.bindings[0], id, ...q.bindings.slice(1)] : [id, ...q.bindings])).changes;
    }
    remove(id: number, ids: number[]): number {
        if (!ids.length)
            return 0;
        return this.db.prepare(`DELETE FROM collection_media WHERE collection_id=? AND media_id IN (${ids.map(() => '?').join(',')})`).run(id, ...ids).changes;
    }
}
