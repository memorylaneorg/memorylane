import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ApplePreviewNotice } from "./ApplePreviewNotice";

describe("Apple preview notice", () => {
  it("labels the lower-resolution source and offers Open in Photos, not download-original", () => {
    const html = renderToStaticMarkup(<ApplePreviewNotice onOpen={() => {}} error={null} />);
    expect(html).toContain("Original is in iCloud");
    expect(html).toContain("Open in Photos");
    expect(html).not.toContain("Download original");
  });
});
