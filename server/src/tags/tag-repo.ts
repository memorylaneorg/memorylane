import type Database from "better-sqlite3";
import { buildMediaQuery, mediaCountSql, mediaSelectSql } from "../query/media-query.js";
import type { MediaRow } from "../api/mappers.js";

export type TagSource = "user" | "imported" | "ai";
export interface MediaTagRow { id: number; name: string; source: TagSource; score: number | null }

export function normalizeTagName(name: string): string {
  const result = name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
  if (!result || result.length > 60 || /[\x00-\x1f\x7f]/.test(result)) throw new Error("Tag must be 1–60 printable characters");
  return result;
}

export class TagRepo {
  constructor(private db: Database.Database) {}

  private ensure(name: string): number {
    const normalized = normalizeTagName(name);
    this.db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)").run(normalized);
    return (this.db.prepare("SELECT id FROM tags WHERE name = ?").get(normalized) as { id: number }).id;
  }

  addUser(mediaId: number, name: string): MediaTagRow {
    const tagId = this.db.transaction(() => {
      const id = this.ensure(name);
      this.db.prepare("INSERT OR IGNORE INTO media_tags (media_id, tag_id, source) VALUES (?, ?, 'user')").run(mediaId, id);
      return id;
    })();
    return (this.listForMedia(mediaId).find((tag) => tag.id === tagId && tag.source === "user"))!;
  }

  remove(mediaId: number, tagId: number, source: "user" | "ai"): boolean {
    return this.db.transaction(() => {
      const deleted = this.db.prepare("DELETE FROM media_tags WHERE media_id = ? AND tag_id = ? AND source = ?").run(mediaId, tagId, source);
      if (deleted.changes === 0) return false;
      if (source === "ai") this.db.prepare("INSERT OR IGNORE INTO ai_tag_suppressions (media_id, tag_id) VALUES (?, ?)").run(mediaId, tagId);
      return true;
    })();
  }

  replaceImported(mediaId: number, names: string[]): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM media_tags WHERE media_id = ? AND source = 'imported'").run(mediaId);
      const insert = this.db.prepare("INSERT OR IGNORE INTO media_tags (media_id, tag_id, source) VALUES (?, ?, 'imported')");
      for (const name of names) {
        try { insert.run(mediaId, this.ensure(name)); } catch (error) { if (!(error instanceof Error && error.message.startsWith("Tag must"))) throw error; }
      }
    })();
  }

  replaceAi(mediaId: number, tags: { name: string; score: number }[], version: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM media_tags WHERE media_id = ? AND source = 'ai'").run(mediaId);
      const insert = this.db.prepare(`INSERT INTO media_tags (media_id, tag_id, source, score, model_version)
        SELECT ?, ?, 'ai', ?, ? WHERE NOT EXISTS (SELECT 1 FROM ai_tag_suppressions WHERE media_id = ? AND tag_id = ?)`);
      for (const tag of tags) {
        const id = this.ensure(tag.name);
        insert.run(mediaId, id, tag.score, version, mediaId, id);
      }
    })();
  }

  listForMedia(mediaId: number): MediaTagRow[] {
    return this.db.prepare(`SELECT t.id, t.name, mt.source, mt.score FROM media_tags mt JOIN tags t ON t.id = mt.tag_id
      WHERE mt.media_id = ? ORDER BY t.name, CASE mt.source WHEN 'user' THEN 0 WHEN 'imported' THEN 1 ELSE 2 END`)
      .all(mediaId) as MediaTagRow[];
  }

  facets(search = "", offset = 0, limit = 100): { items: { id: number; name: string; count: number }[]; total: number; offset: number; limit: number } {
    const q = buildMediaQuery({});
    const normalized = search.normalize("NFKC").trim().toLocaleLowerCase("en");
    const grouped = `SELECT t.id, t.name, COUNT(DISTINCT media.id) AS count FROM tags t
      JOIN media_tags mt ON mt.tag_id = t.id JOIN media ON media.id = mt.media_id ${q.joins}
      WHERE ${q.where} AND instr(t.name, ?) > 0 GROUP BY t.id HAVING count > 0`;
    const bindings = [...q.bindings, normalized];
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM (${grouped})`).get(...bindings) as { c: number }).c;
    const items = this.db.prepare(`${grouped} ORDER BY count DESC, t.name LIMIT ? OFFSET ?`)
      .all(...bindings, limit, offset) as { id: number; name: string; count: number }[];
    return { items, total, offset, limit };
  }

  mediaForTag(tagId: number, offset: number, limit: number): { items: MediaRow[]; total: number; offset: number; limit: number } {
    const q = buildMediaQuery({ tagId });
    const total = (this.db.prepare(mediaCountSql(q)).get(...q.bindings) as { c: number }).c;
    const items = this.db.prepare(mediaSelectSql(q)).all(...q.bindings, limit, offset) as MediaRow[];
    return { items, total, offset, limit };
  }
}
