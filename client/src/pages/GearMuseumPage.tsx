import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Aperture, Camera, ExternalLink, RefreshCw, Search, X } from "lucide-react";
import type { GearCameraEnrichmentDto, GearCameraSummaryDto, GearLensSummaryDto, GearLensTimelineDto, GearYearTotalDto, MediaDto } from "@memorylane/shared";
import { api } from "../api/client";
import MediaGrid from "../components/MediaGrid";
import Viewer from "../components/Viewer";
import { useTheme, type Theme } from "../hooks/useTheme";
import { useTranslation } from "react-i18next";

// Enrichment (image/specs) comes from the separate memorylane-museum service
// via /api/gear/* - see docs/architecture/2026-09-20-camera-lens-gear-database.md.
// Every field beyond label/photoCount can be null (service down, or gear not
// resolved yet), so this page always has to read fine with just raw labels -
// no invented copy (a writeup blurb, a "Digital/Film/Compact" split, named
// travel destinations we have no place-name data for) for data we don't
// actually have.
function displayName(g: { brand: string | null; model: string | null; label: string }): string {
  if (g.brand && g.model) return `${g.brand} ${g.model}`;
  return g.label;
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Reads the year digits directly out of the stored string, matching the
// server's substr(captured_at_precise, 1, 4) exactly - captured_at_precise
// is stored naive (no Z/offset), so new Date(iso).getFullYear() happens to
// agree today (a naive ISO string parses as local time, i.e. no shift), but
// that's an implicit JS Date-parsing nuance to rely on rather than reading
// the same literal digits the server does.
function yearOf(iso: string | null): string | null {
  return iso && /^\d{4}/.test(iso) ? iso.slice(0, 4) : null;
}

function yearRange(c: GearCameraSummaryDto): string {
  return [yearOf(c.firstPhoto), yearOf(c.lastPhoto)].filter(Boolean).join("–");
}

// Mirrors the grid's own grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 breakpoints.
function columnsForWidth(width: number): number {
  if (width >= 1024) return 4;
  if (width >= 640) return 3;
  return 2;
}

type SortMode = "photos" | "recent" | "name";
const SORTS: SortMode[] = ["photos", "recent", "name"];

// The shelf (wood) is the one deliberately fixed (non-theme) visual - wood is
// wood regardless of the app's light/dark theme, same as a physical display
// case's shelf doesn't repaint itself with the room. The backdrop behind each
// camera and its plaque both use the app's normal theme tokens instead (see
// GearBay) - only the wood strip and the spotlight glow stay fixed.
const shelfTop = "linear-gradient(180deg, #a3773f 0%, #6b4726 65%, #4a3018 100%)";
const fascia = "linear-gradient(180deg, #38220e 0%, #20130a 100%)";

const GENERIC_IMAGE: Record<"camera" | "lens", string> = { camera: "/generic-camera.png", lens: "/generic-lens.png" };

// A subtle "museum mat" frame for real resolved photos only - a faint light
// edge separating a white product shot from the dark shelf backdrop, plus an
// inset vignette darkening the corners so a plain CC product photo reads as
// a framed exhibit piece rather than a flat clipped rectangle. Never applied
// to the generic placeholder artwork, which doesn't need it.
function realPhotoFrame(isReal: boolean): string {
  return isReal ? "rounded-md ring-1 ring-white/15 shadow-[inset_0_0_22px_7px_rgba(0,0,0,0.35)]" : "";
}

// Module-scoped, not component state: survives navigating away and back
// (e.g. Gear Museum -> Reports -> Gear Museum) for as long as the tab stays
// open, so the museum service (a separate, independently-deployed process -
// see docs/design.md) only gets hit once per distinct minPhotos value per
// session instead of on every single page visit. Explicit refresh (the
// button below) is the only thing that busts it.
// Museum enrichment (camera image/specs) comes from a separate, slower,
// externally-deployed service - cached here across mounts and only refreshed
// on demand. The EXIF-derived fields (photoCount, dates, year breakdown) come
// straight from the local library scan and are cheap/fast, so those are NOT
// cached here - they're refetched fresh on every page load (see the effect
// below), otherwise a stale in-memory snapshot can drift from the real DB
// after a rescan and render nonsensical positions.
const gearEnrichmentCache = new Map<string, GearCameraEnrichmentDto>();

function applyEnrichment(cameras: GearCameraSummaryDto[], cache: Map<string, GearCameraEnrichmentDto>): GearCameraSummaryDto[] {
  return cameras.map((c) => {
    const e = cache.get(c.label);
    return e ? { ...c, ...e } : c;
  });
}

// Shared by both routes - GearMuseumPage (grid) and GearTimelinePage
// (timeline) below just fix `mode`, they don't duplicate any of this state/
// data-fetching logic.
function GearPage({ mode }: { mode: "grid" | "timeline" }) {
  const { t } = useTranslation();
  const { theme } = useTheme();
  const navigate = useNavigate();
  const [cameras, setCameras] = useState<GearCameraSummaryDto[] | null>(null);
  const [timelineLenses, setTimelineLenses] = useState<GearLensTimelineDto[] | null>(null);
  const [timelineKind, setTimelineKind] = useState<"camera" | "lens">("camera");
  const [yearTotals, setYearTotals] = useState<GearYearTotalDto[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<string | null>(null);
  const [lenses, setLenses] = useState<GearLensSummaryDto[]>([]);
  const [selectedLens, setSelectedLens] = useState<string | null>(null);
  const [photos, setPhotos] = useState<MediaDto[]>([]);
  const [photoTotal, setPhotoTotal] = useState(0);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("photos");
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Set only by clicking a specific year-segment in the timeline - narrows
  // the photos shown in the detail popup to just that year, until cleared.
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  // Cameras a real scan only barely touched (a stray photo someone else took
  // on a borrowed/shared device) shouldn't read as "gear you owned" - server
  // enforces this via HAVING COUNT(*) >= minPhotos, applies to both views.
  const [minPhotos, setMinPhotos] = useState(50);
  const [refreshing, setRefreshing] = useState(false);
  // Matches the grid's own grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 (Tailwind
  // defaults: sm=640px, lg=1024px) - needed so the expansion panel can be
  // inserted after the *whole row* containing the selected camera, not just
  // after the clicked tile, which otherwise pushes that row's remaining
  // members past the panel and visually breaks the row (see columnCount use
  // below).
  const [columnCount, setColumnCount] = useState(() => (typeof window === "undefined" ? 4 : columnsForWidth(window.innerWidth)));

  useEffect(() => {
    const onResize = () => setColumnCount(columnsForWidth(window.innerWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Always fresh on load - EXIF data is local and fast, and a stale snapshot
  // here would silently drift from the real DB after a rescan. Enrichment
  // (image/specs) is applied from the cache immediately, then backfilled for
  // any camera this cache hasn't seen yet - that part stays cheap without
  // ever refetching data that's actually already stale-free.
  useEffect(() => {
    let cancelled = false;
    void api.gear.cameras(minPhotos).then((data) => {
      if (cancelled) return;
      setCameras(applyEnrichment(data, gearEnrichmentCache));
      const missing = data.map((c) => c.label).filter((label) => !gearEnrichmentCache.has(label));
      if (missing.length === 0) return;
      void api.gear.enrichCameras(missing).then((enrichment) => {
        if (cancelled) return;
        for (const [label, e] of Object.entries(enrichment)) gearEnrichmentCache.set(label, e);
        setCameras((prev) => (prev ? applyEnrichment(prev, gearEnrichmentCache) : prev));
      });
    });
    return () => {
      cancelled = true;
    };
  }, [minPhotos]);

  useEffect(() => {
    void api.gear.yearTotals().then(setYearTotals);
  }, []);

  useEffect(() => {
    if (mode !== "timeline" || timelineKind !== "lens") return;
    let cancelled = false;
    void api.gear.lensTimeline(minPhotos).then((data) => { if (!cancelled) setTimelineLenses(data); });
    return () => { cancelled = true; };
  }, [minPhotos, mode, timelineKind]);

  const handleRefresh = () => {
    setRefreshing(true);
    void Promise.all([
      api.gear.cameras(minPhotos).then((data) => {
        setCameras(applyEnrichment(data, gearEnrichmentCache));
        // Explicit refresh forces the (slower) museum enrichment to redo its
        // lookup for every camera currently shown, not just newly-seen ones.
        return api.gear.enrichCameras(data.map((c) => c.label)).then((enrichment) => {
          for (const [label, e] of Object.entries(enrichment)) gearEnrichmentCache.set(label, e);
          setCameras((prev) => (prev ? applyEnrichment(prev, gearEnrichmentCache) : prev));
        });
      }),
      api.gear.yearTotals().then(setYearTotals),
      ...(mode === "timeline" && timelineKind === "lens" ? [api.gear.lensTimeline(minPhotos).then(setTimelineLenses)] : []),
    ]).finally(() => setRefreshing(false));
  };

  useEffect(() => {
    if (!selectedCamera) return;
    setSelectedLens(null);
    setDetailsOpen(false);
    // selectedYear is deliberately NOT reset here: onSelectYear sets both
    // selectedCamera and selectedYear together (clicking a year bar on a
    // camera that wasn't already open changes selectedCamera too), and this
    // effect firing on that same change would otherwise silently wipe the
    // year right back out. Every caller that should clear it (onSelect,
    // onClearYear) already does so explicitly.
    void api.gear.lenses(selectedCamera).then(setLenses);
  }, [selectedCamera]);

  useEffect(() => {
    if (!selectedCamera) return;
    void api.media.list({ camera: selectedCamera, lens: selectedLens ?? undefined, year: selectedYear ?? undefined }, 0, 18).then((r) => {
      setPhotos(r.items);
      setPhotoTotal(r.total);
    });
  }, [selectedCamera, selectedLens, selectedYear]);

  const visibleCameras = useMemo(() => {
    if (!cameras) return [];
    const q = query.trim().toLowerCase();
    const filtered = q ? cameras.filter((c) => displayName(c).toLowerCase().includes(q)) : cameras;
    const sorted = [...filtered];
    if (sort === "recent") sorted.sort((a, b) => (b.lastPhoto ?? "").localeCompare(a.lastPhoto ?? ""));
    else if (sort === "name") sorted.sort((a, b) => displayName(a).localeCompare(displayName(b)));
    else sorted.sort((a, b) => b.photoCount - a.photoCount);
    return sorted;
  }, [cameras, query, sort]);
  const visibleTimelineLenses = useMemo(() => {
    if (!timelineLenses) return [];
    const q = query.trim().toLowerCase();
    return q ? timelineLenses.filter((lens) => displayName(lens).toLowerCase().includes(q)) : timelineLenses;
  }, [timelineLenses, query]);
  const timelineItems = timelineKind === "camera" ? visibleCameras : visibleTimelineLenses;

  const selected = cameras?.find((c) => c.label === selectedCamera) ?? null;
  const selectedIndex = selectedCamera ? visibleCameras.findIndex((c) => c.label === selectedCamera) : -1;
  const reportsHref = `/reports?${new URLSearchParams({
    ...(selectedCamera ? { camera: selectedCamera } : {}),
    ...(selectedLens ? { lens: selectedLens } : {}),
    ...(selectedYear ? { year: String(selectedYear) } : {}),
  })}`;

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-3xl font-semibold text-ink">{t(mode === "grid" ? "navigation.gearMuseum" : "navigation.gearTimeline")}</h1>
          <p className="mt-1 text-sm text-muted">
            {mode === "grid"
              ? t("gearUi.museumIntro") : t("gearUi.timelineIntro")}
          </p>
        </div>
        <div className="relative w-full max-w-xs">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t(mode === "timeline" && timelineKind === "lens" ? "gearUi.searchLenses" : "gearUi.searchCameras")}
            className="w-full rounded-lg border border-border bg-surface py-2 pl-9 pr-3 text-sm text-ink outline-none focus:border-accent"
          />
        </div>
      </div>

      {cameras === null && <p className="text-sm text-muted">{t("common.loading")}</p>}
      {cameras?.length === 0 && <p className="text-sm text-muted">{t("gearUi.noExif")}</p>}

      {cameras && cameras.length > 0 && (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm text-muted">
              {t(mode === "timeline" && timelineKind === "lens" ? "gearUi.lenses" : "gearUi.cameras", { count: mode === "timeline" ? timelineItems.length : visibleCameras.length })}
            </span>
            <div className="flex items-center gap-3">
              {mode === "timeline" && (
                <div role="group" aria-label={t("gearUi.timelineType")} className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
                  {([ ["camera", t("gearUi.cameraPlural"), Camera], ["lens", t("gearUi.lensPlural"), Aperture] ] as const).map(([value, label, Icon]) => (
                    <button key={value} type="button" title={label} aria-label={label} aria-pressed={timelineKind === value}
                      onClick={() => { setTimelineKind(value); setSelectedCamera(null); setQuery(""); }}
                      className={`grid size-7 place-items-center rounded transition-colors ${timelineKind === value ? "bg-accent text-page" : "text-muted hover:bg-hover hover:text-ink"}`}>
                      <Icon size={15} strokeWidth={1.8} />
                    </button>
                  ))}
                </div>
              )}
              <label className="flex items-center gap-1.5 text-sm text-muted">
                {t("gearUi.minPhotos")}
                <input
                  type="number"
                  min={0}
                  value={minPhotos}
                  onChange={(e) => setMinPhotos(Math.max(0, Number(e.target.value) || 0))}
                  className="w-16 rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-ink outline-none"
                />
              </label>
              <button
                onClick={handleRefresh}
                disabled={refreshing}
                title={t("gearUi.refresh")}
                className="rounded-lg border border-border bg-surface p-2 text-muted hover:bg-hover hover:text-ink disabled:opacity-50"
              >
                <RefreshCw size={16} className={refreshing ? "animate-spin" : ""} />
              </button>
              {mode === "grid" && (
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value as SortMode)}
                  className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-ink outline-none"
                >
                  {SORTS.map((s) => (
                    <option key={s} value={s}>
                      {t("gearUi.sort", { value: t(`gearUi.sorts.${s}`) })}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>

          {mode === "grid" ? (
            /* Zero-width grid gap keeps shelves touching across a row. The
               expanded panel is inserted with col-span-full right after the
               LAST item of the row containing the selected camera (not
               right after the clicked tile itself) - otherwise that row's
               remaining members get pushed by CSS Grid's auto-placement
               past the panel onto a later row, visually breaking the row.
               rowEndIndex depends on the live column count (columnCount,
               tracked via resize listener above), since the grid is
               responsive and a "row" means something different at each
               breakpoint. */
            <div className="grid grid-cols-2 gap-x-0 gap-y-10 sm:grid-cols-3 lg:grid-cols-4">
              {visibleCameras.map((c, index) => {
                const rowEndIndex =
                  selectedIndex === -1 ? -1 : Math.min(Math.ceil((selectedIndex + 1) / columnCount) * columnCount - 1, visibleCameras.length - 1);
                return (
                  <Fragment key={c.label}>
                    <GearBay
                      gear={c}
                      selected={c.label === selectedCamera}
                      spotlight={theme === "dark"}
                      onClick={() => {
                        setSelectedCamera((cur) => (cur === c.label ? null : c.label));
                        setSelectedYear(null);
                      }}
                    />
                    {index === rowEndIndex && selected && (
                      <div className="col-span-full">
                        <CameraDetail
                          selected={selected}
                          lenses={lenses}
                          selectedLens={selectedLens}
                          onSelectLens={setSelectedLens}
                          photos={photos}
                          photoTotal={photoTotal}
                          detailsOpen={detailsOpen}
                          onToggleDetails={() => setDetailsOpen((v) => !v)}
                          onOpenPhoto={setViewerIndex}
                          reportsHref={reportsHref}
                        />
                      </div>
                    )}
                  </Fragment>
                );
              })}
            </div>
          ) : (
            <>
              <CameraTimeline
                cameras={timelineItems}
                gearKind={timelineKind}
                selectedCamera={timelineKind === "camera" ? selectedCamera : null}
                selectedYear={selectedYear}
                theme={theme}
                yearTotals={yearTotals}
                onSelect={(label) => {
                  if (timelineKind === "lens") { navigate(`/reports?lens=${encodeURIComponent(label)}`); return; }
                  setSelectedCamera((cur) => (cur === label ? null : label));
                  setSelectedYear(null);
                }}
                onSelectYear={(label, year) => {
                  if (timelineKind === "lens") { navigate(`/reports?lens=${encodeURIComponent(label)}&year=${year}`); return; }
                  setSelectedCamera(label);
                  setSelectedYear(year);
                }}
              />
              {/* Timeline mode shows the detail as a modal rather than an
                  inline reveal - the timeline's own layout is absolutely
                  positioned (no CSS grid rows to insert into cleanly, unlike
                  grid view), so a popup avoids fighting that layout. */}
              {selected && (
                <div
                  className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-12"
                  onClick={() => setSelectedCamera(null)}
                >
                  <div className="w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
                    <CameraDetail
                      selected={selected}
                      lenses={lenses}
                      selectedLens={selectedLens}
                      onSelectLens={setSelectedLens}
                      photos={photos}
                      photoTotal={photoTotal}
                      detailsOpen={detailsOpen}
                      onToggleDetails={() => setDetailsOpen((v) => !v)}
                      onOpenPhoto={setViewerIndex}
                      reportsHref={reportsHref}
                      onClose={() => setSelectedCamera(null)}
                      year={selectedYear}
                      onClearYear={() => setSelectedYear(null)}
                    />
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
      {viewerIndex !== null && <Viewer items={photos} startIndex={viewerIndex} onClose={() => setViewerIndex(null)} />}
    </div>
  );
}

export default function GearMuseumPage() {
  return <GearPage mode="grid" />;
}

export function GearTimelinePage() {
  return <GearPage mode="timeline" />;
}

// One row per camera, years running left (most recent) to right (oldest) -
// see docs discussion 2026-09-20. Every camera always gets its own row in
// normal document flow, so there's no lane-packing math at all here (that
// was the whole source of the two rendering bugs the vertical version hit -
// see git history around 2026-09-20 for the pixel-doubling and axis-mismatch
// fixes). Only the bar chart inside each row is absolutely positioned, and
// each row's chart area is its own small `.relative` container, so a bug in
// one row's internal math can never leak into another row's or the header's
// coordinate space the way the single shared canvas did.
const GEAR_YEAR_WIDTH = 40;
const GEAR_ROW_HEIGHT = 88;
const GEAR_BASELINE = 72; // where the spine/circles sit within a row; bars grow upward from here
const GEAR_BAR_MAX_HEIGHT = 58;
const GEAR_LABEL_WIDTH = 220;
const GEAR_HEADER_HEIGHT = 40;
const GEAR_NAV_HEIGHT = 64;

// A restrained archival/museum palette, not a rainbow one - deliberately
// muted, no bright/saturated hues, so the character reads as a photographic
// collection rather than an analytics dashboard.
const TIMELINE_COLORS = [
  "#C9A66B", // sand
  "#8FAF91", // sage
  "#8299B5", // slate
  "#B98778", // clay
  "#79A5A0", // teal
  "#9B8DAA", // mauve
  "#A8A47A", // olive
];
// Hashed by the camera's own label (not sort/render index) so a given camera
// always gets the same color regardless of sort order, min-photos filtering,
// or session - index-based cycling looked cleaner with more colors but
// breaks that stability guarantee, which matters more now. Never derived
// from brand/manufacturer - hashing the raw label keeps color unrelated to
// who made the camera.
function colorFor(cameraId: string): string {
  let hash = 0;
  for (let i = 0; i < cameraId.length; i++) hash = (hash * 31 + cameraId.charCodeAt(i)) | 0;
  return TIMELINE_COLORS[Math.abs(hash) % TIMELINE_COLORS.length];
}

type TimelineGear = Pick<GearCameraSummaryDto, "label" | "photoCount" | "firstPhoto" | "lastPhoto" | "yearBreakdown" | "brand" | "model" | "imageUrl">;

// One row per camera (most recent endYear first), a frozen label on the
// left, and years running left-to-right - most recent nearest the label,
// oldest furthest away - with a horizontal spine per row and bars growing
// UP from a shared baseline. Vertical position (which row) = which camera;
// horizontal position = when; bar height = how much. No lane-packing here:
// every camera always gets its own row, so cameras never have to share
// space and there's no pixel-overlap math to get wrong.
function CameraTimeline({
  cameras,
  gearKind,
  selectedCamera,
  selectedYear,
  theme,
  yearTotals,
  onSelect,
  onSelectYear,
}: {
  cameras: TimelineGear[];
  gearKind: "camera" | "lens";
  selectedCamera: string | null;
  selectedYear: number | null;
  theme: Theme;
  yearTotals: GearYearTotalDto[];
  onSelect: (label: string) => void;
  onSelectYear: (label: string, year: number) => void;
}) {
  const { t } = useTranslation();
  const isDarkPage = theme === "dark";
  const headerTrackRef = useRef<HTMLDivElement>(null);
  const yearTotalMap = useMemo(() => new Map(yearTotals.map((y) => [Number(y.year), y.count])), [yearTotals]);

  // Sorted most-recent-first (by endYear, then startYear, then photoCount as
  // stable tiebreakers for cameras that are all still in active use) - reads
  // top-to-bottom like a stack of eras, newest on top.
  const dated = useMemo(() => {
    return cameras
      .map((camera) => {
        const start = yearOf(camera.firstPhoto);
        const end = yearOf(camera.lastPhoto);
        const counts = new Map(camera.yearBreakdown.map((y) => [Number(y.year), y.count]));
        const years: number[] = [];
        if (start && end) for (let y = Number(end); y >= Number(start); y--) years.push(y);
        return start && end ? { camera, startYear: Number(start), endYear: Number(end), counts, years } : null;
      })
      .filter((x): x is { camera: TimelineGear; startYear: number; endYear: number; counts: Map<number, number>; years: number[] } => x !== null)
      .sort((a, b) => b.endYear - a.endYear || b.startYear - a.startYear || b.camera.photoCount - a.camera.photoCount);
  }, [cameras]);

  const globalMaxCount = useMemo(() => Math.max(1, ...dated.flatMap((d) => [...d.counts.values()])), [dated]);

  const { minYear, maxYear } = useMemo(() => {
    if (dated.length === 0) return { minYear: 0, maxYear: 0 };
    return {
      minYear: Math.min(...dated.map((d) => d.startYear)),
      maxYear: Math.max(new Date().getFullYear(), ...dated.map((d) => d.endYear)),
    };
  }, [dated]);
  // Return the center of a year column. Both header labels and bars use this
  // convention so the newest column stays fully inside the chart.
  const xFor = (year: number) => (maxYear - year) * GEAR_YEAR_WIDTH + GEAR_YEAR_WIDTH / 2;

  if (dated.length === 0) return <p className="text-sm text-muted">{t("gearUi.noTimeline")}</p>;

  const totalYears = maxYear - minYear + 1;
  const timelineWidth = totalYears * GEAR_YEAR_WIDTH;
  const years: number[] = [];
  for (let y = maxYear; y >= minYear; y--) years.push(y);

  return (
    <div>
      {/* The page-sticky header must live outside the horizontal scrolling
          body. Its year track is translated to mirror the body's scrollLeft;
          putting sticky inside overflow-x-auto makes the overflow element its
          containing block and causes the header to overlap row one, then
          disappear when that block leaves the viewport. */}
      <div className="sticky z-20 flex overflow-hidden bg-page" style={{ top: GEAR_NAV_HEIGHT, height: GEAR_HEADER_HEIGHT }}>
        <div className="z-10 shrink-0 border-b border-border bg-page" style={{ width: GEAR_LABEL_WIDTH, height: GEAR_HEADER_HEIGHT }} />
        <div className="min-w-0 flex-1 overflow-hidden border-b border-border">
          <div ref={headerTrackRef} className="relative shrink-0 will-change-transform" style={{ width: timelineWidth, height: GEAR_HEADER_HEIGHT }}>
            {years.map((y) => {
              const major = y % 5 === 0;
              return (
                <div key={y}>
                  <div
                    className="absolute w-px bg-ink"
                    style={{ left: xFor(y), top: 0, height: GEAR_HEADER_HEIGHT, opacity: major ? 0.12 : 0.03 }}
                  />
                  <div
                    className={`absolute text-ink ${major ? "text-sm font-bold" : "text-[11px] text-muted"}`}
                    style={{ left: xFor(y) - GEAR_YEAR_WIDTH / 2, top: 6, width: GEAR_YEAR_WIDTH, textAlign: "center" }}
                  >
                    {y}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div
        className="overflow-x-auto"
        onScroll={(event) => {
          if (headerTrackRef.current) headerTrackRef.current.style.transform = `translateX(-${event.currentTarget.scrollLeft}px)`;
        }}
      >
        <div style={{ minWidth: GEAR_LABEL_WIDTH + timelineWidth }}>
        {/* Rows - normal document flow, so no lane-packing/absolute-canvas
            math is needed to keep them from overlapping each other. */}
        <div className="relative mt-2">
        {years.filter((year) => year % 10 === 0).map((year) => (
          <div
            key={`decade-${year}`}
            aria-hidden="true"
            className="pointer-events-none absolute bottom-0 top-0 z-0 border-l border-dotted border-ink/15"
            style={{ left: GEAR_LABEL_WIDTH + xFor(year) }}
          />
        ))}
        {dated.map(({ camera, startYear, endYear, counts, years: cameraYears }) => {
          const isSelected = camera.label === selectedCamera;
          const color = colorFor(camera.label);
          return (
            <div key={camera.label} className="relative z-[1] flex border-b border-border/60" style={{ height: GEAR_ROW_HEIGHT }}>
              {/* Frozen label - stays put horizontally as years scroll by. */}
              <button
                onClick={() => onSelect(camera.label)}
                className="sticky left-0 z-10 flex shrink-0 items-center gap-2 overflow-hidden bg-page p-2 text-left transition hover:bg-hover"
                style={{
                  width: GEAR_LABEL_WIDTH,
                  border: isSelected && !selectedYear ? "2px solid var(--color-accent, #4f8ef7)" : "2px solid transparent",
                }}
              >
                <div className="h-11 w-11 shrink-0 overflow-hidden rounded bg-chip">
                  <img src={camera.imageUrl ?? GENERIC_IMAGE[gearKind]} alt="" className="h-full w-full object-contain" />
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold leading-tight text-ink">{displayName(camera)}</div>
                  <div className="mt-0.5 truncate text-xs leading-tight text-muted">{t("common.photos", { count: camera.photoCount })}</div>
                </div>
                <div className="absolute inset-y-0 right-0 w-[3px]" style={{ background: color }} />
              </button>

              {/* Spine + bars, relative to this row's own small container -
                  never shares coordinate space with any other row. */}
              <div className="relative shrink-0" style={{ width: timelineWidth, height: GEAR_ROW_HEIGHT }}>
                <div
                  className="absolute h-px bg-border"
                  style={{ top: GEAR_BASELINE, left: xFor(endYear), width: xFor(startYear) - xFor(endYear) }}
                />
                {cameraYears.map((y) => {
                  const count = counts.get(y) ?? 0;
                  if (count === 0) return null;
                  const frac = Math.sqrt(count) / Math.sqrt(globalMaxCount);
                  const barHeight = Math.max(frac * GEAR_BAR_MAX_HEIGHT, 14);
                  const yearSelected = isSelected && selectedYear === y;
                  const yearTotal = yearTotalMap.get(y) ?? 0;
                  const pct = yearTotal > 0 ? ((count / yearTotal) * 100).toFixed(1) : "0";
                  const x = xFor(y);
                  return (
                    <button
                      key={y}
                      onClick={() => onSelectYear(camera.label, y)}
                      title={t("gearUi.yearTitle", { name: displayName(camera), year: y, count, percent: pct })}
                      className="absolute transition hover:brightness-95"
                      style={{ left: x - GEAR_YEAR_WIDTH / 2, top: 0, width: GEAR_YEAR_WIDTH, height: GEAR_ROW_HEIGHT }}
                    >
                      <div
                        className="absolute left-1/2 rounded-sm"
                        style={{
                          width: 20,
                          height: barHeight,
                          top: GEAR_BASELINE - barHeight,
                          transform: "translateX(-50%)",
                          background: color,
                          // 40-50% strength on a light page, 60-70% on dark.
                          opacity: isDarkPage ? 0.78 : 0.62,
                          border: `1px solid ${color}`,
                          outline: yearSelected ? "2px solid var(--color-accent, #4f8ef7)" : "none",
                          outlineOffset: 1,
                        }}
                      />
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
        </div>
        </div>
      </div>
    </div>
  );
}

// The in-place expansion panel: appears directly below the row containing
// the clicked camera (see the Fragment/col-span-full trick above this
// component's only call site), not a separate section at the bottom of the
// page. Lenses render as a grid, not a horizontal scroll list.
function CameraDetail({
  selected,
  lenses,
  selectedLens,
  onSelectLens,
  photos,
  photoTotal,
  detailsOpen,
  onToggleDetails,
  onOpenPhoto,
  reportsHref,
  onClose,
  year,
  onClearYear,
}: {
  selected: GearCameraSummaryDto;
  lenses: GearLensSummaryDto[];
  selectedLens: string | null;
  onSelectLens: (lens: string | null) => void;
  photos: MediaDto[];
  photoTotal: number;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  onOpenPhoto: (index: number) => void;
  reportsHref: string;
  // Set only when rendered inside the timeline's modal (grid view's inline
  // reveal closes by clicking the same camera again instead).
  onClose?: () => void;
  // Set when drilled into a specific year from the timeline's bar segments.
  year?: number | null;
  onClearYear?: () => void;
}) {
  const { t } = useTranslation();
  const selectedLensGear = selectedLens ? lenses.find((l) => l.label === selectedLens) : undefined;
  return (
    <div className={`relative rounded-xl bg-page p-6 ${onClose ? "max-h-[85vh] overflow-y-auto shadow-2xl" : "mt-6"}`}>
      {onClose && (
        <button
          onClick={onClose}
          aria-label={t("common.close")}
          className="absolute right-4 top-4 rounded-full p-1.5 text-muted hover:bg-hover hover:text-ink"
        >
          <X size={18} />
        </button>
      )}
      <div className="flex flex-wrap items-start gap-5">
        <div className="h-64 w-64 shrink-0 overflow-hidden rounded-lg bg-page">
          <img
            src={selected.imageUrl ?? GENERIC_IMAGE.camera}
            alt=""
            className={`h-full w-full object-contain ${realPhotoFrame(!!selected.imageUrl)}`}
          />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="font-serif text-xl font-semibold text-ink">{displayName(selected)}</h2>
          <p className="text-sm text-muted">{yearRange(selected)}</p>
          <p className="mt-1 text-ink">{t("gearUi.memories", { count: selected.photoCount })}</p>
          <Link to={reportsHref} className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline">
            {t("gearUi.viewReports")} <ExternalLink size={14} />
          </Link>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-x-8 gap-y-3 text-sm">
        {selected.firstPhoto && <Stat label={t("gearUi.firstUsed")} value={formatDate(selected.firstPhoto)} />}
        {selected.lastPhoto && <Stat label={t("gearUi.lastUsed")} value={formatDate(selected.lastPhoto)} />}
        {selected.mostUsedLens && <Stat label={t("gearUi.mostLens")} value={`${selected.mostUsedLens} (${selected.mostUsedLensCount?.toLocaleString()})`} />}
        {selected.distinctLocations != null && <Stat label={t("gearUi.places")} value={String(selected.distinctLocations)} />}
        {selected.yearBreakdown.length > 0 && (
          <div>
            <div className="text-xs uppercase tracking-wide text-muted">{t("gearUi.photosByYear")}</div>
            {selected.yearBreakdown.map((y) => (
              <div key={y.year} className="font-medium text-ink">
                {y.year} <span className="font-normal text-muted">({y.count.toLocaleString()})</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <button onClick={onToggleDetails} className="mt-4 text-sm font-medium text-accent hover:underline">
        {t(detailsOpen ? "gearUi.hideDetails" : "gearUi.showDetails")}
      </button>
      {detailsOpen && (
        <dl className="mt-3 space-y-1.5 text-sm">
          {selected.brand && <Row label={t("gearUi.brand")} value={selected.brand} />}
          {selected.releaseDate && <Row label={t("gearUi.released")} value={formatDate(selected.releaseDate)} />}
          {selected.weightG != null && <Row label={t("gearUi.weight")} value={`${Math.round(selected.weightG)} g`} />}
          {selected.lengthMm != null && selected.widthMm != null && selected.heightMm != null && (
            <Row label={t("gearUi.size")} value={`${Math.round(selected.lengthMm)} × ${Math.round(selected.widthMm)} × ${Math.round(selected.heightMm)} mm`} />
          )}
          {selected.isoMin != null && selected.isoMax != null && (
            <Row label={t("gearUi.isoRange")} value={selected.isoMin === selected.isoMax ? String(selected.isoMin) : `${selected.isoMin}–${selected.isoMax}`} />
          )}
          {selected.apertureMin != null && selected.apertureMax != null && (
            <Row
              label={t("gearUi.apertureRange")}
              value={selected.apertureMin === selected.apertureMax ? `f/${selected.apertureMin}` : `f/${selected.apertureMin}–f/${selected.apertureMax}`}
            />
          )}
          {!selected.brand && !selected.releaseDate && selected.weightG == null && <p className="text-muted">{t("gearUi.noSpecs")}</p>}
        </dl>
      )}
      {selected.imageUrl && (selected.imageLicense || selected.imageAttribution) && (
        <p className="mt-2 text-xs text-muted">
          {displayName(selected)}: {[selected.imageLicense, selected.imageAttribution].filter(Boolean).join(" · ")}
        </p>
      )}
      {selectedLensGear?.imageUrl && (selectedLensGear.imageLicense || selectedLensGear.imageAttribution) && (
        <p className="mt-1 text-xs text-muted">
          {displayName(selectedLensGear)}: {[selectedLensGear.imageLicense, selectedLensGear.imageAttribution].filter(Boolean).join(" · ")}
        </p>
      )}

      {lenses.length > 0 && (
        <>
          <h3 className="mb-3 mt-6 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
            <Aperture size={14} /> {t("gearUi.lensesUsed")}
          </h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            <button
              onClick={() => onSelectLens(null)}
              className={`flex flex-col items-center justify-center rounded-lg p-3 text-sm font-medium ring-1 ring-border transition ${
                selectedLens === null ? "bg-accent/10 text-ink" : "bg-surface text-ink hover:bg-hover"
              }`}
            >
              {t("gearUi.allLenses")}
            </button>
            {lenses.map((l) => (
              <button
                key={l.label}
                onClick={() => onSelectLens(l.label)}
                className={`flex flex-col items-center rounded-lg p-3 text-center ring-1 ring-border transition ${
                  selectedLens === l.label ? "bg-accent/10" : "bg-surface hover:bg-hover"
                }`}
              >
                <div className="h-16 w-16 overflow-hidden rounded bg-page">
                  <img
                    src={l.imageUrl ?? GENERIC_IMAGE.lens}
                    alt=""
                    className={`h-full w-full object-contain ${realPhotoFrame(!!l.imageUrl)}`}
                  />
                </div>
                <div className="mt-2 line-clamp-2 text-xs font-medium text-ink">{displayName(l)}</div>
                <div className="text-xs text-muted">{t("common.photos", { count: l.photoCount })}</div>
              </button>
            ))}
          </div>
        </>
      )}

      {photos.length > 0 && (
        <>
          <div className="mb-3 mt-6 flex items-center justify-between border-t border-border pt-6">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
              {t("gearUi.photosFrom")}{selectedLens ? ` + ${selectedLens}` : ""}
              {year ? ` ${t("gearUi.inYear", { year })}` : ""}
            </h3>
            <div className="flex items-center gap-3">
              {year && onClearYear && (
                <button onClick={onClearYear} className="text-sm font-medium text-accent hover:underline">
                  {t("gearUi.allYears")}
                </button>
              )}
              {photoTotal > photos.length && (
                <Link to={reportsHref} className="text-sm font-medium text-accent hover:underline">
                  {t("gearUi.viewAll", { count: photoTotal })}
                </Link>
              )}
            </div>
          </div>
          <MediaGrid items={photos} onOpen={onOpenPhoto} />
        </>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-medium text-ink">{value}</dd>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="font-medium text-ink">{value}</div>
    </div>
  );
}

// One camera "bay": the camera sitting on a 3D shelf (a lighter top surface
// catching the light + a darker front fascia below it, like the actual face
// of a physical shelf board), a contact shadow so it looks seated rather
// than floating, and a small "museum plaque" with its name/date range/count
// instead of plain floating text. Breathing room for the image itself comes
// from padding on the backdrop, not the grid gap, so it never disturbs the
// shelf/fascia beneath, which must stay perfectly continuous across a row.
function GearBay({
  gear,
  selected,
  spotlight,
  onClick,
}: {
  gear: GearCameraSummaryDto;
  selected: boolean;
  // Only lit on the dark theme - the warm overhead glow this simulates reads
  // as atmospheric on a genuinely dark backdrop, but shows up as an unwanted
  // colour tint against light/dusk/gallery's light backdrops.
  spotlight: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button onClick={onClick} className="group flex flex-col items-center pb-2 text-center outline-none">
      <div className="relative flex h-32 w-full items-end justify-center overflow-hidden bg-page px-3">
        {spotlight && (
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-2/3"
            style={{ background: "radial-gradient(ellipse 55% 70% at 50% 0%, rgba(255,244,214,0.4), transparent 75%)" }}
          />
        )}
        {/* Selection cue: a soft accent-coloured circle glowing behind the
            camera, like a spotlight singling it out - replaces the default
            button focus ring (suppressed via outline-none above), which just
            drew a harsh rectangle around the whole tile. */}
        {selected && (
          <div
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
            style={{ background: "radial-gradient(circle at 50% 60%, color-mix(in srgb, var(--color-accent, #4f8ef7) 35%, transparent) 0%, transparent 65%)" }}
          />
        )}
        {/* Contact shadow - seats the camera on the shelf instead of floating. */}
        <div
          className="pointer-events-none absolute bottom-0 h-3.5 w-[60%]"
          style={{ background: "radial-gradient(ellipse, rgba(0,0,0,0.55), transparent 72%)" }}
        />
        <img
          src={gear.imageUrl ?? GENERIC_IMAGE.camera}
          alt=""
          loading="lazy"
          className={`relative max-h-[85%] w-auto object-contain transition duration-300 group-hover:scale-105 ${realPhotoFrame(!!gear.imageUrl)}`}
          style={{ filter: "drop-shadow(0 8px 6px rgba(0,0,0,0.6))" }}
        />
      </div>
      {/* Shelf top - lighter "back" edge catching the spotlight fading to a
          darker "front" edge, giving the plank a sense of depth/perspective.
          Always wood, even when selected - the circular glow behind the
          camera above is the one selection cue, not a repainted shelf. */}
      <div className="h-3.5 w-full" style={{ background: shelfTop, boxShadow: "inset 0 1px 0 rgba(255,255,255,0.25)" }} />
      {/* Front fascia - the shelf's vertical front face, always in shadow. */}
      <div className="h-2 w-full" style={{ background: fascia, boxShadow: "0 4px 8px rgba(0,0,0,0.5)" }} />

      <div className={`mt-2 w-[92%] rounded border border-border px-2 py-1.5 ${selected ? "bg-accent/10" : "bg-surface"}`}>
        <div className="truncate text-sm font-medium text-ink">{displayName(gear)}</div>
        <div className="truncate text-[11px] text-muted">
          {yearRange(gear)}
          {yearRange(gear) ? " · " : ""}
          {t("common.photos", { count: gear.photoCount })}
        </div>
      </div>
    </button>
  );
}
