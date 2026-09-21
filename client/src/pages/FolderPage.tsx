import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { CheckSquare, EyeOff, Layers, MoreVertical } from "lucide-react";
import type { FolderDto, FolderBreadcrumbDto, MediaDto, MediaTypeFilter as MediaTypeFilterValue } from "@memorylane/shared";
import { api } from "../api/client";
import Breadcrumbs from "../components/Breadcrumbs";
import FolderCard from "../components/FolderCard";
import MediaGrid from "../components/MediaGrid";
import MediaTypeFilter from "../components/MediaTypeFilter";
import Viewer from "../components/Viewer";
import StackPanel from "../components/StackPanel";
import { useConfirm } from "../components/ConfirmDialog";
import { useInfiniteScroll } from "../hooks/useInfiniteScroll";
import { invertVisibleSelection } from "../utils/selection";
import { useTranslation } from "react-i18next";

const PAGE_SIZE = 200;

export default function FolderPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const folderId = Number(id);
  const navigate = useNavigate();

  const [folder, setFolder] = useState<FolderDto | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<FolderBreadcrumbDto[]>([]);
  const [children, setChildren] = useState<FolderDto[]>([]);
  const [media, setMedia] = useState<MediaDto[]>([]);
  const [mediaTotal, setMediaTotal] = useState(0);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  // "All files" flattens every subfolder's media into one list, instead of
  // showing only this folder's direct children/media.
  const [showAllFiles, setShowAllFiles] = useState(false);
  const [mediaType, setMediaType] = useState<MediaTypeFilterValue>("all");
  const [loadingMore, setLoadingMore] = useState(false);
  const [ignoring, setIgnoring] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [openStackId, setOpenStackId] = useState<number | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [stackError, setStackError] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);
  const { confirm } = useConfirm();
  const loadingMoreRef = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [menuOpen]);

  const loadMedia = useCallback(
    async (recursive: boolean, type: MediaTypeFilterValue) => {
      const res = await api.folders.media(folderId, 0, PAGE_SIZE, recursive, type);
      setMedia(res.items);
      setMediaTotal(res.total);
    },
    [folderId],
  );

  const load = useCallback(async () => {
    const [detail, childrenRes] = await Promise.all([
      api.folders.get(folderId),
      api.folders.children(folderId, 0, 500),
    ]);
    setFolder(detail.folder);
    setBreadcrumbs(detail.breadcrumbs);
    setChildren(childrenRes.items);
    await loadMedia(false, "all");
  }, [folderId, loadMedia]);

  // Reset to the normal (non-flattened) view and reload whenever navigating to a different folder.
  useEffect(() => {
    setShowAllFiles(false);
    setMediaType("all");
    setSelectMode(false);
    setSelectedIds(new Set());
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId]);

  const toggleAllFiles = async (checked: boolean) => {
    setSelectedIds(new Set());
    setShowAllFiles(checked);
    await loadMedia(checked, mediaType);
  };

  const changeMediaType = async (type: MediaTypeFilterValue) => {
    setSelectedIds(new Set());
    setMediaType(type);
    await loadMedia(showAllFiles, type);
  };

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const res = await api.folders.media(folderId, media.length, PAGE_SIZE, showAllFiles, mediaType);
      setMedia((prev) => [...prev, ...res.items]);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [folderId, media.length, showAllFiles, mediaType]);

  const hasMore = media.length < mediaTotal;
  const sentinelRef = useInfiniteScroll(loadMore, hasMore, loadingMore);

  // Stacks: the grid collapses each burst to its cover; the panel expands
  // one, and selection mode lets the user build a stack by hand.
  const refreshMedia = useCallback(() => void loadMedia(showAllFiles, mediaType), [loadMedia, showAllFiles, mediaType]);

  const toggleSelect = (m: MediaDto) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(m.id)) next.delete(m.id);
      else next.add(m.id);
      return next;
    });

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
    setStackError(null);
  };

  const stackSelected = async () => {
    setStackError(null);
    try {
      await api.stacks.create([...selectedIds]);
      exitSelectMode();
      refreshMedia();
    } catch (err) {
      setStackError(err instanceof Error ? err.message : t("coreBrowse.folder.stackFailed"));
    }
  };

  const markSelected = async () => {
    const ids = [...selectedIds].filter((id) => media.some((item) => item.id === id));
    if (ids.length === 0) return;
    const ok = await confirm({ title: t("coreBrowse.folder.markTitle", { count: ids.length }),
      message: t("coreBrowse.folder.markMessage"), confirmLabel: t("coreBrowse.folder.mark"), danger: true });
    if (!ok) return;
    setMarking(true);
    setStackError(null);
    try {
      for (let i = 0; i < ids.length; i += 200) await api.cleanup.mark(ids.slice(i, i + 200));
      exitSelectMode();
      refreshMedia();
    } catch (err) { setStackError(err instanceof Error ? err.message : t("coreBrowse.folder.markFailed")); }
    finally { setMarking(false); }
  };

  const ignoreFolder = async () => {
    if (!folder) return;
    setMenuOpen(false);
    const itemsPhrase = folder.recursiveMediaCount > 0 ? t("coreBrowse.folder.indexedItems", { count: folder.recursiveMediaCount }) : "";
    const ok = await confirm({
      title: t("coreBrowse.folder.ignoreTitle", { name: folder.name }),
      message: t("coreBrowse.folder.ignoreMessage", { items: itemsPhrase }),
      confirmLabel: t("coreBrowse.folder.ignore"),
      danger: true,
    });
    if (!ok) {
      return;
    }
    setIgnoring(true);
    try {
      const result = await api.folders.ignore(folder.id);
      navigate(result.parentFolderId ? `/folder/${result.parentFolderId}` : "/");
    } finally {
      setIgnoring(false);
    }
  };

  if (!folder) return <p className="text-sm text-muted">{t("common.loading")}</p>;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Breadcrumbs items={breadcrumbs} />
        <div className={selectMode ? "flex flex-col items-stretch gap-4" : "flex flex-wrap items-center justify-between gap-4"}>
          <h1 className="min-w-0 break-words font-serif text-2xl font-semibold text-ink">{folder.name}</h1>
          <div className={selectMode ? "flex w-full flex-wrap items-center gap-2 rounded-xl border border-border bg-surface p-3" : "flex flex-wrap items-center justify-end gap-3"}>
            {selectMode ? (
              <div className="flex flex-1 flex-wrap items-center gap-2 text-sm">
                <span className="mr-1 whitespace-nowrap font-medium text-ink"><span className="mr-1 inline-flex min-w-7 justify-center rounded-full bg-accent px-2 py-0.5 text-page">{selectedIds.size}</span> {t("coreBrowse.folder.selected")}</span>
                <button onClick={() => setSelectedIds(new Set(media.map((m) => m.id)))} title={t("coreBrowse.folder.selectShownTitle", { count: media.length })} className="whitespace-nowrap rounded-md border border-border px-3 py-1.5 text-ink hover:bg-hover">{t("coreBrowse.folder.allShown")}</button>
                <button onClick={() => setSelectedIds(new Set())} className="whitespace-nowrap rounded-md border border-border px-3 py-1.5 text-ink hover:bg-hover">{t("coreBrowse.folder.clear")}</button>
                <button onClick={() => setSelectedIds(invertVisibleSelection(media.map((m) => m.id), selectedIds))} className="whitespace-nowrap rounded-md border border-border px-3 py-1.5 text-ink hover:bg-hover">{t("coreBrowse.folder.invert")}</button>
                <button onClick={() => void markSelected()} disabled={selectedIds.size === 0 || marking} className="whitespace-nowrap rounded-md border border-red-500/30 px-3 py-1.5 text-red-600 hover:bg-red-500/10 disabled:opacity-40">{marking ? t("coreBrowse.folder.marking") : t("coreBrowse.folder.mark")}</button>
                <button
                  onClick={() => void stackSelected()}
                  disabled={selectedIds.size < 2}
                  className="flex items-center gap-1.5 whitespace-nowrap rounded-md bg-accent px-3 py-1.5 text-page hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Layers size={14} strokeWidth={1.8} />
                  {t("coreBrowse.folder.stackSelected")}
                </button>
                <button onClick={exitSelectMode} className="whitespace-nowrap rounded-md border border-border px-3 py-1.5 text-ink hover:bg-hover">
                  {t("coreBrowse.folder.done")}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setSelectMode(true)}
                title={t("coreBrowse.folder.selectHelp")}
                className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-ink hover:bg-hover"
              >
                <CheckSquare size={14} strokeWidth={1.8} />
                {t("coreBrowse.folder.select")}
              </button>
            )}
            {!selectMode && <>
            <MediaTypeFilter value={mediaType} onChange={(t) => void changeMediaType(t)} />
            <label className="flex cursor-pointer items-center gap-2 whitespace-nowrap text-sm text-muted">
              <input
                type="checkbox"
                checked={showAllFiles}
                onChange={(e) => void toggleAllFiles(e.target.checked)}
                className="cursor-pointer accent-accent"
              />
              {t("coreBrowse.folder.allFiles")}
            </label>
            <div ref={menuRef} className="relative">
              <button
                onClick={() => setMenuOpen((v) => !v)}
                aria-label={t("coreBrowse.folder.more")}
                title={t("coreBrowse.folder.more")}
                className="grid size-8 place-items-center rounded-md text-muted hover:bg-hover hover:text-ink"
              >
                <MoreVertical size={16} strokeWidth={1.8} />
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-full z-10 mt-1 w-56 rounded-lg border border-border bg-surface py-1 shadow-card">
                  <button
                    onClick={() => void ignoreFolder()}
                    disabled={ignoring}
                    className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-sm text-muted hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <EyeOff size={14} strokeWidth={1.8} />
                    {ignoring ? t("coreBrowse.folder.ignoring") : t("coreBrowse.folder.ignore")}
                  </button>
                </div>
              )}
            </div>
            </>}
          </div>
        </div>
      </div>

      {!showAllFiles && children.length > 0 && (
        <div className="grid grid-cols-2 gap-5 md:grid-cols-3 xl:grid-cols-4">
          {children.map((c) => (
            <FolderCard key={c.id} folder={c} />
          ))}
        </div>
      )}

      {stackError && <p className="text-sm text-red-600">{stackError}</p>}

      {media.length > 0 && (
        <MediaGrid
          items={media}
          onOpen={setViewerIndex}
          onOpenStack={(m) => m.stack && setOpenStackId(m.stack.id)}
          selectable={selectMode}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
        />
      )}

      {openStackId !== null && <StackPanel stackId={openStackId} onClose={() => setOpenStackId(null)} onChanged={refreshMedia} />}

      {!showAllFiles && children.length === 0 && media.length === 0 && (
        <p className="text-sm text-muted">
          {mediaType === "all" ? t("coreBrowse.folder.empty") : t(mediaType === "photo" ? "coreBrowse.folder.noPhotos" : "coreBrowse.folder.noVideos")}
        </p>
      )}
      {showAllFiles && media.length === 0 && (
        <p className="text-sm text-muted">
          {mediaType === "all"
            ? t("coreBrowse.folder.noFilesRecursive")
            : t(mediaType === "photo" ? "coreBrowse.folder.noPhotosRecursive" : "coreBrowse.folder.noVideosRecursive")}
        </p>
      )}

      {hasMore && (
        <div ref={sentinelRef} className="flex min-h-[60px] items-center justify-center text-sm">
          {loadingMore && (
            <span className="text-muted">
              {t("coreBrowse.folder.loadingMore", { current: media.length, total: mediaTotal })}
            </span>
          )}
        </div>
      )}

      {viewerIndex !== null && (
        <Viewer
          items={media}
          startIndex={viewerIndex}
          onClose={() => setViewerIndex(null)}
          total={mediaTotal}
          onRequestMore={loadMore}
        />
      )}
    </div>
  );
}
