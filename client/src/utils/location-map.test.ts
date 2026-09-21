import { describe, expect, it } from "vitest";
import { landPath, project, unproject, viewportBounds } from "./location-map";

describe("offline map geometry", () => {
  it("projects the equator to the middle and reverses coordinates", () => {
    expect(project(0, 0)).toEqual({ x: 500, y: 500 });
    const point = project(-74, 40);
    const recovered = unproject(point.x, point.y);
    expect(recovered.lon).toBeCloseTo(-74);
    expect(recovered.lat).toBeCloseTo(40);
  });

  it("clamps latitude and derives geographic bounds from the viewport", () => {
    expect(project(0, 90).y).toBeGreaterThanOrEqual(0);
    expect(project(0, -90).y).toBeLessThanOrEqual(1000);
    const bounds = viewportBounds({ x: 250, y: 250, width: 500, height: 500 });
    expect(bounds.west).toBeCloseTo(-90);
    expect(bounds.east).toBeCloseTo(90);
    expect(bounds.south).toBeLessThan(0);
    expect(bounds.north).toBeGreaterThan(0);
    expect(viewportBounds({ x: 0, y: 0, width: 1000, height: 100 }).north).toBe(90);
    expect(viewportBounds({ x: 0, y: 900, width: 1000, height: 100 }).south).toBe(-90);
  });

  it("closes land polygons in the bundled outline", () => {
    const path = landPath({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Polygon", coordinates: [[[-1, 0], [1, 0], [0, 1], [-1, 0]]] } }] });
    expect(path).toMatch(/^M/);
    expect(path).toContain("Z");
  });
});
