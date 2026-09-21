import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { LocationCellDto, LocationItemDto, LocationSummaryDto, MediaDto } from "@memorylane/shared";
import land from "../assets/ne_110m_land.json";
import { api, type LocationBounds, type LocationFilters } from "../api/client";
import Viewer from "../components/Viewer";
import { useTranslation } from "react-i18next";
import { landPath, MAP_SIZE, project, viewportBounds, type LandCollection, type MapViewport } from "../utils/location-map";

const BASE_HEIGHT = 520;
const DEFAULT_VIEW: MapViewport = { x: 0, y: (MAP_SIZE - BASE_HEIGHT) / 2, width: MAP_SIZE, height: BASE_HEIGHT };
const SOURCE_OPTIONS = [
  { value: "all", label: "All sources" },
  { value: "filesystem", label: "Folders" },
  { value: "apple", label: "Apple Photos" },
] as const;

function clampView(view: MapViewport): MapViewport {
  return {
    ...view,
    x: Math.max(0, Math.min(MAP_SIZE - view.width, view.x)),
    y: Math.max(0, Math.min(MAP_SIZE - view.height, view.y)),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Could not load locations";
}

export default function LocationsPage() {
  const { t } = useTranslation();
  const [source, setSource] = useState<LocationFilters["source"]>("all");
  const [fromYear, setFromYear] = useState<number | undefined>();
  const [toYear, setToYear] = useState<number | undefined>();
  const [summary, setSummary] = useState<LocationSummaryDto | null>(null);
  const [cells, setCells] = useState<LocationCellDto[]>([]);
  const [visibleCount, setVisibleCount] = useState(0);
  const [view, setView] = useState<MapViewport>(DEFAULT_VIEW);
  const [zoom, setZoom] = useState(0);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedBounds, setSelectedBounds] = useState<LocationBounds | null>(null);
  const [items, setItems] = useState<LocationItemDto[]>([]);
  const [itemTotal, setItemTotal] = useState(0);
  const [mediaTotal, setMediaTotal] = useState(0);
  const [loadingMap, setLoadingMap] = useState(false);
  const [loadingItems, setLoadingItems] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const mapRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; view: MapViewport; moved: boolean; cellKey: string | null } | null>(null);
  const suppressClick = useRef(false);
  const selectionVersion = useRef(0);
  const outline = useMemo(() => landPath(land as unknown as LandCollection), []);
  const filters = useMemo<LocationFilters>(() => ({ source, fromYear, toYear }), [source, fromYear, toYear]);

  useEffect(() => {
    let active = true;
    void api.locations.summary({ source }).then((value) => {
      if (active) setSummary(value);
    }).catch((cause: unknown) => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [source]);

  useEffect(() => {
    let active = true;
    setLoadingMap(true);
    const timer = setTimeout(() => {
      void api.locations.cells(filters, viewportBounds(view), zoom).then((result) => {
        if (!active) return;
        setCells(result.items);
        setVisibleCount(result.total);
        setError(null);
      }).catch((cause: unknown) => { if (active) setError(message(cause)); })
        .finally(() => { if (active) setLoadingMap(false); });
    }, 150);
    return () => { active = false; clearTimeout(timer); };
  }, [filters, view, zoom]);

  useEffect(() => {
    selectionVersion.current++;
    setSelectedKey(null);
    setSelectedBounds(null);
    setItems([]);
    setItemTotal(0);
    setMediaTotal(0);
    setViewerIndex(null);
  }, [source, fromYear, toYear, zoom, view]);

  useEffect(() => {
    const version = ++selectionVersion.current;
    if (!selectedKey || !selectedBounds) return;
    setItems([]);
    setItemTotal(0);
    setMediaTotal(0);
    setLoadingItems(true);
    void api.locations.items(selectedKey, filters, selectedBounds).then((result) => {
      if (selectionVersion.current !== version) return;
      setItems(result.items);
      setItemTotal(result.total);
      setMediaTotal(result.mediaTotal);
    }).catch((cause: unknown) => { if (selectionVersion.current === version) setError(message(cause)); })
      .finally(() => { if (selectionVersion.current === version) setLoadingItems(false); });
  }, [selectedKey, selectedBounds, filters]);

  const loadMore = async (untilMedia = false) => {
    if (!selectedKey || !selectedBounds || loadingItems || items.length >= itemTotal) return;
    const version = selectionVersion.current;
    setLoadingItems(true);
    try {
      const nextItems: LocationItemDto[] = [];
      let offset = items.length;
      while (offset < itemTotal) {
        const result = await api.locations.items(selectedKey, filters, selectedBounds, offset);
        if (selectionVersion.current !== version) return;
        nextItems.push(...result.items);
        offset += result.items.length;
        if (!untilMedia || result.items.some((item) => item.kind === "media") || result.items.length === 0) break;
      }
      if (selectionVersion.current !== version) return;
      setItems((old) => [...old, ...nextItems]);
    } catch (cause) { if (selectionVersion.current === version) setError(message(cause)); }
    finally { if (selectionVersion.current === version) setLoadingItems(false); }
  };

  const mediaItems = items.flatMap((item) => item.kind === "media" ? [item.media] : []);
  const zoomTo = (nextZoom: number) => {
    const next = Math.max(0, Math.min(10, nextZoom));
    if (next === zoom) return;
    const factor = 2 ** next;
    const width = MAP_SIZE / factor, height = BASE_HEIGHT / factor;
    setView((old) => clampView({ x: old.x + (old.width - width) / 2, y: old.y + (old.height - height) / 2, width, height }));
    setZoom(next);
  };
  const pan = (dx: number, dy: number) => setView((old) => clampView({ ...old, x: old.x + dx, y: old.y + dy }));
  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    suppressClick.current = false;
    const cellKey = (event.target as Element).closest("[data-cell-key]")?.getAttribute("data-cell-key") ?? null;
    drag.current = { x: event.clientX, y: event.clientY, view, moved: false, cellKey };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!drag.current || !mapRef.current) return;
    const rect = mapRef.current.getBoundingClientRect();
    const dx = event.clientX - drag.current.x, dy = event.clientY - drag.current.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.current.moved = true;
    if (!drag.current.moved) return;
    setView(clampView({ ...drag.current.view,
      x: drag.current.view.x - dx / rect.width * drag.current.view.width,
      y: drag.current.view.y - dy / rect.height * drag.current.view.height }));
  };
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomTo(zoom + (event.deltaY < 0 ? 1 : -1));
    };
    map.addEventListener("wheel", onWheel, { passive: false });
    return () => map.removeEventListener("wheel", onWheel);
  }, [zoom]);
  const years = summary?.years ?? [];
  const maxCellCount = cells.reduce((max, cell) => Math.max(max, cell.count), 1);
  const firstYear = years[0]?.year ?? new Date().getFullYear();
  const lastYear = years.at(-1)?.year ?? firstYear;
  const minYear = Math.min(firstYear, fromYear ?? firstYear, toYear ?? firstYear);
  const maxYear = Math.max(lastYear, fromYear ?? lastYear, toYear ?? lastYear);
  const maxYearCount = Math.max(1, ...years.map((entry) => entry.count));
  const rangeActive = fromYear !== undefined || toYear !== undefined;

  return <div className="space-y-5">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><h1 className="font-serif text-3xl font-semibold text-ink">{t("pages.locations")}</h1>
        <p className="mt-1 text-sm text-muted">Explore where your photos were taken. The map works offline.</p></div>
      <span className="text-sm tabular-nums text-muted">{visibleCount.toLocaleString()} photos in view{loadingMap ? " · Updating…" : ""}</span>
    </div>
    <div className="flex flex-wrap gap-2" role="group" aria-label="Photo source">
      {SOURCE_OPTIONS.map((option) => <button key={option.value} type="button" onClick={() => setSource(option.value)}
        aria-pressed={source === option.value}
        className={`rounded-full border px-3 py-1.5 text-sm ${source === option.value ? "border-accent bg-accent/15 text-accent" : "border-border bg-surface text-ink hover:bg-hover"}`}>
        {option.label}
      </button>)}
    </div>
    {summary && years.length > 0 && <section className="rounded-lg border border-border bg-surface p-4" aria-label="Time filter">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <strong className="text-ink">Time</strong>
        <span className="text-muted">{rangeActive ? `${fromYear ?? minYear}–${toYear ?? maxYear}` : "All years"} · {summary.total.toLocaleString()} located{summary.undated > 0 ? ` · ${summary.undated.toLocaleString()} undated` : ""}</span>
        {rangeActive && <button type="button" onClick={() => { setFromYear(undefined); setToYear(undefined); }} className="text-accent underline">Clear range</button>}
      </div>
      <div className="mt-3 flex h-12 items-end gap-px" role="img" aria-label="Photos by year">
        {years.map(({ year, count }) => <button key={year} type="button" title={`${year}: ${count.toLocaleString()} photos`}
          onClick={() => { setFromYear(year); setToYear(year); }}
          className={`min-w-1 flex-1 rounded-t-sm ${rangeActive && (year < (fromYear ?? minYear) || year > (toYear ?? maxYear)) ? "bg-faint/40" : "bg-accent"}`}
          style={{ height: `${Math.max(8, count / maxYearCount * 100)}%` }} aria-label={`Show ${year}`} />)}
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="flex items-center gap-3 text-sm text-muted">From <span className="tabular-nums text-ink">{fromYear ?? minYear}</span>
          <input type="range" min={minYear} max={maxYear} value={fromYear ?? minYear}
            onChange={(event) => { const value = Number(event.target.value); setFromYear(value); setToYear((old) => Math.max(value, old ?? maxYear)); }}
            className="min-w-0 flex-1" aria-label="Start year" /></label>
        <label className="flex items-center gap-3 text-sm text-muted">To <span className="tabular-nums text-ink">{toYear ?? maxYear}</span>
          <input type="range" min={minYear} max={maxYear} value={toYear ?? maxYear}
            onChange={(event) => { const value = Number(event.target.value); setToYear(value); setFromYear((old) => Math.min(value, old ?? minYear)); }}
            className="min-w-0 flex-1" aria-label="End year" /></label>
      </div>
    </section>}
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    <div className="overflow-hidden rounded-xl border border-border bg-media shadow-card">
      <div className="relative">
        <svg ref={mapRef} viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`} className="aspect-[1000/520] w-full cursor-grab touch-none active:cursor-grabbing"
          role="region" aria-label="Interactive photo location map" tabIndex={0}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={(event) => {
            const released = drag.current;
            suppressClick.current = released?.moved ?? false;
            drag.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            if (released?.cellKey && !released.moved) {
              suppressClick.current = true;
              setSelectedBounds(viewportBounds(view));
              setSelectedKey(released.cellKey);
            }
          }}
          onPointerCancel={() => { drag.current = null; }}
          onKeyDown={(event) => {
            if (event.key === "+" || event.key === "=") zoomTo(zoom + 1);
            else if (event.key === "-") zoomTo(zoom - 1);
            else if (event.key === "ArrowLeft") pan(-view.width / 8, 0);
            else if (event.key === "ArrowRight") pan(view.width / 8, 0);
            else if (event.key === "ArrowUp") pan(0, -view.height / 8);
            else if (event.key === "ArrowDown") pan(0, view.height / 8);
            else return;
            event.preventDefault();
          }}>
          <defs><radialGradient id="location-heat"><stop offset="0%" stopColor="#ef4444" stopOpacity="0.7" /><stop offset="100%" stopColor="#f97316" stopOpacity="0" /></radialGradient></defs>
          <rect x={0} y={0} width={MAP_SIZE} height={MAP_SIZE} fill="var(--color-media)" />
          <path d={outline} fill="var(--color-paper-warm)" stroke="var(--color-border-strong)" strokeWidth={view.width / 1000} />
          {cells.map((cell) => {
            const point = project(cell.lon, cell.lat);
            const radius = Math.min(29, 7 + Math.sqrt(cell.count) * 1.4) * view.width / 1000;
            const intensity = Math.log1p(cell.count) / Math.log1p(maxCellCount);
            return <g key={cell.key} data-cell-key={cell.key} role="button" tabIndex={0} aria-label={`${cell.count} photos near ${cell.lat.toFixed(2)}, ${cell.lon.toFixed(2)}`}
              onClick={(event) => { event.stopPropagation(); if (suppressClick.current) { suppressClick.current = false; return; } setSelectedBounds(viewportBounds(view)); setSelectedKey(cell.key); }}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedBounds(viewportBounds(view)); setSelectedKey(cell.key); } }}
              className="cursor-pointer">
              <circle cx={point.x} cy={point.y} r={radius * 2.2} fill="url(#location-heat)" opacity={0.35 + intensity * 0.65} />
              <circle cx={point.x} cy={point.y} r={radius} fill={intensity > 0.65 ? "#dc2626" : intensity > 0.3 ? "#ea580c" : "#f59e0b"}
                fillOpacity={0.48 + intensity * 0.48} stroke="white" strokeWidth={view.width / 500} />
              {cell.count > 1 && <text x={point.x} y={point.y} dominantBaseline="central" textAnchor="middle" fill="white"
                fontSize={Math.min(13, radius / (view.width / 1000)) * view.width / 1000} fontWeight={700} pointerEvents="none">{cell.count > 999 ? `${Math.round(cell.count / 1000)}k` : cell.count}</text>}
            </g>;
          })}
        </svg>
        <div className="absolute right-3 top-3 flex flex-col gap-1">
          <button type="button" onClick={() => zoomTo(zoom + 1)} disabled={zoom === 10} aria-label="Zoom in" className="rounded bg-surface px-3 py-1 text-lg text-ink shadow-card disabled:opacity-50">+</button>
          <button type="button" onClick={() => zoomTo(zoom - 1)} disabled={zoom === 0} aria-label="Zoom out" className="rounded bg-surface px-3 py-1 text-lg text-ink shadow-card disabled:opacity-50">−</button>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-surface px-4 py-2 text-xs text-muted">
        <span>Drag to pan · scroll or use +/− to zoom · select a circle to browse</span>
        <span><span className="mr-1 inline-block size-2 rounded-full bg-orange-600" /> Brighter and larger circles contain more photos</span>
      </div>
    </div>
    {!loadingMap && visibleCount === 0 && <p className="rounded-lg border border-border bg-surface p-4 text-sm text-muted">No photos with locations match this view. Try another year, source, or map area.</p>}
    {source !== "filesystem" && <p className="text-xs text-muted">Apple Photos catalog locations refresh when you run <Link to="/settings" className="text-accent underline">Sync now in Settings</Link>. Items without a local image can still appear here when Photos provides a location.</p>}
    {selectedKey && <section className="space-y-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-3"><h2 className="font-serif text-xl text-ink">Photos here <span className="font-sans text-sm text-muted">{itemTotal.toLocaleString()}</span></h2>
        <button type="button" onClick={() => { setSelectedKey(null); setSelectedBounds(null); }} aria-label="Close location results" className="text-sm text-accent">Close</button></div>
      {loadingItems && items.length === 0 && <p className="text-sm text-muted">Loading photos…</p>}
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {items.map((item, index) => item.kind === "media" ? <button key={`m:${item.media.id}:${index}`} type="button"
          onClick={() => setViewerIndex(mediaItems.findIndex((media) => media.id === item.media.id))}
          className="overflow-hidden rounded-lg border border-border bg-media text-left">
          {item.media.thumbnailStatus === "done" ? <img src={api.media.thumbnailUrl(item.media.id, item.media.thumbnailVersion)} alt="" loading="lazy" className="aspect-square w-full object-cover" />
            : <div className="flex aspect-square items-center justify-center text-muted">No preview</div>}
          <span className="block truncate p-2 text-xs text-ink" title={item.media.filename}>{item.media.filename}</span>
        </button> : <article key={`a:${item.rootId}:${item.uuid}`} className="rounded-lg border border-border bg-media p-3 text-xs">
          <div className="flex aspect-square items-center justify-center text-center text-muted">Image not local</div>
          <p className="truncate text-ink" title={item.filename}>{item.filename}</p>
          {item.date && <p className="text-muted">{item.date.slice(0, 10)}</p>}
          <button type="button" className="mt-2 text-accent underline" onClick={() => void api.plugins.openCatalogItemInPhotos(item.rootId, item.uuid).catch((cause: unknown) => setError(message(cause)))}>Open in Photos</button>
        </article>)}
      </div>
      {items.length < itemTotal && <button type="button" onClick={() => void loadMore()} disabled={loadingItems}
        className="rounded-md border border-border px-3 py-1.5 text-sm text-ink disabled:opacity-50">Load more</button>}
    </section>}
    {viewerIndex !== null && <Viewer items={mediaItems as MediaDto[]} startIndex={viewerIndex} total={mediaTotal}
      onRequestMore={() => loadMore(true)} onClose={() => setViewerIndex(null)} />}
  </div>;
}
