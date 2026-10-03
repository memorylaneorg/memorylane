import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MAP_SIZE, visibleMapTiles, type MapTile, type MapViewport } from "../utils/location-map";

function TileImage({ tile, view, onFailure, onSuccess }: { tile: MapTile; view: MapViewport; onFailure: () => void; onSuccess: () => void }) {
  const [loaded, setLoaded] = useState(false);
  return <img alt="" draggable={false} aria-hidden="true"
    src={`https://tile.openstreetmap.org/${tile.z}/${tile.column}/${tile.row}.png`}
    referrerPolicy="strict-origin-when-cross-origin"
    onLoad={() => { setLoaded(true); onSuccess(); }} onError={() => { setLoaded(false); onFailure(); }}
    className="absolute max-w-none"
    style={{ left: `${(tile.x - view.x) / view.width * 100}%`, top: `${(tile.y - view.y) / view.height * 100}%`,
      width: `${tile.size / view.width * 100}%`, height: `${tile.size / view.height * 100}%`, opacity: loaded ? 1 : 0 }} />;
}

export default function LocationBasemap({ view, outline, detailed }: {
  view: MapViewport; outline: string; detailed: boolean;
}) {
  const { t } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const [pixels, setPixels] = useState({ width: 0, ratio: 1 });
  const [settledView, setSettledView] = useState(view);
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => setPixels({ width: element.getBoundingClientRect().width, ratio: window.devicePixelRatio || 1 });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  useEffect(() => {
    // Wait for a pause in pan/zoom rather than requesting intermediate views.
    const timer = setTimeout(() => setSettledView(view), 150);
    return () => clearTimeout(timer);
  }, [view]);
  const tiles = useMemo(() => detailed && pixels.width > 0
    ? visibleMapTiles(settledView, pixels.width, pixels.ratio) : [], [detailed, settledView, pixels]);
  const keyFor = (tile: MapTile) => `${tile.z}/${tile.column}/${tile.row}`;
  const unavailable = tiles.some((tile) => failed.has(keyFor(tile)));
  return <div ref={container} className="pointer-events-none absolute inset-0 overflow-hidden">
    <svg viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`} className="absolute inset-0 h-full w-full" aria-hidden="true">
      <rect x={0} y={0} width={MAP_SIZE} height={MAP_SIZE} fill="var(--color-media)" />
      <path d={outline} fill="var(--color-paper-warm)" stroke="var(--color-border-strong)" strokeWidth={view.width / 1000} />
    </svg>
    {tiles.map((tile) => <TileImage key={`${attempt}:${keyFor(tile)}`} tile={tile} view={view}
      onSuccess={() => setFailed((old) => {
        if (!old.has(keyFor(tile))) return old;
        const remaining = new Set(old);
        remaining.delete(keyFor(tile));
        return remaining;
      })}
      onFailure={() => setFailed((old) => new Set(old).add(keyFor(tile)))} />)}
    {detailed && <div className="pointer-events-auto absolute bottom-1 right-1 z-10 rounded bg-white/95 px-2 py-1 text-[11px] text-black">
      © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" className="underline">OpenStreetMap</a> contributors
    </div>}
    {unavailable && <div role="status" className="pointer-events-auto absolute left-2 top-2 z-10 max-w-[70%] rounded bg-surface/95 p-2 text-xs text-ink shadow-card">
      {t("locationMap.unavailable")} <button type="button" className="text-accent underline"
        onClick={() => { setFailed(new Set()); setAttempt((old) => old + 1); }}>{t("common.retry")}</button>
    </div>}
  </div>;
}
