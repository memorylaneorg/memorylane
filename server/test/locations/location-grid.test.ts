import { describe, expect, it } from "vitest";
import { cellKey, groupCells } from "../../src/locations/location-grid.js";

describe("location grid", () => {
  it("groups nearby points and splits them as zoom increases", () => {
    const a = { key: "m:1", source: "filesystem" as const, mediaId: 1, rootId: null, uuid: null, date: "2020-01-01", lat: 40, lon: -74 };
    const b = { ...a, key: "m:2", mediaId: 2, lat: 40.005, lon: -74.005 };
    expect(cellKey(a.lat, a.lon, 0)).toBe(cellKey(b.lat, b.lon, 0));
    expect(cellKey(a.lat, a.lon, 10)).not.toBe(cellKey(b.lat, b.lon, 10));
    const cells = groupCells([a, b], 0);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ count: 2 });
    expect(cells[0].lat).toBeCloseTo(40.0025);
  });

  it("clamps poles and wraps the antimeridian into valid cell keys", () => {
    expect(cellKey(90, 180, 0)).toBe(cellKey(85.05112878, -180, 0));
    expect(cellKey(-90, -180, 0)).toMatch(/^0:\d+:\d+$/);
  });
});
