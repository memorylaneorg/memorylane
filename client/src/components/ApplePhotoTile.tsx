import type { AppleBrowseItemDto } from "@memorylane/shared";
import { api } from "../api/client";

export function ApplePhotoTile({ item, busy, onOpen, onOpenInPhotos, onCheckLocal, selected, onSelect }: {
  item: AppleBrowseItemDto;
  busy: boolean;
  onOpen: () => void;
  onOpenInPhotos: () => void;
  onCheckLocal: () => void;
  selected?: boolean;
  onSelect?: () => void;
}) {
  return <div className={`overflow-hidden rounded-lg bg-surface ring-1 ${selected ? "ring-2 ring-accent" : "ring-border"}`}>
    {item.media ? <button type="button" onClick={onSelect ?? onOpen} title={item.filename} aria-pressed={onSelect ? !!selected : undefined} className="aspect-square w-full bg-media">
      {item.media.thumbnailStatus === "done" ? <img src={api.media.thumbnailUrl(item.media.id, item.media.thumbnailVersion)} alt="" loading="lazy" className="h-full w-full object-cover" /> : <span>🖼</span>}
    </button> : <div className="flex aspect-square items-center justify-center bg-media text-center text-xs text-muted">Image not local</div>}
    <div className="space-y-2 p-2 text-xs"><p className="truncate text-ink" title={item.filename}>{item.filename}</p>
      {!item.available && <><button type="button" disabled={busy} onClick={onOpenInPhotos} className="block text-accent hover:underline">Open in Photos</button>
        <button type="button" disabled={busy} onClick={onCheckLocal} className="block text-accent hover:underline">Check for local copy</button></>}
    </div>
  </div>;
}
