import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Pencil } from "lucide-react";
import type { FolderDto, HomeSummaryDto, MediaDto, OnThisDayTier, ScanRootDto } from "@memorylane/shared";
import { api } from "../api/client";
import FolderCard from "../components/FolderCard";
import { AppleBrowseCard } from "../components/AppleBrowseCard";
import InlineSlideshow from "../components/InlineSlideshow";
import { formatBytes } from "../utils/format";
import { formatMemoryBlurb } from "../utils/blurb";
import { displaySrc } from "../utils/mediaSrc";
import { useTranslation } from "react-i18next";

type MemoryTab = "random" | "onThisDay";

export default function HomePage() {
  const { t } = useTranslation();
  const [folders, setFolders] = useState<FolderDto[] | null>(null);
  const [appleLibraries, setAppleLibraries] = useState<{ root: ScanRootDto; count: number; coverMediaId: number | null; thumbnailVersion: number }[]>([]);
  const [appleRootIds, setAppleRootIds] = useState<number[]>([]);
  const [summary, setSummary] = useState<HomeSummaryDto | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const editTitle = () => {
    setTitleDraft(summary?.archiveTitle ?? "MemoryLane");
    setTitleError(null);
    setEditingTitle(true);
  };
  const saveTitle = async () => {
    if (!titleDraft.trim() || savingTitle) return;
    setSavingTitle(true);
    setTitleError(null);
    try {
      const saved = await api.settings.update({ archiveTitle: titleDraft.trim() });
      setSummary((previous) => previous ? { ...previous, archiveTitle: saved.archiveTitle } : previous);
      setEditingTitle(false);
    } catch (err) {
      setTitleError(err instanceof Error ? err.message : t("coreBrowse.home.titleError"));
    } finally {
      setSavingTitle(false);
    }
  };
  const [activeTab, setActiveTab] = useState<MemoryTab>("random");
  const [tabItems, setTabItems] = useState<MediaDto[] | null>(null);
  const [tabTier, setTabTier] = useState<OnThisDayTier | null>(null);
  const [tabLoading, setTabLoading] = useState(false);
  const navigate = useNavigate();

  const loadTab = useCallback(async (tab: MemoryTab) => {
    setTabLoading(true);
    setTabItems(null);
    setTabTier(null);
    try {
      if (tab === "random") {
        const res = await api.memories.random(30);
        setTabItems(res.items);
      } else {
        const res = await api.memories.onThisDay(30);
        setTabItems(res.items);
        setTabTier(res.tier);
      }
    } finally {
      setTabLoading(false);
    }
  }, []);

  useEffect(() => {
    void Promise.all([api.folders.listTop(), api.scanRoots.list(), api.plugins.list()]).then(async ([listedFolders, roots, plugins]) => {
      setAppleRootIds(roots.filter((root) => root.kind === "apple-photos").map((root) => root.id));
      const folderRoots = roots.filter((root) => root.kind === "folder" && root.enabled);
      const soleRootFolder = folderRoots.length === 1
        ? listedFolders.find((folder) => folder.scanRootId === folderRoots[0].id)
        : undefined;
      if (soleRootFolder) {
        try {
          const children = await api.folders.children(soleRootFolder.id, 0, 500);
          // A root containing files but no child folders must remain reachable.
          setFolders(children.items.length > 0 ? children.items : listedFolders);
        } catch {
          setFolders(listedFolders);
        }
      } else {
        setFolders(listedFolders);
      }
      if (!plugins.some((plugin) => plugin.id === "apple-photos" && plugin.enabled)) return;
      const libraries = await Promise.all(roots.filter((root) => root.kind === "apple-photos" && root.enabled).map(async (root) => {
        const folder = listedFolders.find((candidate) => candidate.scanRootId === root.id);
        try {
          const browse = await api.plugins.browseApplePhotos(root.id);
          const cover = browse.groups.find((group) => group.coverMediaId !== null);
          return { root, count: browse.groups.reduce((sum, group) => sum + group.count, 0),
            coverMediaId: cover?.coverMediaId ?? null, thumbnailVersion: cover?.thumbnailVersion ?? 0 };
        } catch {
          return { root, count: folder?.recursiveMediaCount ?? 0,
            coverMediaId: folder?.thumbnailMediaId ?? null, thumbnailVersion: folder?.thumbnailVersion ?? 0 };
        }
      }));
      setAppleLibraries(libraries);
    }).catch(() => {});
    // Re-fetched (and re-randomized server-side) on every Home page load.
    void api.home.summary().then(setSummary);
    // Random Memory plays by default the moment the page opens - no click needed.
    void loadTab("random");
  }, [loadTab]);

  const selectTab = (tab: MemoryTab) => {
    setActiveTab(tab);
    void loadTab(tab);
  };

  const heroMetadata = summary
    ? [
        summary.mediaCount > 0 ? t("coreBrowse.home.media", { count: summary.mediaCount }) : null,
        summary.folderCount > 0 ? t("coreBrowse.home.folders", { count: summary.folderCount }) : null,
        summary.yearSpan > 0 ? t("coreBrowse.home.years", { count: summary.yearSpan }) : null,
        summary.totalSizeBytes > 0 ? formatBytes(summary.totalSizeBytes) : null,
      ].filter((v): v is string => v !== null)
    : [];

  const heroBlurb = summary?.heroMedia ? formatMemoryBlurb(summary.heroMedia) : null;

  const tabs: { key: MemoryTab; label: string }[] = [
    { key: "random", label: t("coreBrowse.home.random") },
    { key: "onThisDay", label: t("coreBrowse.home.onThisDay") },
  ];

  return (
    <div className="flex flex-col gap-10">
      {/* Hero card - mirrors life-archive-app's home hero, with a random
          library photo standing in for the archive's "hero.jpg". */}
      <section>
        <div className="relative min-h-[460px] overflow-hidden rounded-[8px] bg-hero-fallback shadow-hero ring-1 ring-border">
          {summary?.heroMedia && (
            <img
              // Rendered at full hero-card size (easily 700+ device px tall on
              // a high-DPI phone) - the small 500px grid thumbnail was
              // visibly soft here. Same full-resolution source the Viewer/
              // InlineSlideshow already use, not the thumbnail.
              src={displaySrc(summary.heroMedia, false)}
              alt=""
              className="absolute inset-0 h-full w-full object-cover"
            />
          )}
          <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(8,18,34,0.72)_0%,rgba(8,18,34,0.43)_42%,rgba(8,18,34,0.08)_78%)]" />
          <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/42 to-transparent" />

          <div className="relative flex min-h-[460px] items-end p-6 text-white sm:p-8 lg:p-10">
            <div className="w-full max-w-[760px] pb-2">
              <p className="text-[13px] font-medium text-white/70">{t("coreBrowse.home.archive")}</p>
              {editingTitle ? (
                <form className="mt-3 max-w-xl rounded-lg bg-black/40 p-4" onSubmit={(event) => { event.preventDefault(); void saveTitle(); }}>
                  <label htmlFor="archive-title" className="mb-2 block text-sm font-medium">{t("coreBrowse.home.archiveTitle")}</label>
                  <input id="archive-title" autoFocus value={titleDraft} maxLength={100} required disabled={savingTitle}
                    onChange={(event) => setTitleDraft(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Escape" && !savingTitle) setEditingTitle(false); }}
                    className="w-full rounded-md border border-white/40 bg-black/30 px-3 py-2 text-xl text-white outline-offset-2 placeholder:text-white/50"
                    placeholder={t("coreBrowse.home.titlePlaceholder")} />
                  {titleError && <p role="alert" className="mt-2 text-sm text-red-200">{titleError}</p>}
                  <div className="mt-3 flex gap-3">
                    <button type="submit" disabled={savingTitle || !titleDraft.trim()} className="rounded-md bg-white px-4 py-2 text-sm font-medium text-black disabled:opacity-50">{savingTitle ? t("coreBrowse.home.saving") : t("common.save")}</button>
                    <button type="button" disabled={savingTitle} onClick={() => setEditingTitle(false)} className="rounded-md border border-white/40 px-4 py-2 text-sm disabled:opacity-50">{t("common.cancel")}</button>
                  </div>
                </form>
              ) : (
                <div className="group/title mt-2 inline-flex max-w-full items-center gap-3">
                  <h1 className="min-w-0 break-words font-serif text-4xl font-semibold leading-[0.95] tracking-[-0.03em] sm:text-5xl lg:text-[clamp(3.875rem,5.4vw,5.25rem)]">
                    {summary?.archiveTitle ?? "MemoryLane"}
                  </h1>
                  {summary && (
                    <button type="button" onClick={editTitle} aria-label={t("coreBrowse.home.editTitle")}
                      className="flex shrink-0 items-center gap-1.5 rounded-full bg-black/45 px-3 py-2 text-xs text-white opacity-100 transition-opacity hover:bg-black/65 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/title:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100">
                      <Pencil size={13} aria-hidden /> {t("coreBrowse.home.edit")}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {heroBlurb && (
            <p className="absolute inset-x-0 bottom-4 text-center text-xs font-medium text-white/60">{heroBlurb}</p>
          )}
        </div>

        {heroMetadata.length > 0 && (
          <div className="mt-5 flex flex-wrap gap-x-7 gap-y-2 px-1 text-[14px] leading-[1.7] text-muted">
            {heroMetadata.map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>
        )}

        <div className="mt-6 px-1">
          <button
            className="rounded-full bg-accent px-10 py-4 text-lg font-bold text-page shadow-hero transition-opacity hover:opacity-90"
            onClick={() => {
              // Requested synchronously inside the click handler - browsers only grant
              // fullscreen in direct response to a user gesture, and that gesture context
              // is gone by the time the Surprise Me route finishes fetching photos.
              document.documentElement.requestFullscreen?.().catch(() => {});
              navigate("/surprise");
            }}
          >
            {t("pages.surprise")}
          </button>
        </div>
      </section>

      {/* Small tabbed rediscovery widgets - surface photos from anywhere in
          the library with zero effort, right on the home page. */}
      <section>
        <div className="flex gap-6 border-b border-border px-1">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => selectTab(tab.key)}
              className={`-mb-px border-b-2 pb-3 text-sm font-medium transition ${
                activeTab === tab.key
                  ? "border-accent text-ink"
                  : "border-transparent text-muted hover:text-ink"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="mt-4">
          {tabLoading && <p className="px-1 text-sm text-muted">{t("pages.gathering")}</p>}
          {!tabLoading && tabItems && tabItems.length > 0 && (
            <>
              {activeTab === "onThisDay" && tabTier && tabTier !== "none" && (
                <p className="mb-2 px-1 text-xs text-muted">{t(`coreBrowse.home.tier.${tabTier}`)}</p>
              )}
              <InlineSlideshow items={tabItems} />
            </>
          )}
          {!tabLoading && tabItems && tabItems.length === 0 && (
            <p className="px-1 text-sm text-muted">
              {activeTab === "onThisDay"
                ? t("coreBrowse.home.noDated")
                : t("pages.noIndexed")}
            </p>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-4 font-serif text-2xl font-semibold text-ink">{t("pages.yourLibrary")}</h2>
        {folders === null && <p className="text-sm text-muted">{t("common.loading")}</p>}
        {folders && folders.length === 0 && appleLibraries.length === 0 && (
          <p className="text-sm text-muted">{t("coreBrowse.home.noFolders")}</p>
        )}
        {folders && (folders.length > 0 || appleLibraries.length > 0) && (
          <div className="grid grid-cols-2 gap-5 md:grid-cols-3 xl:grid-cols-4">
            {folders.filter((f) => !appleRootIds.includes(f.scanRootId)).map((f) => <FolderCard key={f.id} folder={f} />)}
            {appleLibraries.map(({ root, count, coverMediaId, thumbnailVersion }) =>
              <AppleBrowseCard key={`apple-${root.id}`} to={`/apple-photos/${root.id}`} title={t("applePhotos.devicePhotos")}
                previewRootId={root.id} subtitle={root.path.split(/[\\/]/).filter(Boolean).pop()} count={count}
                coverMediaId={coverMediaId} thumbnailVersion={thumbnailVersion} />)}
          </div>
        )}
      </section>
    </div>
  );
}
