import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import type { MediaDto } from "@memorylane/shared";
import { formatMemoryBlurb } from "../utils/blurb";
import { displaySrc } from "../utils/mediaSrc";
import { useEngagementTracking } from "../hooks/useEngagementTracking";
import Viewer from "./Viewer";

const AUTO_ADVANCE_MS = 4500;

// A small, bounded (non-fullscreen) auto-advancing photo browser embedded
// directly on the page - "surface photos from everywhere without doing
// anything." Clicking the photo opens the full slideshow Viewer at that spot.
export default function InlineSlideshow({ items }: { items: MediaDto[] }) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const [fallback, setFallback] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Reset to the start whenever the underlying photo set changes (e.g. switching tabs).
  useEffect(() => setIndex(0), [items]);
  useEffect(() => setFallback(false), [index]);

  const goNext = useCallback(() => setIndex((i) => (i + 1) % items.length), [items.length]);
  const goPrev = useCallback(() => setIndex((i) => (i - 1 + items.length) % items.length), [items.length]);

  useEffect(() => {
    if (playing && items.length > 1) {
      timerRef.current = setInterval(goNext, AUTO_ADVANCE_MS);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [playing, goNext, items.length]);

  const current = items[index];
  useEngagementTracking(current?.id);
  if (!current) return null;

  const blurb = formatMemoryBlurb(current);

  return (
    <>
      <div
        className="relative h-[70vh] min-h-[480px] overflow-hidden rounded-xl bg-photo-shell ring-1 ring-border"
        tabIndex={0}
        role="group"
        aria-label={`Photo slideshow, currently showing ${current.filename}. Use left and right arrow keys to navigate, space to play or pause.`}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") {
            e.preventDefault();
            goNext();
          } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            goPrev();
          } else if (e.key === " ") {
            e.preventDefault();
            setPlaying((p) => !p);
          }
        }}
      >
        <button
          className="absolute inset-0"
          onClick={() => setFullscreenOpen(true)}
          aria-label={`Open ${current.filename}`}
        >
          <img
            key={current.id}
            src={displaySrc(current, fallback)}
            alt={current.filename}
            onError={() => {
              if (!fallback) setFallback(true);
            }}
            className="zoom-settle h-full w-full object-contain"
          />
        </button>

        {items.length > 1 && (
          <>
            <button
              onClick={goPrev}
              aria-label="Previous"
              className="absolute left-3 top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded-full bg-overlay-control text-white backdrop-blur-md transition hover:bg-overlay-control-hover"
            >
              <ChevronLeft size={18} strokeWidth={2} />
            </button>
            <button
              onClick={goNext}
              aria-label="Next"
              className="absolute right-3 top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded-full bg-overlay-control text-white backdrop-blur-md transition hover:bg-overlay-control-hover"
            >
              <ChevronRight size={18} strokeWidth={2} />
            </button>
          </>
        )}

        <button
          onClick={() => setPlaying((p) => !p)}
          aria-label={playing ? "Pause" : "Play"}
          className="absolute right-3 bottom-3 grid size-8 place-items-center rounded-full bg-overlay-control text-white backdrop-blur-md transition hover:bg-overlay-control-hover"
        >
          {playing ? <Pause size={14} strokeWidth={2} /> : <Play size={14} strokeWidth={2} />}
        </button>

        {blurb && (
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-4 pb-3 pt-8">
            <p className="text-xs font-medium text-white/80">{blurb}</p>
          </div>
        )}
      </div>

      {fullscreenOpen && (
        <Viewer items={items} startIndex={index} onClose={() => setFullscreenOpen(false)} />
      )}
    </>
  );
}
