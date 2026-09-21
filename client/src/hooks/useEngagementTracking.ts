import { useEffect, useRef } from "react";
import { api } from "../api/client";

// Matches the spec's "meaningful amount of time" definition for a view.
const VIEW_DWELL_MS = 2000;

// Fires a "shown" event once per distinct photo displayed, and a "viewed"
// event only if it stays on screen for ~2s - never repeatedly while the same
// photo remains open. Used by the fullscreen Viewer and inline slideshows;
// never by grid/search thumbnails (those don't count as "shown").
export function useEngagementTracking(mediaId: number | undefined): void {
  const lastShownIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (mediaId === undefined) return;

    if (lastShownIdRef.current !== mediaId) {
      lastShownIdRef.current = mediaId;
      void api.media.markShown(mediaId).catch(() => {});
    }

    const timer = setTimeout(() => {
      void api.media.markViewed(mediaId).catch(() => {});
    }, VIEW_DWELL_MS);

    return () => clearTimeout(timer);
  }, [mediaId]);
}
