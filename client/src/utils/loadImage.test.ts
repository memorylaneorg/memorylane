import { afterEach, describe, expect, it, vi } from "vitest";
import { loadImage } from "./loadImage";

class TestImage {
  static latest: TestImage;
  src = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  decode = vi.fn<() => Promise<void>>();
  constructor() { TestImage.latest = this; }
}

afterEach(() => vi.unstubAllGlobals());

describe("viewer image loading", () => {
  it("keeps the preview until the larger image has decoded", async () => {
    vi.stubGlobal("Image", TestImage);
    const ready = vi.fn();
    const failed = vi.fn();
    let finish!: () => void;
    loadImage("/original.jpg", ready, failed);
    const image = TestImage.latest;
    image.decode.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    expect(image.src).toBe("/original.jpg");
    expect(ready).not.toHaveBeenCalled();
    image.onload!();
    expect(ready).not.toHaveBeenCalled();
    finish();
    await Promise.resolve();
    expect(ready).toHaveBeenCalledOnce();
    expect(failed).not.toHaveBeenCalled();
  });

  it("reports a failed original so the thumbnail can remain visible", () => {
    vi.stubGlobal("Image", TestImage);
    const ready = vi.fn();
    const failed = vi.fn();
    loadImage("/missing.jpg", ready, failed);
    TestImage.latest.onerror!();
    expect(failed).toHaveBeenCalledOnce();
    expect(ready).not.toHaveBeenCalled();
  });

  it("does not replace the current photo when an older decode finishes", async () => {
    vi.stubGlobal("Image", TestImage);
    const ready = vi.fn();
    const failed = vi.fn();
    let finish!: () => void;
    const cancel = loadImage("/old.jpg", ready, failed);
    const image = TestImage.latest;
    image.decode.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    image.onload!();
    cancel();
    finish();
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(image.onload).toBeNull();
    expect(image.onerror).toBeNull();
  });

  it("retains the thumbnail when decoding fails", async () => {
    vi.stubGlobal("Image", TestImage);
    const ready = vi.fn();
    const failed = vi.fn();
    loadImage("/invalid.jpg", ready, failed);
    TestImage.latest.decode.mockRejectedValue(new Error("decode failed"));
    TestImage.latest.onload!();
    await Promise.resolve();
    expect(failed).toHaveBeenCalledOnce();
    expect(ready).not.toHaveBeenCalled();
  });
});
