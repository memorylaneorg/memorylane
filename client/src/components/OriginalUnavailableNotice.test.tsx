import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OriginalUnavailableNotice } from "./OriginalUnavailableNotice";

describe("Original unavailable notice", () => {
  it("explains a disk photo fallback to the cached thumbnail", () => {
    const html = renderToStaticMarkup(<OriginalUnavailableNotice fallback sourceKind={null} />);

    expect(html).toContain("Original unavailable");
    expect(html).toContain("showing cached thumbnail");
    expect(html).toContain("Reconnect the drive or scan folder");
  });

  it("stays hidden while the disk original is loading normally", () => {
    const html = renderToStaticMarkup(<OriginalUnavailableNotice fallback={false} sourceKind={null} />);

    expect(html).toBe("");
  });

  it("leaves Apple Photos fallbacks to the Apple-specific notice", () => {
    const html = renderToStaticMarkup(<OriginalUnavailableNotice fallback sourceKind="apple-photos" />);

    expect(html).toBe("");
  });
});
