import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { LensMuseumDetail } from "./GearMuseumPage";

describe("lens museum details", () => {
  it("links to all photos for the exact lens and preserves image attribution", () => {
    const html = renderToStaticMarkup(<StaticRouter location="/gear-museum"><LensMuseumDetail lens={{
      label: "Lens 50mm f/1.8 & Macro", photoCount: 3, brand: null, model: null,
      firstPhoto: "2020-01-01", lastPhoto: "2024-01-01", yearBreakdown: [{ year: "2020", count: 3 }],
      imageUrl: "/lens.jpg", imageLicense: "CC BY 4.0", imageAttribution: "Example photographer",
    }} /></StaticRouter>);
    expect(html).toContain("/reports?lens=Lens+50mm+f%2F1.8+%26+Macro");
    expect(html).toContain("CC BY 4.0 · Example photographer");
    expect(html).toContain("Photos taken with this lens");
    expect(html).not.toContain("camera=");
  });
});
