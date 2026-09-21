import { useEffect, useRef, type RefObject } from "react";

// Observes a sentinel element and calls onLoadMore when it scrolls into view,
// as long as hasMore is true and a load isn't already in flight. Attach the
// returned ref to an empty div placed after the list being paginated.
//
// `scrollRootRef` - IntersectionObserver's root defaults to the page
// viewport, which is wrong for a list scrolling inside its own clipped
// container (e.g. a modal body with overflow-y: auto) - a sentinel below the
// fold there is still "visible" relative to the page even though it's
// scrolled out of view within the container. Pass the scrollable container's
// ref for that case; omit it for a normal page-level list.
export function useInfiniteScroll(
  onLoadMore: () => void,
  hasMore: boolean,
  loading: boolean,
  scrollRootRef?: RefObject<HTMLElement>,
) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !loading) {
          onLoadMoreRef.current();
        }
      },
      // Start loading a bit before the sentinel actually reaches the viewport
      // so the next page is ready by the time the user scrolls to the bottom.
      { root: scrollRootRef?.current ?? null, rootMargin: "600px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loading, scrollRootRef]);

  return sentinelRef;
}
