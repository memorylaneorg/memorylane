import { useCallback, useEffect, useRef, useState } from "react";
import type { MediaDto, MediaTypeFilter as MediaTypeFilterValue } from "@memorylane/shared";
import { api } from "../api/client";
import MediaGrid from "../components/MediaGrid";
import MediaTypeFilter from "../components/MediaTypeFilter";
import Viewer from "../components/Viewer";
import { useInfiniteScroll } from "../hooks/useInfiniteScroll";
import { useTranslation } from "react-i18next";

const PAGE_SIZE = 200;

export default function FavoritesPage() {
  const { t } = useTranslation();
  const [media, setMedia] = useState<MediaDto[] | null>(null);
  const [mediaTotal, setMediaTotal] = useState(0);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [mediaType, setMediaType] = useState<MediaTypeFilterValue>("all");
  const loadingMoreRef = useRef(false);

  const load = useCallback((type: MediaTypeFilterValue) => {
    void api.favorites.list(0, PAGE_SIZE, type).then((res) => {
      setMedia(res.items);
      setMediaTotal(res.total);
    });
  }, []);

  useEffect(() => {
    load("all");
  }, [load]);

  const changeMediaType = (type: MediaTypeFilterValue) => {
    setMediaType(type);
    setMedia(null);
    load(type);
  };

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || media === null) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const res = await api.favorites.list(media.length, PAGE_SIZE, mediaType);
      setMedia((prev) => [...(prev ?? []), ...res.items]);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [media, mediaType]);

  const hasMore = media !== null && media.length < mediaTotal;
  const sentinelRef = useInfiniteScroll(loadMore, hasMore, loadingMore);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-serif text-2xl font-semibold text-ink">{t("pages.favorites")}</h1>
        <MediaTypeFilter value={mediaType} onChange={changeMediaType} />
      </div>

      {media === null && <p className="text-sm text-muted">{t("common.loading")}</p>}
      {media && media.length === 0 && (
        <p className="text-sm text-muted">
          {mediaType === "all"
            ? t("pages.noFavorites")
            : `No favorite ${mediaType === "photo" ? "photos" : "videos"} yet.`}
        </p>
      )}
      {media && media.length > 0 && <MediaGrid items={media} onOpen={setViewerIndex} />}

      {hasMore && (
        <div ref={sentinelRef} className="flex min-h-[60px] items-center justify-center text-sm">
          {loadingMore && (
            <span className="text-muted">
              Loading more ({media?.length ?? 0} / {mediaTotal})...
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
