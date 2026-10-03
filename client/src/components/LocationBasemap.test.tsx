import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import LocationBasemap from "./LocationBasemap";

const view = { x: 0, y: 240, width: 1000, height: 520 };

describe("location basemap", () => {
  it("keeps the offline outline and makes no remote image requests when detail is off", () => {
    const html = renderToStaticMarkup(<LocationBasemap view={view} outline="M0 0L1 1Z" detailed={false} />);
    expect(html).toContain('d="M0 0L1 1Z"');
    expect(html).not.toContain("tile.openstreetmap.org");
    expect(html).not.toContain("<img");
  });

  it("credits online map data and preserves the outline beneath tiles", () => {
    const html = renderToStaticMarkup(<LocationBasemap view={view} outline="M0 0L1 1Z" detailed />);
    expect(html).toContain("https://www.openstreetmap.org/copyright");
    expect(html).toContain('d="M0 0L1 1Z"');
  });
});
