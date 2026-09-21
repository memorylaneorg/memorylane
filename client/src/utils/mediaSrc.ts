import type { MediaDto } from "@memorylane/shared";
import { api } from "../api/client";

// RAW files can't be decoded by the browser, so they never use the original
// bytes - use the larger RAW preview (see server PREVIEW_LONG_EDGE) instead
// of the small grid thumbnail, falling back to that thumbnail only if no
// preview exists yet (e.g. scanned before this tier existed, pending rescan).
// Shared by every full-size photo display (fullscreen Viewer, inline
// slideshows) so they all get sharp, non-thumbnail images consistently.
export function displaySrc(media: MediaDto, useFallback: boolean): string {
  if (useFallback) return api.media.thumbnailUrl(media.id, media.thumbnailVersion);
  if (media.mediaType === "raw") return api.media.previewUrl(media.id, media.thumbnailVersion);
  return api.media.fileUrl(media.id);
}
