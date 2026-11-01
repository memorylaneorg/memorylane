import { Check, Cloud } from "lucide-react";
import { ApplePhotoActions } from "./ApplePhotoActions";
import type { AppleBrowseItemDto } from "@memorylane/shared";
import { api } from "../api/client";
import { useTranslation } from "react-i18next";

export function ApplePhotoTile({ rootId, item, busy, onOpen, onOpenInPhotos, onCheckLocal, selected, onSelect }: {
  rootId?: number;
  item: AppleBrowseItemDto;
  busy: boolean;
  onOpen: () => void;
  onOpenInPhotos: () => void;
  onCheckLocal: () => void;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const { t } = useTranslation();
  const kind = item.mediaType ?? item.media?.mediaType;
  const isStill = kind === "image" || kind === "raw";
  return <div className={`group relative aspect-square rounded-[8px] bg-media shadow-media transition hover:-translate-y-0.5 hover:shadow-media-hover ${selected ? "ring-2 ring-accent" : "ring-1 ring-border"}`}>
    <button type="button" disabled={busy} onClick={onSelect ?? (item.available ? onOpen : onOpenInPhotos)} title={item.available || onSelect ? item.filename : t("common.openPhotos")} aria-label={item.available || onSelect ? item.filename : t("common.openPhotos")} aria-pressed={onSelect ? !!selected : undefined} className="h-full w-full overflow-hidden rounded-[8px] text-left">
      {item.media?.thumbnailStatus === "done" ? <img src={api.media.thumbnailUrl(item.media.id, item.media.thumbnailVersion)} alt="" loading="lazy" className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.018]" /> : <span className="flex h-full flex-col items-center justify-center gap-2 text-xs text-muted"><Cloud size={24}/>{t("applePhotos.imageNotLocal")}</span>}
    </button>
    {!onSelect && rootId !== undefined && isStill && <ApplePhotoActions key={`${rootId}:${item.uuid}`} rootId={rootId} item={item} disabled={busy} overlay />}
    {onSelect && <span aria-hidden className={`pointer-events-none absolute bottom-1.5 left-1.5 grid size-6 place-items-center rounded-full ${selected ? "bg-accent text-page" : "bg-black/50 text-white/80"}`}><Check size={13} strokeWidth={2.5}/></span>}
    {!item.available && !onSelect && <button type="button" disabled={busy} onClick={onCheckLocal} title={t("applePhotos.checkLocal")} aria-label={t("applePhotos.checkLocal")} className="absolute bottom-1.5 right-1.5 rounded bg-black/70 p-1 text-white"><Cloud size={14}/></button>}
  </div>;
}
