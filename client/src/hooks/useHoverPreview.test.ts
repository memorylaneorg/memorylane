import { describe, expect, it, vi } from "vitest";
import { previewSequence, startPreviewRotation } from "./useHoverPreview";

describe("folder hover preview sequence", () => {
  it("does not cycle a nested-folder fallback cover and deduplicates direct thumbnails", () => {
    expect(previewSequence({ id: 2, thumbnailVersion: 1 }, [
      { id: 3, thumbnailVersion: 4 },
      { id: 3, thumbnailVersion: 4 },
      { id: 4, thumbnailVersion: 2 },
    ])).toEqual([
      { id: 3, thumbnailVersion: 4 },
      { id: 4, thumbnailVersion: 2 },
    ]);
  });

  it("switches frames every 350 ms and stops when hover ends", () => {
    vi.useFakeTimers();
    try {
      const frames: number[] = [];
      const stop = startPreviewRotation([
        { id: 1, thumbnailVersion: 1 },
        { id: 2, thumbnailVersion: 1 },
      ], (frame) => frames.push(frame.id));

      expect(frames).toEqual([2]);
      vi.advanceTimersByTime(349);
      expect(frames).toEqual([2]);
      vi.advanceTimersByTime(1);
      expect(frames).toEqual([2, 1]);

      stop();
      vi.advanceTimersByTime(700);
      expect(frames).toEqual([2, 1]);
    } finally {
      vi.useRealTimers();
    }
  });
});
