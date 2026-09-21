import { useEffect, useState } from "react";

export interface PreviewFrame { id: number; thumbnailVersion: number }

export function previewSequence(_cover: PreviewFrame | null, items: PreviewFrame[]): PreviewFrame[] {
  const seen = new Set<number>();
  // The idle cover may come from a nested folder (or be a video); the endpoint
  // decides which ready photos to cycle, including descendant fallback.
  return items.filter((item) => {
    if (seen.size >= 6 || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

export function startPreviewRotation(sequence: PreviewFrame[], show: (frame: PreviewFrame) => void): () => void {
  let index = 1;
  show(sequence[index]);
  const interval = setInterval(() => {
    index = (index + 1) % sequence.length;
    show(sequence[index]);
  }, 350);
  return () => clearInterval(interval);
}

export function useHoverPreview(cover: PreviewFrame | null, load: () => Promise<PreviewFrame[]>) {
  const [hovering, setHovering] = useState(false);
  const [frame, setFrame] = useState<PreviewFrame | null>(null);

  useEffect(() => {
    if (!hovering || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setFrame(null);
      return;
    }
    let cancelled = false;
    let stopRotation: (() => void) | undefined;
    const delay = setTimeout(() => {
      void load().then((items) => {
        if (cancelled) return;
        const sequence = previewSequence(cover, items);
        if (sequence.length < 2) return;
        stopRotation = startPreviewRotation(sequence, setFrame);
      }).catch(() => {});
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(delay);
      stopRotation?.();
    };
  }, [hovering, cover?.id, cover?.thumbnailVersion, load]);

  return { frame, onMouseEnter: () => setHovering(true), onMouseLeave: () => setHovering(false) };
}
