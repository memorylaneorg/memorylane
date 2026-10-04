import type Database from 'better-sqlite3';
import { browseCache } from '../api/browse-cache.js';
import { detectMoments } from './detect.js';
import { evenlySpaced, loadActiveDays, querySampleRows } from './catalog.js';

// Stable picks between refreshes keep paginated TV browsing predictable. Membership
// refreshes within 30 seconds; the broker rechecks source visibility on every image.
const cache = new WeakMap<Database.Database, {at:number;ids:number[];fingerprint:string;revision:number}>();
export function momentHighlights(db: Database.Database, eligible: string): number[] {
  const previous = cache.get(db);
  if (previous && Date.now()-previous.at < 30000) return previous.ids;
  const fingerprint = JSON.stringify([
    browseCache(db).fingerprint(),
    db.prepare('SELECT COUNT(*) n, MAX(updated_at) updated FROM media_exif').get(),
    db.prepare('SELECT id,enabled FROM scan_roots ORDER BY id').all(),
    new Date().toISOString().slice(0,10),
  ]);
  if (previous?.fingerprint === fingerprint) { previous.at=Date.now(); return previous.ids; }
  const moments = detectMoments(loadActiveDays(db), 'balanced');
  const rows = querySampleRows(db, {extraWhere:eligible});
  const days = new Map<string, number[]>();
  for (const row of rows) {
    const day = days.get(row.moment_date) ?? [];
    day.push(row.id); days.set(row.moment_date, day);
  }
  const ids = [...new Set(moments.flatMap(moment => evenlySpaced(moment.activeDays.flatMap(day => days.get(day.date) ?? []))))];
  cache.set(db, {at:Date.now(), ids, fingerprint, revision:(previous?.revision ?? 0)+1});
  return ids;
}

export function momentHighlightsRevision(db: Database.Database, eligible: string, refresh = true): number {
  if (refresh) momentHighlights(db, eligible);
  return cache.get(db)?.revision ?? 0;
}
