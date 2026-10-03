import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProgressiveImage } from "./ProgressiveImage";

describe("ProgressiveImage", () => {
  it("renders the cached thumbnail immediately, before starting the original request", () => {
    const html = renderToStaticMarkup(<ProgressiveImage src="/file/1" thumbnailSrc="/thumb/1?v=3" alt="Photo" onUnavailable={() => {}} />);
    expect(html).toContain('src="/thumb/1?v=3"');
    expect(html).not.toContain('src="/file/1"');
    expect(html).toContain('alt="Photo"');
  });
});
