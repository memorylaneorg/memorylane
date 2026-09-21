import { useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { hasPendingPageReads } from "../utils/pageLoad";
import { useTranslation } from "react-i18next";

// A practical initial-load measurement: API reads and visible images, followed
// by a short settling window. Freeze it before polling, slideshow advances or
// infinite scrolling become ongoing activity. Offscreen lazy images don't count.
export default function PageLoadTime() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigation = useRef({ key: location.key, start: 0 });
  const [elapsed, setElapsed] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (navigation.current.key !== location.key) {
      navigation.current = { key: location.key, start: performance.now() };
    }
    const start = navigation.current.start;
    let readySince: number | null = null;
    let imageSignature = "";
    setElapsed(null);
    const timer = window.setInterval(() => {
      const now = performance.now();
      const visibleImages = Array.from(document.images).filter((img) => {
        const rect = img.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight
          && rect.right > 0 && rect.left < window.innerWidth;
      });
      const signature = visibleImages.map((img) => img.currentSrc || img.src).join("\n");
      const busy = hasPendingPageReads() || visibleImages.some((img) => !img.complete);
      if (busy || signature !== imageSignature) readySince = null;
      imageSignature = signature;
      if (!busy) {
        readySince ??= now;
        if (now - readySince >= 250) {
          setElapsed(Math.max(0, readySince - start));
          window.clearInterval(timer);
        }
      }
    }, 50);
    return () => window.clearInterval(timer);
  }, [location.key, location.pathname, location.search]);

  return (
    <div
      className="pointer-events-none fixed bottom-2 right-3 z-50 rounded bg-page/80 px-2 py-1 text-[10px] tabular-nums text-muted opacity-60"
      title={t("common.pageLoadTitle")}
    >
      {elapsed === null ? t("common.pageLoading") : t("common.pageLoaded", { seconds: (elapsed / 1000).toFixed(2) })}
    </div>
  );
}
