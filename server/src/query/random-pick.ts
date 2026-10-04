import type Database from "better-sqlite3";

// `ORDER BY RANDOM() LIMIT n` sorts every eligible row, which costs ~150 ms on a
// 150k-photo library. Media ids are nearly dense, so probing random ids and
// keeping the eligible ones gives an equivalent uniform sample in ~1 ms.
// Returns null when probing can't fill `count` (tiny or very sparse libraries);
// callers then fall back to their exact ORDER BY RANDOM() query.
export function probeRandomMediaIds(
  db: Database.Database,
  opts: { count: number; where: string; join?: string; bindings?: unknown[]; maxRounds?: number },
): number[] | null {
  const { count, where, join = "", bindings = [], maxRounds = 4 } = opts;
  if (count <= 0) return [];
  const maxId = (db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM media").get() as { m: number }).m;
  if (maxId === 0) return null;

  const found = new Set<number>();
  const tried = new Set<number>();
  for (let round = 0; round < maxRounds && found.size < count; round += 1) {
    const candidates: number[] = [];
    const wanted = Math.max(count * 4, 16);
    for (let i = 0; i < wanted * 2 && candidates.length < wanted; i += 1) {
      const id = 1 + Math.floor(Math.random() * maxId);
      if (!tried.has(id)) { tried.add(id); candidates.push(id); }
    }
    if (candidates.length === 0) break;
    const rows = db.prepare(`SELECT media.id FROM media ${join} WHERE media.id IN (${candidates.map(() => "?").join(",")}) AND ${where}`)
      .all(...candidates, ...bindings) as { id: number }[];
    for (const row of rows) found.add(row.id);
  }
  if (found.size < count) return null;

  // IN-list results come back in id order; shuffle so the sample isn't biased by position.
  const ids = [...found];
  for (let i = ids.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.slice(0, count);
}
