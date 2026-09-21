import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronDown, Download, X } from "lucide-react";
import {
  FOCAL_BUCKETS,
  type MediaDto,
  type ReportFacetsDto,
  type ReportFacetField,
  type MediaTypeFilter as MediaTypeFilterValue,
} from "@memorylane/shared";
import { api, type ReportFilters } from "../api/client";
import FacetPanel from "../components/FacetPanel";
import MediaGrid from "../components/MediaGrid";
import MediaTypeFilter from "../components/MediaTypeFilter";
import Viewer from "../components/Viewer";
import { useInfiniteScroll } from "../hooks/useInfiniteScroll";

const PAGE_SIZE = 200;

const FACET_TITLES: Record<ReportFacetField, string> = {
  lens: "Lens",
  camera: "Camera",
  make: "Make",
  aperture: "Aperture",
  iso: "ISO",
  focal: "Focal length",
  year: "Year",
};
const FACET_ORDER: ReportFacetField[] = ["lens", "camera", "aperture", "focal", "iso", "year", "make"];
const PRIMARY_FACETS: ReportFacetField[] = ["camera", "lens", "focal"];
const MORE_FACETS: ReportFacetField[] = ["aperture", "year", "make", "iso"];

// URL query string is the single source of truth for the current report, so
// a filtered view is bookmarkable/shareable and the back button works.
function filtersFromParams(sp: URLSearchParams): ReportFilters {
  const num = (k: string) => (sp.has(k) ? Number(sp.get(k)) : undefined);
  const str = (k: string) => sp.get(k) ?? undefined;
  return {
    lens: str("lens"),
    camera: str("camera"),
    make: str("make"),
    apertureMin: num("apertureMin"),
    apertureMax: num("apertureMax"),
    isoMin: num("isoMin"),
    isoMax: num("isoMax"),
    focalMin: num("focalMin"),
    focalMax: num("focalMax"),
    year: num("year"),
    from: str("from"),
    to: str("to"),
    type: (str("type") as MediaTypeFilterValue | undefined) ?? "all",
  };
}

// Which facet is "selected" is derived from the filters: exact-value facets
// map to one key and numeric facets map to a min==max pair.
function selectedFor(field: ReportFacetField, f: ReportFilters): string | undefined {
  switch (field) {
    case "lens":
      return f.lens;
    case "camera":
      return f.camera;
    case "make":
      return f.make;
    case "year":
      return f.year !== undefined ? String(f.year) : undefined;
    case "aperture":
      return f.apertureMin !== undefined && f.apertureMin === f.apertureMax ? String(f.apertureMin) : undefined;
    case "iso":
      return f.isoMin !== undefined && f.isoMin === f.isoMax ? String(f.isoMin) : undefined;
    case "focal":
      return FOCAL_BUCKETS.find((bucket) => bucket.min === f.focalMin && bucket.max === f.focalMax)?.key;
  }
}

function applyFacet(field: ReportFacetField, value: string | undefined, f: ReportFilters): ReportFilters {
  const next = { ...f };
  switch (field) {
    case "lens":
      next.lens = value;
      break;
    case "camera":
      next.camera = value;
      break;
    case "make":
      next.make = value;
      break;
    case "year":
      next.year = value !== undefined ? Number(value) : undefined;
      break;
    case "aperture":
      next.apertureMin = next.apertureMax = value !== undefined ? Number(value) : undefined;
      break;
    case "iso":
      next.isoMin = next.isoMax = value !== undefined ? Number(value) : undefined;
      break;
    case "focal": {
      const bucket = FOCAL_BUCKETS.find((item) => item.key === value);
      next.focalMin = bucket?.min;
      next.focalMax = bucket?.max;
      break;
    }
  }
  return next;
}

type Chip = { field: ReportFacetField | "dates"; label: string };

function activeChips(f: ReportFilters, facets: ReportFacetsDto | null): Chip[] {
  const chips: Chip[] = [];
  for (const field of FACET_ORDER) {
    const v = selectedFor(field, f);
    if (v === undefined) continue;
    const label = facets?.facets[field].find((b) => b.value === v)?.label ?? v;
    chips.push({ field, label: `${FACET_TITLES[field]}: ${label}` });
  }
  if (f.from || f.to) chips.push({ field: "dates", label: `${f.from ?? "…"} → ${f.to ?? "…"}` });
  return chips;
}

const dateInputClass = "rounded-md border border-border bg-page px-2 py-1 text-ink";

export default function ReportsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => filtersFromParams(searchParams), [searchParams]);
  const [facets, setFacets] = useState<ReportFacetsDto | null>(null);
  const [media, setMedia] = useState<MediaDto[] | null>(null);
  const [mediaTotal, setMediaTotal] = useState(0);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const loadingMoreRef = useRef(false);

  const setFilters = (next: ReportFilters) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) {
      if (v !== undefined && v !== "" && !(k === "type" && v === "all")) sp.set(k, String(v));
    }
    setSearchParams(sp);
  };

  useEffect(() => {
    let cancelled = false;
    setMedia(null);
    void Promise.all([api.reports.facets(filters), api.media.list(filters, 0, PAGE_SIZE)]).then(([fx, page]) => {
      if (cancelled) return;
      setFacets(fx);
      setMedia(page.items);
      setMediaTotal(page.total);
    });
    return () => {
      cancelled = true;
    };
  }, [filters]);

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || media === null) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const res = await api.media.list(filters, media.length, PAGE_SIZE);
      setMedia((prev) => [...(prev ?? []), ...res.items]);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [media, filters]);

  const hasMore = media !== null && media.length < mediaTotal;
  const sentinelRef = useInfiniteScroll(loadMore, hasMore, loadingMore);
  const chips = activeChips(filters, facets);
  const secondaryFilterActive = MORE_FACETS.some((field) => selectedFor(field, filters) !== undefined);
  const showMoreFilters = moreFiltersOpen || secondaryFilterActive;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-serif text-2xl font-semibold text-ink">Reports</h1>
          <p className="text-xs text-muted">
            {facets ? `${facets.total.toLocaleString()} photos with EXIF data match` : "Loading…"}
            {facets && <> · <Link to="/settings?tab=analysis#running-analysis" className="text-accent hover:underline">View analysis progress</Link></>}
            {" · "}
            <Link to="/gear-museum" className="text-accent hover:underline">Explore Gear Museum</Link>
            {" · "}
            <Link to="/gear-timeline" className="text-accent hover:underline">Explore Gear Timeline</Link>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <MediaTypeFilter value={filters.type ?? "all"} onChange={(type) => setFilters({ ...filters, type })} />
          <a
            href={api.reports.exportUrl(filters)}
            download
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-ink hover:bg-hover"
          >
            <Download size={14} strokeWidth={1.8} /> Export CSV
          </a>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label className="flex items-center gap-1.5 text-muted">
          From
          <input
            type="date"
            value={filters.from ?? ""}
            onChange={(e) => setFilters({ ...filters, from: e.target.value || undefined })}
            className={dateInputClass}
          />
        </label>
        <label className="flex items-center gap-1.5 text-muted">
          To
          <input
            type="date"
            value={filters.to ?? ""}
            onChange={(e) => setFilters({ ...filters, to: e.target.value || undefined })}
            className={dateInputClass}
          />
        </label>
        {chips.map((c) => (
          <button
            key={c.field}
            type="button"
            onClick={() =>
              c.field === "dates"
                ? setFilters({ ...filters, from: undefined, to: undefined })
                : setFilters(applyFacet(c.field, undefined, filters))
            }
            className="flex items-center gap-1 rounded-full bg-chip px-2.5 py-1 text-xs text-ink hover:bg-hover"
          >
            {c.label} <X size={12} />
          </button>
        ))}
        {chips.length > 0 && (
          <button
            type="button"
            onClick={() => setFilters({ type: filters.type })}
            className="text-xs text-muted underline hover:text-ink"
          >
            Clear all
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {PRIMARY_FACETS.map((field) => (
          <FacetPanel
            key={field}
            title={FACET_TITLES[field]}
            buckets={facets?.facets[field] ?? []}
            selected={selectedFor(field, filters)}
            onSelect={(v) => setFilters(applyFacet(field, v, filters))}
          />
        ))}
      </div>

      <div>
        <button type="button" aria-expanded={showMoreFilters} onClick={() => setMoreFiltersOpen((open) => !open)}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted hover:bg-hover hover:text-ink">
          More filters
          <ChevronDown size={14} aria-hidden className={`transition-transform ${showMoreFilters ? "rotate-180" : ""}`} />
        </button>
        {showMoreFilters && <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {MORE_FACETS.map((field) => <FacetPanel key={field} title={FACET_TITLES[field]}
            buckets={facets?.facets[field] ?? []} selected={selectedFor(field, filters)}
            onSelect={(v) => setFilters(applyFacet(field, v, filters))} />)}
        </div>}
      </div>

      {media === null && <p className="text-sm text-muted">Loading photos…</p>}
      {media && media.length === 0 && (
        <p className="text-sm text-muted">
          No photos match. EXIF data is captured during scans - if the library was indexed before this feature, the
          backfill under Settings → Analysis fills it in.
        </p>
      )}
      {media && media.length > 0 && <MediaGrid items={media} onOpen={setViewerIndex} />}

      {hasMore && (
        <div ref={sentinelRef} className="flex min-h-[60px] items-center justify-center text-sm">
          {loadingMore && (
            <span className="text-muted">
              Loading more ({media?.length ?? 0} / {mediaTotal})…
            </span>
          )}
        </div>
      )}

      {media && viewerIndex !== null && (
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
