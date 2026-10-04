import type Database from "better-sqlite3";
import { buildMediaQuery } from "../query/media-query.js";
import { probeRandomMediaIds } from "../query/random-pick.js";

// Isolated behind an interface so the sampling strategy can be swapped (e.g.
// for reservoir sampling or history-weighted "forgotten photos" selection)
// without touching the /api/memories route. See PLAN.md section 12.
export interface RandomSelectionService {
  getRandomMediaIds(count: number): number[];
}

// Photos not shown in the last N days are strongly preferred; never-shown
// photos (no media_engagement row at all) are always eligible. This is a
// simple recency exclusion rather than a fully weighted sample - it directly
// satisfies "favor never/rarely/not-recently shown, avoid repeating very
// recent ones" without the complexity of a scored weighted-random query.
const RECENTLY_SHOWN_COOLDOWN_DAYS = 7;

// Scope-less, so no bindings - the WHERE fragment can be inlined.
const ELIGIBLE = buildMediaQuery({ type: "photo", thumbnailDone: true, collapseStacks: true }).where;

export class SqliteRandomSelectionService implements RandomSelectionService {
  constructor(private db: Database.Database) {}

  getRandomMediaIds(count: number): number[] {
    // Photos only for v1 (Surprise Me excludes video per product spec section 20).
    const fresh = `${ELIGIBLE} AND (e.last_shown_at IS NULL OR e.last_shown_at < datetime('now', '-${RECENTLY_SHOWN_COOLDOWN_DAYS} days'))`;
    const probed = probeRandomMediaIds(this.db, { count, where: fresh, join: "LEFT JOIN media_engagement e ON e.media_id = media.id" });
    const eligibleRows = probed
      ? probed.map((id) => ({ id }))
      : (this.db
        .prepare(
          `SELECT media.id FROM media
           LEFT JOIN media_engagement e ON e.media_id = media.id
           WHERE ${fresh}
           ORDER BY RANDOM() LIMIT ?`,
        )
        .all(count) as { id: number }[]);

    if (eligibleRows.length >= count) {
      return eligibleRows.map((r) => r.id);
    }

    // Not enough "fresh" photos to fill the request (small library, or most
    // of it was shown recently) - top up with the full pool, excluding what
    // we already picked so the result has no duplicates.
    const alreadyPicked = eligibleRows.map((r) => r.id);
    const exclusion = alreadyPicked.length
      ? `AND media.id NOT IN (${alreadyPicked.map(() => "?").join(",")})`
      : "";
    const topUpRows = this.db
      .prepare(
        `SELECT media.id FROM media
         WHERE ${ELIGIBLE}
           ${exclusion}
         ORDER BY RANDOM() LIMIT ?`,
      )
      .all(...alreadyPicked, count - alreadyPicked.length) as { id: number }[];

    return [...alreadyPicked, ...topUpRows.map((r) => r.id)];
  }
}
