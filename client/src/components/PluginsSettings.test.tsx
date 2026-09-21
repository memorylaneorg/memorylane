import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ApplePhotosPluginPanel } from "./PluginsSettings";

const noop = () => {};

describe("Apple Photos plugin controls", () => {
  it("shows unavailable on non-macOS without an enable control", () => {
    const html = renderToStaticMarkup(<ApplePhotosPluginPanel plugin={{ id: "apple-photos", name: "Apple Photos", enabled: false, available: false }}
      roots={[]} statuses={{}} helperStatus={null} libraryPath="" busy={false}
      onToggle={noop} onPathChange={noop} onAdd={noop} onSync={noop} />);
    expect(html).toContain("Unavailable on this platform");
    expect(html).not.toContain("Enable Apple Photos");
  });

  it("shows helper guidance and per-library sync only when enabled", () => {
    const html = renderToStaticMarkup(<ApplePhotosPluginPanel plugin={{ id: "apple-photos", name: "Apple Photos", enabled: true, available: true }}
      roots={[{ id: 7, path: "/Pictures/Test.photoslibrary", kind: "apple-photos", enabled: true, sortOrder: 1,
        createdAt: "", updatedAt: "", stats: { mediaCount: 4, photoCount: 4, rawCount: 0, videoCount: 0,
          folderCount: 1, totalSizeBytes: 40, pendingThumbnails: 0, failedThumbnails: 0, transcodeCandidateCount: 0 } }]}
      statuses={{ 7: { status: "running", processed: 2, total: 10, failed: 0, previewOnly: 1, unavailable: 1, error: null } }} helperStatus="ready" libraryPath="" busy={false}
      onToggle={noop} onPathChange={noop} onAdd={noop} onSync={noop} />);
    expect(html).toContain("Plugin service: ready");
    expect(html).toContain("/Pictures/Test.photoslibrary");
    expect(html).toContain("2 / 10");
    expect(html).toContain("1 preview-only");
    expect(html).toContain("Sync now");
  });

  it("shows catalog preparation before the first page arrives", () => {
    const html = renderToStaticMarkup(<ApplePhotosPluginPanel plugin={{ id: "apple-photos", name: "Apple Photos", enabled: true, available: true }}
      roots={[{ id: 8, path: "/Pictures/Test.photoslibrary", kind: "apple-photos", enabled: true, sortOrder: 1,
        createdAt: "", updatedAt: "", stats: { mediaCount: 0, photoCount: 0, rawCount: 0, videoCount: 0,
          folderCount: 0, totalSizeBytes: 0, pendingThumbnails: 0, failedThumbnails: 0, transcodeCandidateCount: 0 } }]}
      statuses={{ 8: { status: "running", processed: 0, total: 0, failed: 0, previewOnly: 0, unavailable: 0,
        error: null, startedAt: new Date(Date.now() - 65_000).toISOString() } }}
      helperStatus="ready" libraryPath="" busy={false}
      onToggle={noop} onPathChange={noop} onAdd={noop} onSync={noop} />);
    expect(html).toContain("Preparing Photos catalog");
    expect(html).toContain("elapsed");
    expect(html).toContain("Plugin service: ready");
  });

  it("labels a stored failure as previous when the helper is currently ready", () => {
    const html = renderToStaticMarkup(<ApplePhotosPluginPanel plugin={{ id: "apple-photos", name: "Apple Photos", enabled: true, available: true }}
      roots={[{ id: 8, path: "/Pictures/Test.photoslibrary", kind: "apple-photos", enabled: true, sortOrder: 1,
        createdAt: "", updatedAt: "", stats: { mediaCount: 0, photoCount: 0, rawCount: 0, videoCount: 0,
          folderCount: 0, totalSizeBytes: 0, pendingThumbnails: 0, failedThumbnails: 0, transcodeCandidateCount: 0 } }]}
      statuses={{ 8: { status: "failed", processed: 0, total: 0, failed: 0, previewOnly: 0, unavailable: 0,
        error: "Apple Photos plugin is unavailable" } }}
      helperStatus="ready" libraryPath="" busy={false}
      onToggle={noop} onPathChange={noop} onAdd={noop} onSync={noop} />);
    expect(html).toContain("Plugin service: ready");
    expect(html).toContain("Previous sync error:");
  });
});
