import type { LocationPoint } from "./location-repo.js";

const MERCATOR_LIMIT = 85.05112878;

export function cellKey(lat: number, lon: number, zoom: number): string {
  const n = 32 * 2 ** zoom;
  const wrappedLon = ((lon + 180) % 360 + 360) % 360;
  const clampedLat = Math.max(-MERCATOR_LIMIT, Math.min(MERCATOR_LIMIT, lat));
  const radians = clampedLat * Math.PI / 180;
  const x = Math.min(n - 1, Math.floor(wrappedLon / 360 * n));
  const y = Math.min(n - 1, Math.max(0, Math.floor((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * n)));
  return `${zoom}:${x}:${y}`;
}

export interface LocationCell {
  key: string;
  lat: number;
  lon: number;
  count: number;
}

export function groupCells(points: Iterable<LocationPoint>, zoom: number): LocationCell[] {
  const grouped = new Map<string, { count: number; lat: number; lon: number }>();
  for (const point of points) {
    const key = cellKey(point.lat, point.lon, zoom);
    const cell = grouped.get(key) ?? { count: 0, lat: 0, lon: 0 };
    cell.count++;
    cell.lat += point.lat;
    cell.lon += point.lon;
    grouped.set(key, cell);
  }
  return [...grouped].map(([key, value]) => ({
    key,
    count: value.count,
    lat: value.lat / value.count,
    lon: value.lon / value.count,
  }));
}
