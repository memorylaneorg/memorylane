import { useState } from "react";
import { Check, Layers, Star } from "lucide-react";
import type { MediaDto } from "@memorylane/shared";
import { api } from "../api/client";
import { formatDuration } from "../utils/format";
import { useTranslation } from "react-i18next";

interface MediaGridProps {
  items: MediaDto[];
  onOpen: (index: number) => void;
  // Stack badge click on a cover tile (folder grids collapse stacks to their cover).
  onOpenStack?: (media: MediaDto) => void;
  // Selection mode: tile clicks toggle selection instead of opening the viewer.
  selectable?: boolean;
  selectedIds?: Set<number>;
  onToggleSelect?: (media: MediaDto) => void;
  // Small text chip per tile (e.g. a similarity score) keyed by media id.
  captions?: Record<number, string>;
}

function badgeFor(media: MediaDto): string | null {
  if (media.mediaType === "video") {
    return media.durationSeconds != null ? formatDuration(media.durationSeconds) : "▶";
  }
  if (media.livePhotoVideoId != null) return "LIVE";
  if (media.rawPairId != null) return "RAW+JPEG";
  if (media.mediaType === "raw") return "RAW";
  if (media.thumbnailStatus === "unsupported" || media.thumbnailStatus === "failed") return "!";
  return null;
}

// A standard row-major grid (not CSS-columns masonry): masonry packs items
// column-by-column, so sequential/chronological photos in a folder would
// read down the first column before continuing in the second - confusing
// for browsing. A uniform grid reads left-to-right, top-to-bottom like every
// other photo browser. Keeps the small rounded corners, border ring, and
// hover lift/zoom from the life-archive-app-inspired styling.
export default function MediaGrid({ items, onOpen, onOpenStack, selectable = false, selectedIds, onToggleSelect, captions }: MediaGridProps) {
  const { t } = useTranslation();
  // Optimistic per-thumbnail favorite overrides - `items` is an external prop
  // that won't reflect a toggle until the parent refetches, so track it locally.
  const [favoriteOverrides, setFavoriteOverrides] = useState<Record<number, boolean>>({});

  const toggleFavorite = async (media: MediaDto) => {
    const next = !(favoriteOverrides[media.id] ?? media.favorite);
    setFavoriteOverrides((prev) => ({ ...prev, [media.id]: next }));
    try {
      await api.media.setFavorite(media.id, next);
    } catch {
      setFavoriteOverrides((prev) => ({ ...prev, [media.id]: !next }));
    }
  };

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
      {items.map((media, i) => {
        const badge = badgeFor(media);
        const hasThumbnail = media.thumbnailStatus === "done";
        const isFavorite = favoriteOverrides[media.id] ?? media.favorite;
        const isSelected = selectable && !!selectedIds?.has(media.id);
        const stackCount = media.stack?.isCover ? media.stack.count : null;
        return (
          <button
            key={media.id}
            onClick={() => (selectable ? onToggleSelect?.(media) : onOpen(i))}
            title={media.filename}
            aria-pressed={selectable ? isSelected : undefined}
            className={`group relative aspect-square overflow-hidden rounded-[8px] bg-media text-left shadow-media transition hover:-translate-y-0.5 hover:shadow-media-hover ${
              isSelected ? "ring-2 ring-accent" : "ring-1 ring-border"
            }`}
          >
            {hasThumbnail ? (
              <img
                src={api.media.thumbnailUrl(media.id, media.thumbnailVersion)}
                alt=""
                loading="lazy"
                className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.018]"
              />
            ) : (
              <div className="flex h-full items-center justify-center text-2xl text-ink opacity-40">
                {media.mediaType === "video" ? "🎬" : "🖼"}
              </div>
            )}
            {badge && (
              <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[11px] text-white">
                {badge}
              </span>
            )}
            {stackCount !== null && onOpenStack && (
              <span
                role="button"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenStack(media);
                }}
                title={t("common.stackExpand", { count: stackCount })}
                aria-label={t("common.stackLabel", { count: stackCount })}
                className="absolute top-1.5 right-1.5 flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white hover:bg-black/85"
              >
                <Layers size={11} strokeWidth={2} />
                {stackCount}
              </span>
            )}
            {stackCount !== null && !onOpenStack && (
              // Inside an expanded stack there's nothing to expand - the badge
              // just marks which member is the cover.
              <span className="absolute top-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white">
                {t("common.cover")}
              </span>
            )}
            {captions?.[media.id] && !selectable && (
              <span className="absolute bottom-1.5 left-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[11px] tabular-nums text-white">
                {captions[media.id]}
              </span>
            )}
            {selectable && (
              <span
                aria-hidden
                className={`absolute bottom-1.5 left-1.5 grid size-6 place-items-center rounded-full ${
                  isSelected ? "bg-accent text-page" : "bg-black/50 text-white/80"
                }`}
              >
                <Check size={13} strokeWidth={2.5} />
              </span>
            )}
            <span
              role="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                void toggleFavorite(media);
              }}
              aria-label={isFavorite ? t("viewer.unfavorite") : t("viewer.favorite")}
              className={`absolute top-1.5 left-1.5 grid size-6 place-items-center rounded-full bg-black/50 backdrop-blur-sm transition ${
                isFavorite ? "opacity-100" : "opacity-0 group-hover:opacity-100"
              }`}
            >
              <Star size={13} strokeWidth={2} className={isFavorite ? "fill-amber-400 text-amber-400" : "text-white"} />
            </span>
          </button>
        );
      })}
    </div>
  );
}
