import type Database from "better-sqlite3";
import { EXCLUDE_LIVE_PHOTO_VIDEOS, EXCLUDE_PAIRED_RAW } from "../query/media-query.js";

export interface LocationFilters {
  source: "all" | "filesystem" | "apple";
  fromYear?: number;
  toYear?: number;
}

export interface LocationBounds {
  west: number;
  east: number;
  south: number;
  north: number;
}

export interface LocationPoint {
  key: string;
  source: "filesystem" | "apple";
  mediaId: number | null;
  rootId: number | null;
  uuid: string | null;
  filename: string;
  date: string | null;
  lat: number;
  lon: number;
}

const PAGE_SIZE = 512;

function validPoint(lat: number | null, lon: number | null): lat is number {
  return lat !== null && lon !== null && Number.isFinite(lat) && Number.isFinite(lon)
    && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function matches(point: LocationPoint, filters: LocationFilters, bounds?: LocationBounds): boolean {
  if (filters.fromYear !== undefined || filters.toYear !== undefined) {
    const year = point.date && /^\d{4}/.test(point.date) ? Number(point.date.slice(0, 4)) : null;
    if (year === null || (filters.fromYear !== undefined && year < filters.fromYear)
      || (filters.toYear !== undefined && year > filters.toYear)) return false;
  }
  if (!bounds) return true;
  if (point.lat < bounds.south || point.lat > bounds.north) return false;
  return bounds.west <= bounds.east
    ? point.lon >= bounds.west && point.lon <= bounds.east
    : point.lon >= bounds.west || point.lon <= bounds.east;
}

export class LocationRepo {
  constructor(private db: Database.Database) {}

  *points(filters: LocationFilters, bounds?: LocationBounds): Generator<LocationPoint> {
    if (filters.source !== "apple") yield* this.filesystemPoints(filters, bounds);
    if (filters.source !== "filesystem" && process.platform === "darwin") yield* this.applePoints(filters, bounds);
  }

  summary(filters: LocationFilters): {
    total: number;
    sources: { filesystem: number; apple: number };
    years: { year: number; count: number }[];
    undated: number;
  } {
    const sources = { filesystem: 0, apple: 0 };
    const years = new Map<number, number>();
    let total = 0;
    let undated = 0;
    for (const point of this.points(filters)) {
      total++;
      sources[point.source]++;
      const year = point.date && /^\d{4}/.test(point.date) ? Number(point.date.slice(0, 4)) : null;
      if (year === null) undated++;
      else years.set(year, (years.get(year) ?? 0) + 1);
    }
    return { total, sources, years: [...years].sort(([a], [b]) => a - b).map(([year, count]) => ({ year, count })), undated };
  }

  private *filesystemPoints(filters: LocationFilters, bounds?: LocationBounds): Generator<LocationPoint> {
    const bounded = bounds !== undefined;
    const lonPredicate = bounded ? bounds.west <= bounds.east
      ? "media.gps_lon BETWEEN ? AND ?" : "(media.gps_lon >= ? OR media.gps_lon <= ?)" : "1 = 1";
    const stmt = this.db.prepare(`SELECT media.id, media.filename, media.captured_date, media.gps_lat, media.gps_lon
      FROM media ${bounded ? "INDEXED BY idx_media_location" : ""} JOIN scan_roots sr ON sr.id = media.scan_root_id
      WHERE ${bounded ? "(media.gps_lat, media.gps_lon, media.id) > (?, ?, ?)" : "media.id > ?"}
        AND sr.kind = 'folder' AND media.status = 'active'
        AND (media.source_kind IS NULL OR media.source_kind != 'apple-photos')
        AND media.id NOT IN (SELECT media_id FROM deletion_marks)
        AND ${EXCLUDE_LIVE_PHOTO_VIDEOS} AND ${EXCLUDE_PAIRED_RAW}
        AND media.gps_lat IS NOT NULL AND media.gps_lon IS NOT NULL
        ${bounded ? `AND media.gps_lat BETWEEN ? AND ? AND ${lonPredicate}` : ""}
      ORDER BY ${bounded ? "media.gps_lat, media.gps_lon, media.id" : "media.id"} LIMIT ?`);
    let lastId = 0, lastLat = -91, lastLon = -181;
    while (true) {
      const args = bounded
        ? [lastLat, lastLon, lastId, bounds.south, bounds.north, bounds.west, bounds.east, PAGE_SIZE]
        : [lastId, PAGE_SIZE];
      const page = stmt.all(...args) as { id: number; filename: string; captured_date: string | null; gps_lat: number | null; gps_lon: number | null }[];
      if (page.length === 0) return;
      for (const row of page) {
        lastId = row.id;
        if (bounded) { lastLat = row.gps_lat!; lastLon = row.gps_lon!; }
        if (!validPoint(row.gps_lat, row.gps_lon)) continue;
        const point: LocationPoint = {
          key: `m:${row.id}`, source: "filesystem", mediaId: row.id, rootId: null, uuid: null,
          filename: row.filename, date: row.captured_date, lat: row.gps_lat, lon: row.gps_lon!,
        };
        if (matches(point, filters, bounds)) yield point;
      }
    }
  }

  private *applePoints(filters: LocationFilters, bounds?: LocationBounds): Generator<LocationPoint> {
    if (bounds) {
      yield* this.boundedApplePoints(filters, bounds);
      return;
    }
    const catalogPair = "a.catalog_gps_lat BETWEEN -90 AND 90 AND a.catalog_gps_lon BETWEEN -180 AND 180";
    const stmt = this.db.prepare(`SELECT a.scan_root_id, a.uuid, a.original_filename,
        m.id AS media_id, COALESCE(a.catalog_date, m.captured_date) AS date,
        CASE WHEN ${catalogPair} THEN a.catalog_gps_lat ELSE m.gps_lat END AS lat,
        CASE WHEN ${catalogPair} THEN a.catalog_gps_lon ELSE m.gps_lon END AS lon
      FROM apple_photos_assets a
      JOIN scan_roots sr ON sr.id = a.scan_root_id AND sr.kind = 'apple-photos' AND sr.enabled = 1
      LEFT JOIN media m ON m.id = a.media_id AND m.status = 'active'
      WHERE (a.scan_root_id > ? OR (a.scan_root_id = ? AND a.uuid > ?))
        AND a.hidden = 0 AND a.in_trash = 0
        AND EXISTS (SELECT 1 FROM plugin_settings ps WHERE ps.id = 'apple-photos' AND ps.enabled = 1)
        AND NOT EXISTS (SELECT 1 FROM deletion_marks dm WHERE dm.media_id = a.media_id)
      ORDER BY a.scan_root_id, a.uuid LIMIT ?`);
    let lastRoot = 0, lastUuid = "";
    while (true) {
      const page = stmt.all(lastRoot, lastRoot, lastUuid, PAGE_SIZE) as {
        scan_root_id: number; uuid: string; original_filename: string | null;
        media_id: number | null; date: string | null; lat: number | null; lon: number | null;
      }[];
      if (page.length === 0) return;
      for (const row of page) {
        lastRoot = row.scan_root_id;
        lastUuid = row.uuid;
        if (!validPoint(row.lat, row.lon)) continue;
        const point: LocationPoint = {
          key: `a:${row.scan_root_id}:${row.uuid}`, source: "apple", mediaId: row.media_id,
          rootId: row.scan_root_id, uuid: row.uuid, filename: row.original_filename ?? row.uuid,
          date: row.date, lat: row.lat, lon: row.lon!,
        };
        if (matches(point, filters, bounds)) yield point;
      }
    }
  }

  private *boundedApplePoints(filters: LocationFilters, bounds: LocationBounds): Generator<LocationPoint> {
    const catalogPair = "a.catalog_gps_lat BETWEEN -90 AND 90 AND a.catalog_gps_lon BETWEEN -180 AND 180";
    const allowed = `JOIN scan_roots sr ON sr.id = a.scan_root_id AND sr.kind = 'apple-photos' AND sr.enabled = 1
      WHERE a.hidden = 0 AND a.in_trash = 0
        AND EXISTS (SELECT 1 FROM plugin_settings ps WHERE ps.id = 'apple-photos' AND ps.enabled = 1)
        AND NOT EXISTS (SELECT 1 FROM deletion_marks dm WHERE dm.media_id = a.media_id)`;
    const lon = (column: string) => bounds.west <= bounds.east
      ? `${column} BETWEEN ? AND ?` : `(${column} >= ? OR ${column} <= ?)`;
    const catalog = this.db.prepare(`SELECT a.rowid AS seq, a.scan_root_id, a.uuid, a.original_filename,
        m.id AS media_id, COALESCE(a.catalog_date, m.captured_date) AS date,
        a.catalog_gps_lat AS lat, a.catalog_gps_lon AS lon
      FROM apple_photos_assets a INDEXED BY idx_apple_catalog_location
      LEFT JOIN media m ON m.id = a.media_id AND m.status = 'active'
      ${allowed} AND a.catalog_gps_lat IS NOT NULL AND a.catalog_gps_lon IS NOT NULL
        AND ${catalogPair} AND a.catalog_gps_lat BETWEEN ? AND ? AND ${lon("a.catalog_gps_lon")}
        AND (a.catalog_gps_lat, a.catalog_gps_lon, a.rowid) > (?, ?, ?)
      ORDER BY a.catalog_gps_lat, a.catalog_gps_lon, a.rowid LIMIT ?`);
    const fallback = this.db.prepare(`SELECT m.id AS seq, a.scan_root_id, a.uuid, a.original_filename,
        m.id AS media_id, COALESCE(a.catalog_date, m.captured_date) AS date,
        m.gps_lat AS lat, m.gps_lon AS lon
      FROM media m INDEXED BY idx_media_location
      JOIN apple_photos_assets a ON a.media_id = m.id
      JOIN scan_roots sr ON sr.id = a.scan_root_id AND sr.kind = 'apple-photos' AND sr.enabled = 1
      WHERE a.hidden = 0 AND a.in_trash = 0 AND m.status = 'active'
        AND EXISTS (SELECT 1 FROM plugin_settings ps WHERE ps.id = 'apple-photos' AND ps.enabled = 1)
        AND NOT EXISTS (SELECT 1 FROM deletion_marks dm WHERE dm.media_id = a.media_id)
        AND NOT COALESCE(${catalogPair}, 0)
        AND m.gps_lat IS NOT NULL AND m.gps_lon IS NOT NULL
        AND m.gps_lat BETWEEN -90 AND 90 AND m.gps_lon BETWEEN -180 AND 180
        AND m.gps_lat BETWEEN ? AND ? AND ${lon("m.gps_lon")}
        AND (m.gps_lat, m.gps_lon, m.id) > (?, ?, ?)
      ORDER BY m.gps_lat, m.gps_lon, m.id LIMIT ?`);
    type Row = { seq: number; scan_root_id: number; uuid: string; original_filename: string | null;
      media_id: number | null; date: string | null; lat: number; lon: number };
    for (const stmt of [catalog, fallback]) {
      let lastLat = -91, lastLon = -181, lastSeq = 0;
      while (true) {
        const page = stmt.all(bounds.south, bounds.north, bounds.west, bounds.east,
          lastLat, lastLon, lastSeq, PAGE_SIZE) as Row[];
        if (page.length === 0) break;
        for (const row of page) {
          lastLat = row.lat; lastLon = row.lon; lastSeq = row.seq;
          if (!validPoint(row.lat, row.lon)) continue;
          const point: LocationPoint = {
            key: `a:${row.scan_root_id}:${row.uuid}`, source: "apple", mediaId: row.media_id,
            rootId: row.scan_root_id, uuid: row.uuid, filename: row.original_filename ?? row.uuid,
            date: row.date, lat: row.lat, lon: row.lon,
          };
          if (matches(point, filters, bounds)) yield point;
        }
      }
    }
  }
}
