import { useCallback, useEffect, useRef, useState } from "react";
import { Star } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AppleBrowseItemDto } from "@memorylane/shared";
import { api } from "../api/client";
import CollectionPicker from "./CollectionPicker";

export function ApplePhotoActions({ rootId, item, disabled = false, overlay = false }: {
  rootId: number;
  item: AppleBrowseItemDto;
  disabled?: boolean;
  overlay?: boolean;
}) {
  const { t } = useTranslation();
  const [favorite, setFavorite] = useState(item.media?.favorite ?? false);
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState("");
  const identity = useRef<Promise<number> | null>(null);
  useEffect(() => { setFavorite(item.media?.favorite ?? false); }, [item.media?.favorite]);
  useEffect(() => { if (item.available) setQueued(false); }, [item.available]);

  // Catalog selection creates identity only. Favorites/membership mutations below
  // are the explicit authorization for the server's preparation queue. Recheck
  // unavailable identities on each action: sync may have marked them missing.
  const resolveMediaId = useCallback(async () => {
    if (item.available && item.mediaId !== null) return item.mediaId;
    if (!identity.current) {
      identity.current = api.plugins.selectApplePhoto(rootId, item.uuid)
        .then(result => result.mediaId)
        .finally(() => { identity.current = null; });
    }
    return identity.current;
  }, [rootId, item.uuid, item.mediaId, item.available]);

  async function toggleFavorite() {
    if (busy || disabled) return;
    setBusy(true); setError("");
    try {
      const id = await resolveMediaId();
      const result = await api.media.setFavorite(id, !favorite);
      setFavorite(result.favorite);
      if (result.favorite && !item.available) setQueued(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }

  return <div className={overlay ? "absolute top-1.5 left-1.5" : "space-y-2"}>
    {!overlay && !item.available && <p className="text-muted">{t("applePreparation.selectionHint")}</p>}
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" disabled={disabled || busy} onClick={() => void toggleFavorite()}
        aria-label={t(favorite ? "viewer.unfavorite" : "viewer.favorite")}
        title={t(favorite ? "viewer.unfavorite" : "viewer.favorite")} aria-pressed={favorite}
        className={overlay ? `grid size-6 place-items-center rounded-full bg-black/50 backdrop-blur-sm transition disabled:opacity-50 ${favorite ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"}` : "grid h-10 w-10 place-items-center rounded-md border border-border text-ink disabled:opacity-50"}>
        <Star size={overlay ? 13 : 18} className={favorite ? "fill-amber-400 text-amber-400" : overlay ? "text-white" : ""} />
      </button>
      {!overlay && <CollectionPicker resolveMediaId={resolveMediaId} disabled={disabled || busy}
        onAdded={added => { if (added && !item.available) setQueued(true); }} />}
    </div>
    {queued && !overlay && <p role="status" className="text-muted">{t("applePreparation.queued")}</p>}
    {error && <p role="alert" className={overlay ? "mt-1 w-36 rounded bg-surface p-2 text-red-600" : "text-red-600"}>{error}</p>}
  </div>;
}
