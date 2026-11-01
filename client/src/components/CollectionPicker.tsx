import { useEffect, useState } from "react";
import { BookmarkPlus, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CollectionDto } from "@memorylane/shared";
import { api } from "../api/client";

const control = "rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-ink disabled:opacity-50";

export default function CollectionPicker({ mediaIds, folderId, onAdded, resolveMediaId, disabled = false, iconOnly = false, menuItem = false }: {
  mediaIds?: number[];
  folderId?: number;
  onAdded?: (added?: boolean) => void;
  resolveMediaId?: () => Promise<number>;
  disabled?: boolean;
  iconOnly?: boolean;
  menuItem?: boolean;
}) {
  const { t } = useTranslation();
  const [resolvedId, setResolvedId] = useState<number>();
  const inputId = folderId === undefined && mediaIds?.length === 1 ? mediaIds[0] : undefined;
  const singleId = inputId ?? (resolveMediaId ? resolvedId : undefined);
  const [open, setOpen] = useState(false);
  const [collections, setCollections] = useState<CollectionDto[]>([]);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [recursive, setRecursive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setCollections([]);
    setResolvedId(undefined);
    setError("");
    void (async () => {
      const mediaId = inputId ?? (resolveMediaId ? await resolveMediaId() : undefined);
      if (!active) return;
      setResolvedId(mediaId);
      const rows = await api.collections.list(mediaId);
      if (active) setCollections(rows.filter((collection) => !collection.builtin));
    })().catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [open, inputId, resolveMediaId]);

  async function toggle(collection: CollectionDto) {
    if (singleId === undefined || typeof collection.id !== "number" || busy || loading || disabled) return;
    setBusy(true);
    setError("");
    try {
      if (collection.contains) await api.collections.remove(collection.id, [singleId]);
      else await api.collections.add(collection.id, { mediaIds: [singleId] });
      setCollections((rows) => rows.map((row) => row.id === collection.id ? { ...row, contains: !row.contains } : row));
      onAdded?.(!collection.contains);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function createAndAdd(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || busy || loading || disabled || (resolveMediaId && singleId === undefined)) return;
    setBusy(true);
    setError("");
    try {
      const created = await api.collections.create(name);
      if (singleId !== undefined) await api.collections.add(Number(created.id), { mediaIds: [singleId] });
      setCollections((rows) => [...rows, { ...created, contains: singleId !== undefined }]);
      setName("");
      onAdded?.(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      let collectionId = Number(id);
      if (!id) {
        const created = await api.collections.create(name);
        collectionId = Number(created.id);
        setCollections((rows) => [...rows, created]);
        setId(String(collectionId));
        setName("");
      }
      const result = await api.collections.add(collectionId, folderId !== undefined ? { folderId, recursive } : { mediaIds: mediaIds ?? [] });
      setMessage(t("collections.added", { count: result.added }));
      setOpen(false);
      onAdded?.(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const label = t(folderId === undefined ? "collections.addTo" : "collections.addFolder");
  return (
    <div className={`${resolveMediaId ? "w-full min-w-0 " : ""}relative text-sm`} onKeyDown={(event) => event.stopPropagation()}>
      <button
        type="button"
        className={iconOnly
          ? "grid h-12 w-12 place-items-center rounded-full bg-overlay-control text-white hover:bg-overlay-control-hover disabled:opacity-50"
          : menuItem
            ? "flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-sm text-muted hover:bg-hover hover:text-ink disabled:opacity-50"
            : control}
        disabled={disabled || busy || (folderId === undefined && !mediaIds?.length && !resolveMediaId)}
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => { setOpen(!open); setMessage(""); }}
      >
        {iconOnly ? <BookmarkPlus size={21} strokeWidth={1.8} /> : <>{menuItem && <BookmarkPlus size={14} strokeWidth={1.8} />}{label}</>}
      </button>
      {message && <p role="status" className="mt-1 text-muted">{message}</p>}
      {open && (singleId !== undefined || resolveMediaId) && (
        <div className={`${resolveMediaId ? "mt-2 w-full" : "absolute right-0 top-full z-50 mt-2 w-72"} rounded-lg border border-border bg-surface p-3 text-ink shadow-card`}>
          <p className="mb-2 font-medium">{t("collections.addTo")}</p>
          {loading && <p className="text-muted">{t("common.loading")}</p>}
          {!loading && <div className="max-h-56 space-y-1 overflow-y-auto">
            {collections.map((collection) => (
              <button key={collection.id} type="button" disabled={disabled || busy || loading} onClick={() => void toggle(collection)} className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left hover:bg-hover disabled:opacity-50">
                <span className="truncate">{collection.name}</span>
                {collection.contains && <Check size={16} className="text-accent" />}
              </button>
            ))}
          </div>}
          <form className="mt-3 flex gap-2 border-t border-border pt-3" onSubmit={(event) => void createAndAdd(event)}>
            <input className={`${control} min-w-0 flex-1`} value={name} maxLength={80} placeholder={t("collections.new")} onChange={(event) => setName(event.target.value)} />
            <button className={control} disabled={disabled || busy || loading || singleId === undefined || !name.trim()}>{t("common.add")}</button>
          </form>
          {error && <p role="alert" className="mt-2 text-red-600">{error}</p>}
        </div>
      )}
      {open && singleId === undefined && !resolveMediaId && (
        <form onSubmit={(event) => void add(event)} className="absolute right-0 top-full z-50 mt-2 flex w-80 flex-col gap-2 rounded-lg border border-border bg-surface p-3 text-ink shadow-card">
          <label>{t("collections.destination")}<select className={`${control} mt-1 w-full`} disabled={busy || loading} value={id} onChange={(event) => setId(event.target.value)}><option value="">{t("collections.new")}</option>{collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}</select></label>
          {!id && <label>{t("collections.name")}<input className={`${control} mt-1 w-full`} disabled={busy} required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label>}
          {folderId !== undefined && <><label className="flex items-center gap-2"><input type="checkbox" checked={recursive} disabled={busy} onChange={(event) => setRecursive(event.target.checked)} />{t("collections.recursive")}</label><p className="text-muted">{t("collections.snapshot")}</p></>}
          {error && <p role="alert" className="text-red-600">{error}</p>}
          <div className="flex gap-2"><button className={control} disabled={busy || loading || (!id && !name.trim())}>{t(busy ? "common.loading" : "common.add")}</button><button type="button" className={control} disabled={busy} onClick={() => setOpen(false)}>{t("common.cancel")}</button></div>
        </form>
      )}
    </div>
  );
}
