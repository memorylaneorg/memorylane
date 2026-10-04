import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import type { MediaDto } from "@memorylane/shared";
import { api } from "../api/client";
import MediaGrid from "../components/MediaGrid";
import Viewer from "../components/Viewer";
import { useInfiniteScroll } from "../hooks/useInfiniteScroll";
import { useTranslation } from "react-i18next";

const PAGE_SIZE = 200;

function dateRange(year: number, month: number): { from: string; to: string } {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const prefix = `${year}-${String(month).padStart(2, "0")}`;
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const monthEnd = `${prefix}-${String(lastDay).padStart(2, "0")}`;
  return { from: `${prefix}-01`, to: monthEnd < todayIso ? monthEnd : todayIso };
}

export default function TimelineMonthPage() {
  const { t } = useTranslation();
  const params = useParams<{ year: string; month: string }>();
  const year = Number(params.year);
  const month = Number(params.month);
  const today = new Date();
  const valid = Number.isInteger(year) && year >= 1990 && Number.isInteger(month) && month >= 1 && month <= 12
    && new Date(year, month - 1, 1).getTime() <= today.getTime();
  const [items, setItems] = useState<MediaDto[] | null>(null);
  const [total, setTotal] = useState(0);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const range = valid ? dateRange(year, month) : null;

  useEffect(() => {
    if (!range) return;
    setItems(null);
    void api.media.list(range, 0, PAGE_SIZE).then((result) => { setItems(result.items); setTotal(result.total); });
  }, [params.year, params.month]);

  const loadMore = useCallback(async () => {
    if (!range || items === null || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const result = await api.media.list(range, items.length, PAGE_SIZE);
      setItems((previous) => [...(previous ?? []), ...result.items]);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [items, range?.from, range?.to]);

  const hasMore = items !== null && items.length < total;
  const sentinelRef = useInfiniteScroll(loadMore, hasMore, loadingMore);
  if (!valid) return <Navigate to="/timeline" replace />;
  const label = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)));

  return (
    <div className="flex flex-col gap-5">
      <header>
        <nav className="mb-2 text-sm text-muted" aria-label={t("timeline.title")}><Link to="/timeline" className="hover:text-ink">{t("timeline.title")}</Link><span> / {label}</span></nav>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="font-serif text-3xl font-semibold text-ink">{label}</h1>
          {items !== null && <p className="text-sm text-muted">{t("timeline.items", { count: total })}</p>}
        </div>
      </header>
      {items === null && <p className="text-sm text-muted">{t("common.loading")}</p>}
      {items && items.length === 0 && <p className="text-sm text-muted">{t("timeline.monthEmpty")}</p>}
      {items && items.length > 0 && <MediaGrid items={items} onOpen={setViewerIndex} />}
      {hasMore && <div ref={sentinelRef} className="flex min-h-[60px] items-center justify-center text-sm text-muted">{loadingMore && t("timeline.loadingMore", { current: items?.length ?? 0, total })}</div>}
      {items && viewerIndex !== null && <Viewer items={items} startIndex={viewerIndex} onClose={() => setViewerIndex(null)} total={total} onRequestMore={loadMore} />}
    </div>
  );
}
