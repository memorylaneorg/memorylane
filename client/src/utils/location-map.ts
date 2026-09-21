export const MAP_SIZE = 1000;
const MAX_LATITUDE = 85.05112878;

export interface MapViewport { x: number; y: number; width: number; height: number }
export interface MapBounds { west: number; east: number; south: number; north: number }

export function project(lon: number, lat: number): { x: number; y: number } {
  const latitude = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat));
  const radians = latitude * Math.PI / 180;
  return {
    x: (lon + 180) / 360 * MAP_SIZE,
    y: Math.max(0, Math.min(MAP_SIZE, (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * MAP_SIZE)),
  };
}

export function unproject(x: number, y: number): { lon: number; lat: number } {
  return {
    lon: x / MAP_SIZE * 360 - 180,
    lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / MAP_SIZE))) * 180 / Math.PI,
  };
}

export function viewportBounds(view: MapViewport): MapBounds {
  const left = Math.max(0, Math.min(MAP_SIZE, view.x));
  const right = Math.max(0, Math.min(MAP_SIZE, view.x + view.width));
  const top = Math.max(0, Math.min(MAP_SIZE, view.y));
  const bottom = Math.max(0, Math.min(MAP_SIZE, view.y + view.height));
  return {
    west: unproject(left, 0).lon,
    east: unproject(right, 0).lon,
    north: top === 0 ? 90 : unproject(0, top).lat,
    south: bottom === MAP_SIZE ? -90 : unproject(0, bottom).lat,
  };
}

type Position = [number, number];
type Polygon = Position[][];
type Geometry = { type: "Polygon"; coordinates: Polygon } | { type: "MultiPolygon"; coordinates: Polygon[] };
export interface LandCollection { type: "FeatureCollection"; features: { type: "Feature"; geometry: Geometry }[] }

export function landPath(collection: LandCollection): string {
  const segments: string[] = [];
  for (const feature of collection.features) {
    const polygons = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    for (const polygon of polygons) for (const ring of polygon) {
      if (ring.length === 0) continue;
      segments.push(ring.map(([lon, lat], index) => {
        const point = project(lon, lat);
        return `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`;
      }).join(" ") + " Z");
    }
  }
  return segments.join(" ");
}
