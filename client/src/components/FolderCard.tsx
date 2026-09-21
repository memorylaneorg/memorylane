import { useCallback } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import type { FolderDto } from "@memorylane/shared";
import { api } from "../api/client";
import { formatBytes } from "../utils/format";
import { useHoverPreview } from "../hooks/useHoverPreview";

// Every folder card reads the same way - whole-subtree item count and size -
// whether it's a top-level "Your Library" card, a subfolder you've browsed
// into, or a search result. See FolderDto.recursiveMediaCount.
function summaryFor(folder: FolderDto): string {
  if (folder.recursiveMediaCount === 0) return "Empty";
  const size = folder.recursiveSizeBytes ? ` · ${formatBytes(folder.recursiveSizeBytes)}` : "";
  return `${folder.recursiveMediaCount.toLocaleString()} items${size}`;
}

// Mirrors life-archive-app's AlbumCard.tsx: cover image with a title overlaid
// in a bottom gradient, hover lift + zoom, and a footer row with the item
// count on one side and an arrow link on the other.
export default function FolderCard({ folder }: { folder: FolderDto }) {
  const load = useCallback(() => api.folders.preview(folder.id).then((result) => result.items), [folder.id]);
  const { frame, onMouseEnter, onMouseLeave } = useHoverPreview(
    folder.thumbnailMediaId === null ? null : { id: folder.thumbnailMediaId, thumbnailVersion: folder.thumbnailVersion }, load,
  );
  const display = frame ?? (folder.thumbnailMediaId === null ? null : { id: folder.thumbnailMediaId, thumbnailVersion: folder.thumbnailVersion });
  return (
    <Link
      to={`/folder/${folder.id}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="group block cursor-pointer overflow-hidden rounded-xl bg-surface ring-1 ring-border transition hover:-translate-y-0.5 hover:shadow-xl"
    >
      <div className="relative aspect-[4/3] overflow-hidden bg-media">
        {display ? (
          <img
            src={api.media.thumbnailUrl(display.id, display.thumbnailVersion)}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-3xl opacity-40">📁</div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-black/10 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 p-4">
          <div className="truncate font-serif text-2xl font-semibold text-white">{folder.name}</div>
        </div>
      </div>

      <div className="flex items-center justify-between p-4">
        <span className="text-sm text-muted">{summaryFor(folder)}</span>
        <span className="inline-flex items-center gap-2 text-sm font-medium text-ink">
          Open
          <ArrowRight size={15} strokeWidth={1.8} className="transition group-hover:translate-x-0.5" />
        </span>
      </div>
    </Link>
  );
}
