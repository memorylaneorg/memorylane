import type Database from "better-sqlite3";
import type { FavoriteResultDto, MediaTypeFilter } from "@memorylane/shared";
import { buildMediaQuery, mediaCountSql } from "../query/media-query.js";

// All engagement state lives in one small table (media_engagement) - see
// migrations/006_media_engagement.sql. This is intentionally just aggregate
// counters, not a full event-history log.
export class EngagementRepo {
  constructor(private db: Database.Database) {}

  private ensureRow(mediaId: number): void {
    this.db.prepare("INSERT OR IGNORE INTO media_engagement (media_id) VALUES (?)").run(mediaId);
  }

  setFavorite(mediaId: number, favorite: boolean): FavoriteResultDto {
    this.ensureRow(mediaId);
    const favoritedAt = favorite ? new Date().toISOString() : null;
    this.db
      .prepare("UPDATE media_engagement SET favorite = ?, favorited_at = ? WHERE media_id = ?")
      .run(favorite ? 1 : 0, favoritedAt, mediaId);
    return { mediaId, favorite, favoritedAt };
  }

  // Called once per photo each time it's displayed prominently (slideshow,
  // Surprise Me, fullscreen viewer) - never for grid/search thumbnails.
  recordShown(mediaId: number): void {
    this.ensureRow(mediaId);
    this.db
      .prepare(
        "UPDATE media_engagement SET shown_count = shown_count + 1, last_shown_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE media_id = ?",
      )
      .run(mediaId);
  }

  // Called once after a photo has stayed on screen for ~2s (VIEW_MEANINGFUL_MS)
  // - the client is responsible for that debounce; this just records the transition.
  recordViewed(mediaId: number): void {
    this.ensureRow(mediaId);
    this.db
      .prepare(
        `UPDATE media_engagement SET
           view_count = view_count + 1,
           first_viewed_at = COALESCE(first_viewed_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
           last_viewed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE media_id = ?`,
      )
      .run(mediaId);
  }

  getFavoriteMediaIds(mediaIds: number[]): Set<number> {
    if (mediaIds.length === 0) return new Set();
    const placeholders = mediaIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT media_id FROM media_engagement WHERE favorite = 1 AND media_id IN (${placeholders})`)
      .all(...mediaIds) as { media_id: number }[];
    return new Set(rows.map((r) => r.media_id));
  }

  // Mutates and returns `items` with `.favorite` set correctly - call this on
  // any list of MediaDto before sending it to the client.
  attachFavorites<T extends { id: number; favorite: boolean }>(items: T[]): T[] {
    const favoriteIds = this.getFavoriteMediaIds(items.map((i) => i.id));
    for (const item of items) item.favorite = favoriteIds.has(item.id);
    return items;
  }

  listFavoriteIds(offset: number, limit: number, type: MediaTypeFilter = "all"): { ids: number[]; total: number } {
    const q = buildMediaQuery({ favoritesOnly: true, type });
    const total = (this.db.prepare(mediaCountSql(q)).get(...q.bindings) as { c: number }).c;
    const rows = this.db
      .prepare(`SELECT media.id FROM media ${q.joins} WHERE ${q.where} ORDER BY me.favorited_at DESC LIMIT ? OFFSET ?`)
      .all(...q.bindings, limit, offset) as { id: number }[];
    return { ids: rows.map((r) => r.id), total };
  }
}
