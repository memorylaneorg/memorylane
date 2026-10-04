import type Database from "better-sqlite3";

// Whole-library scans behind /moments and /timeline are expensive on big
// libraries, so their raw rows are kept in memory. Each entry is stamped with
// a cheap fingerprint of everything that changes what those pages show (scans,
// deletion marks, trash, thumbnail progress); a changed fingerprint rebuilds it.
// Favorites and stacks are never cached - routes apply them per request.
const FINGERPRINT_SQL = `SELECT
  (SELECT COUNT(*) FROM media WHERE status = 'active') AS active,
  (SELECT COALESCE(MAX(id), 0) FROM media) AS maxId,
  (SELECT COUNT(*) FROM media WHERE thumbnail_status = 'done') AS thumbs,
  (SELECT COUNT(*) FROM media WHERE thumbnail_status = 'pending') AS pendingThumbs,
  (SELECT COALESCE(SUM(enabled), 0) FROM plugin_settings) AS pluginsEnabled,
  (SELECT COUNT(*) FROM folders WHERE status = 'active') AS folders,
  (SELECT COUNT(*) FROM deletion_marks) AS marks,
  (SELECT COUNT(*) FROM trash_entries) AS trash,
  (SELECT COALESCE(MAX(id), 0) FROM scan_runs) AS scanRun,
  (SELECT COALESCE(MAX(finished_at), '') FROM scan_runs) AS lastFinished`;

export class BrowseCache {
  private readonly entries = new Map<string, { fingerprint: string; value: unknown }>();
  private readonly fingerprintStatement;

  constructor(db: Database.Database) {
    this.fingerprintStatement = db.prepare(FINGERPRINT_SQL);
  }

  fingerprint(): string {
    return JSON.stringify(this.fingerprintStatement.get());
  }

  // Returns the cached value when it was built for this fingerprint, else
  // builds, stores and returns a fresh one.
  getOrCompute<T>(key: string, fingerprint: string, compute: () => T): T {
    const hit = this.entries.get(key);
    if (hit && hit.fingerprint === fingerprint) return hit.value as T;
    const value = compute();
    this.entries.set(key, { fingerprint, value });
    return value;
  }

  // Cached value for this fingerprint, or undefined - never computes.
  peek<T>(key: string, fingerprint: string): T | undefined {
    const hit = this.entries.get(key);
    return hit && hit.fingerprint === fingerprint ? (hit.value as T) : undefined;
  }

  clearPrefix(prefix: string): void {
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key);
  }
}

const caches = new WeakMap<Database.Database, BrowseCache>();

export function browseCache(db: Database.Database): BrowseCache {
  let cache = caches.get(db);
  if (!cache) {
    cache = new BrowseCache(db);
    caches.set(db, cache);
  }
  return cache;
}
