import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { AppleBrowseCard } from "./AppleBrowseCard";

describe("Apple Photos browse cards", () => {
  it("labels the source separately from the library filename", () => {
    const html = renderToStaticMarkup(<StaticRouter location="/">
      <AppleBrowseCard to="/apple-photos/7" title="Apple Device Photos" subtitle="Photos Library.photoslibrary" count={1977} coverMediaId={null} thumbnailVersion={0} previewRootId={7} />
    </StaticRouter>);
    expect(html).toContain("Apple Device Photos");
    expect(html).toContain("Photos Library.photoslibrary");
    expect(html).toContain('href="/apple-photos/7"');
  });
});
