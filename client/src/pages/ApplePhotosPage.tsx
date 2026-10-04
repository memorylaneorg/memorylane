import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { AppleBrowseDto, AppleBrowseItemDto, MediaDto } from "@memorylane/shared";
import { api } from "../api/client";
import { AppleBrowseCard } from "../components/AppleBrowseCard";
import { ApplePhotoTile } from "../components/ApplePhotoTile";
import CollectionPicker from "../components/CollectionPicker";
import Viewer from "../components/Viewer";
import { useConfirm } from "../components/ConfirmDialog";
import { useTranslation } from "react-i18next";
import { CheckSquare, MoreVertical } from "lucide-react";

const PAGE_SIZE = 100;
export default function ApplePhotosPage() {
  const { t, i18n } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const rootId = Number(id);
  const [params] = useSearchParams();
  const year = params.get("year") ?? undefined;
  const month = params.get("month") ?? undefined;
  const [result, setResult] = useState<AppleBrowseDto | null>(null);
  const [items, setItems] = useState<AppleBrowseItemDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewerItem, setViewerItem] = useState<MediaDto | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [moreOpen, setMoreOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const { confirm } = useConfirm();

  useEffect(() => {
    let current = true;
    setLoading(true);
    setResult(null);
    setItems([]);
    setError(null);
    setSelectedIds(new Set());
    setSelectMode(false);
    void api.plugins.browseApplePhotos(rootId, year, month, 0, PAGE_SIZE)
      .then((value) => { if (current) { setResult(value); setItems(value.items); } })
      .catch((cause: unknown) => { if (current) setError(cause instanceof Error ? cause.message : t("appleBrowse.loadFailed")); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [rootId, year, month, t, refresh]);

  const media = useMemo(() => items.flatMap((item) => item.media ? [item.media] : []), [items]);
  const rootUrl = `/apple-photos/${rootId}`;
  const openCatalogItem = async (item: AppleBrowseItemDto) => {
    setBusy(item.uuid); setError(null);
    try { await api.plugins.openCatalogItemInPhotos(rootId, item.uuid); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("appleBrowse.openFailed")); }
    finally { setBusy(null); }
  };
  const checkLocal = async (item: AppleBrowseItemDto) => {
    setBusy(item.uuid); setError(null);
    try {
      const status = await api.plugins.checkApplePhotoLocal(rootId, item.uuid);
      if (status.available) {
        const updated = await api.plugins.browseApplePhotos(rootId, year, month, 0, Math.max(items.length, PAGE_SIZE));
        setResult(updated); setItems(updated.items);
      } else setError(t("appleBrowse.noLocal"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("appleBrowse.checkFailed")); }
    finally { setBusy(null); }
  };
  const loadMore = async () => {
    if (!result || loading) return;
    setLoading(true);
    try {
      const next = await api.plugins.browseApplePhotos(rootId, year, month, items.length, PAGE_SIZE);
      setItems((prior) => [...prior, ...next.items]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("appleBrowse.moreFailed")); }
    finally { setLoading(false); }
  };

  const selectItems = async (targets: AppleBrowseItemDto[], toggle = false) => {
    setBusy("selection"); setError(null);
    try {
      const resolved: {uuid: string; id: number}[] = [];
      for (const item of targets) {
        const id = item.available && item.mediaId !== null ? item.mediaId : (await api.plugins.selectApplePhoto(rootId, item.uuid)).mediaId;
        resolved.push({uuid: item.uuid, id});
      }
      setItems(previous => previous.map(item => ({...item, mediaId: resolved.find(row => row.uuid === item.uuid)?.id ?? item.mediaId})));
      setSelectedIds(previous => {
        const next = new Set(previous);
        for (const {id} of resolved) { if (toggle && next.has(id)) next.delete(id); else next.add(id); }
        return next;
      });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally {setBusy(null);}
  };

  const markSelected = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const ok = await confirm({ title: t("appleBrowse.markTitle", { count: ids.length }),
      message: t("appleBrowse.markMessage"), confirmLabel: t("appleBrowse.mark"), danger: true });
    if (!ok) return;
    setError(null);
    try {
      for (let i = 0; i < ids.length; i += 200) await api.cleanup.mark(ids.slice(i, i + 200));
      const marked = new Set(ids);
      setItems((previous) => previous.filter((item) => item.mediaId === null || !marked.has(item.mediaId)));
      setResult((previous) => previous ? { ...previous, total: previous.total - ids.length } : previous);
      setSelectedIds(new Set());
      setSelectMode(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("appleBrowse.markFailed")); }
  };

  return <div className="flex flex-col gap-6">
    <nav className="flex flex-wrap gap-2 text-sm text-muted" aria-label={t("appleBrowse.breadcrumbs")}>
      <Link to="/" className="hover:text-ink">{t("navigation.library")}</Link><span>›</span>
      <Link to={rootUrl} className="hover:text-ink">{t("applePhotos.devicePhotos")}</Link>
      {year && <><span>›</span><Link to={`${rootUrl}?year=${year}`} className="hover:text-ink">{year === "all" ? t("appleBrowse.allPhotos") : year === "unknown" ? t("appleBrowse.unknownDate") : year}</Link></>}
      {month && <><span>›</span><span>{new Date(2000, Number(month) - 1, 1).toLocaleString(i18n.resolvedLanguage, { month: "long" })}</span></>}
    </nav>
    <div>
      <h1 className="font-serif text-3xl font-semibold text-ink">{month ? `${new Date(2000, Number(month) - 1, 1).toLocaleString(i18n.resolvedLanguage, { month: "long" })} ${year}` : year === "all" ? t("appleBrowse.allPhotos") : year === "unknown" ? t("appleBrowse.unknownDate") : year ?? t("applePhotos.devicePhotos")}</h1>
      {result && result.total > 0 && <p className="mt-1 text-sm text-muted">{t("appleBrowse.items", { count: result.total })}</p>}
    </div>
    <button type="button" disabled={loading} onClick={() => setRefresh(value => value + 1)} className="self-start rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50">{t("common.refresh")}</button>
    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    {items.length > 0 && <div className="flex flex-wrap items-center gap-2 text-sm">
      {!selectMode ? <div className="relative ml-auto"><button type="button" onClick={() => setMoreOpen(open => !open)} aria-label={t("coreBrowse.folder.more")} title={t("coreBrowse.folder.more")} className="grid size-8 place-items-center rounded-md text-muted hover:bg-hover hover:text-ink"><MoreVertical size={16}/></button>{moreOpen && <div className="absolute right-0 top-full z-20 mt-1 w-48 rounded-lg border border-border bg-surface py-1 shadow-card"><button type="button" onClick={() => { setSelectMode(true); setMoreOpen(false); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-muted hover:bg-hover hover:text-ink"><CheckSquare size={14}/>{t("appleBrowse.select")}</button></div>}</div> : <>
        <span>{t("appleBrowse.selected", { count: selectedIds.size })}</span>
        <button disabled={busy !== null} onClick={() => void selectItems(items.filter(item => item.mediaType !== "video" || item.mediaId !== null))} className="rounded-md border border-border px-3 py-1.5">{t("appleBrowse.selectShown", { count: items.filter(item => item.mediaType !== "video" || item.mediaId !== null).length })}</button>
        <button disabled={busy !== null} onClick={() => setSelectedIds(new Set())} className="rounded-md border border-border px-3 py-1.5">{t("appleBrowse.none")}</button>
        <button disabled={busy !== null} onClick={() => void selectItems(items.filter(item => item.mediaType !== "video" || item.mediaId !== null), true)} className="rounded-md border border-border px-3 py-1.5">{t("appleBrowse.invert")}</button>
        <CollectionPicker mediaIds={[...selectedIds]} disabled={busy !== null} />
        <button disabled={busy !== null || selectedIds.size === 0} onClick={() => void markSelected()} className="rounded-md border border-border px-3 py-1.5 disabled:opacity-40">{t("appleBrowse.mark")}</button>
        <button disabled={busy !== null} onClick={() => { setSelectMode(false); setSelectedIds(new Set()); }} className="rounded-md border border-border px-3 py-1.5">{t("common.cancel")}</button>
      </>}
    </div>}
    {!year && <Link to={`${rootUrl}?year=all`} className="w-fit rounded-md border border-border px-4 py-2 text-sm text-ink hover:bg-hover">{t("appleBrowse.allPhotos")}</Link>}
    {result && result.groups.length > 0 && <div className="grid grid-cols-2 gap-5 md:grid-cols-3 xl:grid-cols-4">
      {result.groups.map((group) => <AppleBrowseCard key={group.key}
        to={year ? `${rootUrl}?year=${year}&month=${group.key}` : `${rootUrl}?year=${group.key}`}
        title={group.key === "unknown" ? t("appleBrowse.unknownDate") : year ? new Date(2000, Number(group.key) - 1, 1).toLocaleString(i18n.resolvedLanguage, { month: "long" }) : group.key}
        previewRootId={rootId} previewYear={year ?? group.key} previewMonth={year ? group.key : undefined}
        count={group.count} coverMediaId={group.coverMediaId} thumbnailVersion={group.thumbnailVersion} />)}
    </div>}
    {items.some(item => !item.available) && <p className="text-sm text-muted">{t("applePreparation.selectionHint")}</p>}
    {items.length > 0 && <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
      {items.map((item) => <ApplePhotoTile key={item.uuid} rootId={rootId} item={item} busy={busy !== null}
        selected={item.mediaId !== null && selectedIds.has(item.mediaId)}
        onSelect={selectMode && (item.mediaType !== "video" || item.mediaId !== null) ? () => void selectItems([item], true) : undefined}
        onOpen={() => setViewerItem(item.media ?? null)} onOpenInPhotos={() => void openCatalogItem(item)}
        onCheckLocal={() => void checkLocal(item)} />)}
    </div>}
    {result && items.length < result.total && <button type="button" disabled={loading} onClick={() => void loadMore()} className="self-center rounded-md border border-border px-4 py-2 text-sm text-ink">{loading ? t("common.loading") : t("appleBrowse.loadMore")}</button>}
    {loading && !result && <p className="text-sm text-muted">{t("appleBrowse.loading")}</p>}
    {viewerItem && <Viewer items={media} startIndex={Math.max(0, media.findIndex((candidate) => candidate.id === viewerItem.id))} onClose={() => setViewerItem(null)} total={media.length} />}
  </div>;
}
