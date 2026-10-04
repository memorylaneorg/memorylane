import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import type { MediaDto } from "@memorylane/shared";
import { api } from "../api/client";
import MediaGrid from "../components/MediaGrid";
import Viewer from "../components/Viewer";
import { useInfiniteScroll } from "../hooks/useInfiniteScroll";
import { useTranslation } from "react-i18next";

const PAGE_SIZE = 200;

type DayPeriod = "morning" | "afternoon" | "evening" | "night";

const DAY_PERIODS: Array<{ key: DayPeriod; range: string }> = [
  { key: "morning", range: "5:00 AM – 11:59 AM" },
  { key: "afternoon", range: "12:00 PM – 4:59 PM" },
  { key: "evening", range: "5:00 PM – 8:59 PM" },
  { key: "night", range: "9:00 PM – 4:59 AM" },
];

function captureHour(media: MediaDto): number {
  const match = media.capturedDate?.match(/[T ](\d{2}):/);
  return match ? Number(match[1]) : 0;
}

function periodFor(media: MediaDto): DayPeriod {
  const hour = captureHour(media);
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
}

export default function MomentDayPage() {
  const { t } = useTranslation();
  const { date = "" } = useParams<{ date: string }>();
  const [params] = useSearchParams();
  const detection = params.get("detection");
  const [items, setItems] = useState<MediaDto[] | null>(null);
  const [total, setTotal] = useState(0);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= "1990-01-01" && date <= new Date().toISOString().slice(0, 10);

  useEffect(() => {
    if (valid) {
      void api.media.list({ from: date, to: date }, 0, PAGE_SIZE).then((result) => {
        setItems(result.items);
        setTotal(result.total);
      });
    }
  }, [date, valid]);

  const loadMore = useCallback(async () => {
    if (!valid || !items || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const result = await api.media.list({ from: date, to: date }, items.length, PAGE_SIZE);
      setItems((previous) => [...(previous ?? []), ...result.items]);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [date, items, valid]);

  const periods = useMemo(() => DAY_PERIODS.map((period) => ({
    ...period,
    items: (items ?? []).filter((media) => periodFor(media) === period.key),
  })).filter((period) => period.items.length > 0), [items]);

  const hasMore = !!items && items.length < total;
  const sentinel = useInfiniteScroll(loadMore, hasMore, loading);
  if (!valid) return <Navigate to="/moments" replace />;

  const label = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
  const openMedia = (media: MediaDto) => setViewerIndex(items?.findIndex((candidate) => candidate.id === media.id) ?? null);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <nav className="mb-2 text-sm text-muted" aria-label={t("moments.title")}><Link to={`/moments${detection && detection !== "balanced" ? `?detection=${detection}` : ""}`} className="hover:text-ink">{t("moments.title")}</Link><span> / {label}</span></nav>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h1 className="font-serif text-3xl font-semibold text-ink">{label}</h1>
            <p className="mt-1 text-sm text-muted">{t("moments.dayTimeline")}</p>
          </div>
          {items && <p className="text-sm text-muted">{t("moments.items", { count: total })}</p>}
        </div>
      </header>

      {!items && <p className="text-sm text-muted">{t("common.loading")}</p>}
      {items && (
        <div className="relative space-y-9 border-l border-border pl-6 sm:pl-10">
          {periods.map((period) => (
            <section key={period.key} className="relative">
              <span className="absolute -left-[29px] top-2 size-2 rounded-full bg-accent ring-4 ring-accent/10 sm:-left-[45px]" />
              <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 className="text-xl font-semibold text-ink">{t(`moments.period.${period.key}`)}</h2>
                <p className="text-xs text-muted">{period.range}</p>
                <p className="text-sm text-muted">{t("moments.items", { count: period.items.length })}</p>
              </div>
              <MediaGrid items={period.items} onOpen={(index) => openMedia(period.items[index])} />
            </section>
          ))}
        </div>
      )}

      {hasMore && <div ref={sentinel} className="min-h-[60px] text-center text-sm text-muted">{loading && t("moments.loadingMore", { current: items?.length ?? 0, total })}</div>}
      {items && viewerIndex !== null && viewerIndex >= 0 && <Viewer items={items} startIndex={viewerIndex} onClose={() => setViewerIndex(null)} total={total} onRequestMore={loadMore} />}
    </div>
  );
}
