import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ApplePhotoTile } from "./ApplePhotoTile";

describe("Apple catalog-only tile", () => {
  it("offers Photos and a separate local check without claiming an image is ready", () => {
    const html = renderToStaticMarkup(<ApplePhotoTile item={{
      uuid: "cloud", filename: "Cloud.jpg", date: "2020-08-10", latitude: 12, longitude: 34,
      mediaId: null, thumbnailVersion: 0, available: false,
    }} busy={false} onOpen={() => {}} onOpenInPhotos={() => {}} onCheckLocal={() => {}} />);
    expect(html).toContain("Image not local");
    expect(html).toContain("Open in Photos");
    expect(html).toContain("Check for local copy");
  });
});
