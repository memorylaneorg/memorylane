import type Database from "better-sqlite3";

export interface AppleBrowseGroup {
  key: string;
  count: number;
  coverMediaId: number | null;
  thumbnailVersion: number;
}

export interface AppleBrowseItem {
  uuid: string;
  filename: string;
  date: string | null;
  latitude: number | null;
  longitude: number | null;
  mediaId: number | null;
  thumbnailVersion: number;
  available: boolean;
}

export interface AppleBrowseResult {
  groups: AppleBrowseGroup[];
  items: AppleBrowseItem[];
  total: number;
  offset: number;
  limit: number;
}

const FROM = `FROM apple_photos_assets a
  LEFT JOIN media m ON m.id = a.media_id AND m.status = 'active'
  WHERE a.scan_root_id = ? AND a.hidden = 0 AND a.in_trash = 0
    AND NOT EXISTS (SELECT 1 FROM deletion_marks dm WHERE dm.media_id = a.media_id)`;
const DATE = "COALESCE(m.captured_date, a.catalog_date)";

export function previewApplePhotos(
  db: Database.Database, rootId: number, year: string | null, month: string | null, limit: number,
): { id: number; thumbnailVersion: number }[] {
  const bindings: (number | string)[] = [rootId];
  let dateFilter = "";
  if (year === "unknown") dateFilter = ` AND ${DATE} IS NULL`;
  else if (year && year !== "all") {
    dateFilter = ` AND substr(${DATE}, 1, 4) = ?`;
    bindings.push(year);
    if (month) {
      dateFilter += ` AND substr(${DATE}, 6, 2) = ?`;
      bindings.push(month);
    }
  }
  return db.prepare(`SELECT m.id, m.thumbnail_version AS thumbnailVersion ${FROM}
    AND m.thumbnail_status = 'done' AND m.media_type IN ('image', 'raw')${dateFilter}
    ORDER BY ${DATE} DESC, m.id DESC LIMIT ?`)
    .all(...bindings, Math.min(Math.max(limit, 1), 6)) as { id: number; thumbnailVersion: number }[];
}

export function browseApplePhotos(
  db: Database.Database, rootId: number, year: string | null, month: string | null, offset: number, limit: number,
): AppleBrowseResult {
  if (year === null || (year !== "all" && year !== "unknown" && month === null)) {
    const expression = year === null ? `COALESCE(substr(${DATE}, 1, 4), 'unknown')` : `substr(${DATE}, 6, 2)`;
    const filter = year === null ? "" : ` AND substr(${DATE}, 1, 4) = ?`;
    const bindings = year === null ? [rootId] : [rootId, year];
    const rows = db.prepare(`SELECT ${expression} AS key, COUNT(*) AS count,
      MAX(CASE WHEN m.thumbnail_status = 'done' THEN m.id END) AS coverMediaId
      ${FROM}${filter} GROUP BY key ORDER BY (key = 'unknown') ASC, key DESC`).all(...bindings) as
      { key: string; count: number; coverMediaId: number | null }[];
    const groups = rows.map((row) => ({ ...row, thumbnailVersion: row.coverMediaId === null ? 0 :
      (db.prepare("SELECT thumbnail_version AS v FROM media WHERE id = ?").get(row.coverMediaId) as { v: number }).v }));
    return { groups, items: [], total: 0, offset, limit };
  }

  let filter = "";
  const bindings: (string | number)[] = [rootId];
  if (year === "unknown") filter = ` AND ${DATE} IS NULL`;
  else if (year !== "all") {
    filter = ` AND substr(${DATE}, 1, 4) = ? AND substr(${DATE}, 6, 2) = ?`;
    bindings.push(year, month!);
  }
  const total = (db.prepare(`SELECT COUNT(*) AS c ${FROM}${filter}`).get(...bindings) as { c: number }).c;
  const rows = db.prepare(`SELECT a.uuid, a.original_filename AS filename, ${DATE} AS date,
      COALESCE(m.gps_lat, a.catalog_gps_lat) AS latitude,
      COALESCE(m.gps_lon, a.catalog_gps_lon) AS longitude,
      m.id AS mediaId, COALESCE(m.thumbnail_version, 0) AS thumbnailVersion
      ${FROM}${filter} ORDER BY date DESC, a.uuid LIMIT ? OFFSET ?`)
    .all(...bindings, limit, offset) as Omit<AppleBrowseItem, "available">[];
  return { groups: [], items: rows.map((row) => ({ ...row, available: row.mediaId !== null })), total, offset, limit };
}
