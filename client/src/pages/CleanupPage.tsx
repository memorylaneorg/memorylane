import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { CleanupMarkDto, MediaDto } from "@memorylane/shared";
import { api } from "../api/client";
import Viewer from "../components/Viewer";
import { useTranslation } from "react-i18next";
import { formatBytes } from "../utils/format";
import { useConfirm } from "../components/ConfirmDialog";

const PAGE_SIZE = 100;

export default function CleanupPage() {
  const { t } = useTranslation();
  const [items, setItems] = useState<CleanupMarkDto[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [working, setWorking] = useState(false);
  const { confirm } = useConfirm();
  const media: MediaDto[] = items.map((item) => item.media);

  useEffect(() => {
    void api.cleanup.marks(0, PAGE_SIZE).then((result) => { setItems(result.items); setTotal(result.total); })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : t("coreBrowse.cleanup.loadFailed")));
  }, [t]);

  const loadMore = async () => {
    try {
      const result = await api.cleanup.marks(items.length, PAGE_SIZE);
      setItems((previous) => [...previous, ...result.items]);
      setTotal(result.total);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("coreBrowse.cleanup.moreFailed")); }
  };

  const unmark = async (id: number) => {
    setBusy(id);
    try {
      await api.cleanup.unmark(id);
      setItems((previous) => previous.filter((item) => item.media.id !== id));
      setTotal((count) => count - 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("coreBrowse.cleanup.restoreItemFailed")); }
    finally { setBusy(null); }
  };

  const moveIds = async (ids: number[]) => {
    if (ids.length === 0) return;
    const bytes = items.filter((item) => ids.includes(item.media.id)).reduce((sum, item) => sum + item.media.fileSize, 0);
    const ok = await confirm({ title: t("coreBrowse.cleanup.moveTitle", { count: ids.length }),
      message: t("coreBrowse.cleanup.moveMessage", { size: formatBytes(bytes) }), confirmLabel: t("coreBrowse.cleanup.moveTrash"), danger: true });
    if (!ok) return;
    setWorking(true); setError(null);
    try {
      const outcomes = [];
      for (let i = 0; i < ids.length; i += 200) outcomes.push(...(await api.cleanup.moveToTrash(ids.slice(i, i + 200))).results);
      const moved = new Set(outcomes.filter((result) => result.ok).map((result) => result.mediaId));
      setItems((previous) => previous.map((item) => moved.has(item.media.id) ? { ...item, trashStatus: "trashed" } : item));
      setSelectedIds(new Set());
      const failures = outcomes.filter((result) => !result.ok);
      if (failures.length) setError(t("coreBrowse.cleanup.moveFailures", { count: failures.length, error: failures[0].error ?? t("coreBrowse.cleanup.unknownError") }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("coreBrowse.cleanup.moveFailed")); }
    finally { setWorking(false); }
  };

  const restoreFile = async (id: number) => {
    setBusy(id);
    try {
      await api.cleanup.restoreTrash(id);
      setItems((previous) => previous.filter((item) => item.media.id !== id));
      setTotal((count) => count - 1);
      setSelectedIds((previous) => { const next = new Set(previous); next.delete(id); return next; });
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("coreBrowse.cleanup.restoreFileFailed")); }
    finally { setBusy(null); }
  };

  const emptyFile = async (id: number) => {
    const item = items.find((entry) => entry.media.id === id);
    if (!item) return;
    const ok = await confirm({ title: t("coreBrowse.cleanup.deleteTitle", { filename: item.media.filename }),
      message: t("coreBrowse.cleanup.deleteMessage", { size: formatBytes(item.media.fileSize) }), confirmLabel: t("coreBrowse.cleanup.deletePermanently"), danger: true });
    if (!ok) return;
    setBusy(id);
    try {
      await api.cleanup.emptyTrash(id);
      setItems((previous) => previous.filter((entry) => entry.media.id !== id));
      setTotal((count) => count - 1);
      setSelectedIds((previous) => { const next = new Set(previous); next.delete(id); return next; });
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("coreBrowse.cleanup.deleteFailed")); }
    finally { setBusy(null); }
  };

  const selectedMoveIds = [...selectedIds].filter((id) => items.some((item) => item.media.id === id && item.media.sourceKind !== "apple-photos" && item.trashStatus === null));

  return <div className="flex flex-col gap-5">
    <div><h1 className="font-serif text-3xl font-semibold text-ink">{t("pages.cleanup")}</h1>
      <p className="text-sm text-muted">{t("coreBrowse.cleanup.summary", { count: total })}</p></div>
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    {items.some((item) => item.media.sourceKind !== "apple-photos" && item.trashStatus === null) && <div className="flex flex-wrap items-center gap-2 text-sm">
      <button onClick={() => setSelectedIds(new Set(items.filter((item) => item.media.sourceKind !== "apple-photos" && item.trashStatus === null).map((item) => item.media.id)))} className="rounded-md border border-border px-3 py-1.5">{t("coreBrowse.cleanup.selectShown")}</button>
      <button onClick={() => setSelectedIds(new Set())} className="rounded-md border border-border px-3 py-1.5">{t("appleBrowse.none")}</button>
      <button disabled={selectedMoveIds.length === 0 || working} onClick={() => void moveIds(selectedMoveIds)} className="rounded-md border border-border px-3 py-1.5 disabled:opacity-40">{t("coreBrowse.cleanup.moveSelected", { count: selectedMoveIds.length })}</button>
    </div>}
    {items.length === 0 && <div className="rounded-xl border border-dashed border-border-strong bg-surface p-6">
      <h2 className="font-medium text-ink">{t("coreBrowse.cleanup.emptyTitle")}</h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">{t("coreBrowse.cleanup.emptyHelp")}</p>
      <Link to="/" className="mt-4 inline-flex rounded-md bg-accent px-4 py-2 text-sm font-medium text-page">{t("coreBrowse.cleanup.browse")}</Link>
    </div>}
    {items.length > 0 && <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{items.map((item, index) => <article key={item.media.id} className="overflow-hidden rounded-lg border border-border bg-surface">
      <button onClick={() => item.media.status === "active" && item.trashStatus === null && setViewerIndex(index)} disabled={item.media.status !== "active" || item.trashStatus !== null} className="aspect-square w-full bg-media disabled:cursor-default">
        {item.media.thumbnailStatus === "done" ? <img src={api.media.thumbnailUrl(item.media.id, item.media.thumbnailVersion)} alt={item.media.filename} loading="lazy" className="h-full w-full object-cover" /> : <span className="text-sm text-muted">{t("coreBrowse.cleanup.previewUnavailable")}</span>}
      </button>
      <div className="flex flex-col gap-1 p-3 text-xs">
        <strong className="truncate text-ink" title={item.media.absolutePath}>{item.media.filename}</strong>
        <span className="truncate text-muted" title={item.media.absolutePath}>{item.media.sourceKind === "apple-photos" ? "Apple Photos" : item.media.absolutePath}</span>
        <span className="text-muted">{t("coreBrowse.cleanup.marked", { size: formatBytes(item.media.fileSize), date: new Date(item.markedAt).toLocaleDateString() })}</span>
        {item.trashStatus && <span className="text-muted">{t(item.trashStatus === "trashed" ? "coreBrowse.cleanup.inTrash" : "coreBrowse.cleanup.interrupted")}</span>}
        {item.media.status !== "active" && <span className="text-muted">{t("coreBrowse.cleanup.originalUnavailable")}</span>}
        {item.media.sourceKind !== "apple-photos" && item.trashStatus === null && <label className="mt-1 flex items-center gap-2 text-ink"><input type="checkbox" checked={selectedIds.has(item.media.id)} onChange={() => setSelectedIds((previous) => { const next = new Set(previous); if (next.has(item.media.id)) next.delete(item.media.id); else next.add(item.media.id); return next; })} /> {t("coreBrowse.cleanup.selectTrash")}</label>}
      <span className="mt-2 flex flex-wrap gap-3">
        {item.media.sourceKind === "apple-photos" && <button onClick={() => void api.plugins.openInPhotos(item.media.id).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : t("appleBrowse.openFailed")))} className="text-accent underline">{t("common.openPhotos")}</button>}
        {item.trashStatus === null && <button disabled={busy === item.media.id} onClick={() => void unmark(item.media.id)} className="text-accent underline">{t("coreBrowse.cleanup.restoreLibrary")}</button>}
        {item.media.sourceKind !== "apple-photos" && item.trashStatus === null && <button disabled={working} onClick={() => void moveIds([item.media.id])} className="text-accent underline">{t("coreBrowse.cleanup.moveTrash")}</button>}
        {item.trashStatus && <button disabled={busy === item.media.id} onClick={() => void restoreFile(item.media.id)} className="text-accent underline">{t("coreBrowse.cleanup.restoreFiles")}</button>}
        {item.trashStatus === "trashed" && <button disabled={busy === item.media.id} onClick={() => void emptyFile(item.media.id)} className="text-red-600 underline">{t("coreBrowse.cleanup.deletePermanently")}</button>}
      </span>
      </div>
    </article>)}</div>}
    {items.length < total && <button onClick={() => void loadMore()} className="self-center rounded-md border border-border px-4 py-2 text-sm">{t("appleBrowse.loadMore")}</button>}
    {viewerIndex !== null && <Viewer items={media} startIndex={viewerIndex} total={media.length} onClose={() => setViewerIndex(null)} />}
  </div>;
}
