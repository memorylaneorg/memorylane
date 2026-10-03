import { useEffect, useState, type ImgHTMLAttributes } from "react";
import { loadImage } from "../utils/loadImage";

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "onLoad" | "onError"> & {
  src: string;
  thumbnailSrc: string;
  onUnavailable: () => void;
  onReady?: () => void;
};

/** Keep the cached preview visible until the requested image is decoded. */
export function ProgressiveImage({ src, thumbnailSrc, onUnavailable, onReady, ...props }: Props) {
  const [result, setResult] = useState<{ src: string; status: "ready" | "failed" } | null>(null);
  const [loadedThumbnail, setLoadedThumbnail] = useState<string | null>(null);
  const status = result?.src === src ? result.status : "loading";

  useEffect(() => loadImage(src,
    () => setResult({ src, status: "ready" }),
    () => setResult({ src, status: "failed" }),
  ), [src]);

  useEffect(() => {
    if (status === "failed") onUnavailable();
  }, [status, onUnavailable]);

  useEffect(() => {
    // A thumbnail may already have painted when the original fails. Its URL
    // stays the same, so we cannot rely on a second DOM load event.
    if (status === "ready" || (status === "failed" && loadedThumbnail === thumbnailSrc)) onReady?.();
  }, [status, loadedThumbnail, thumbnailSrc, onReady]);

  return <img {...props}
    src={status === "ready" ? src : thumbnailSrc}
    onLoad={() => {
      // Thumbnail paint must not trigger next-photo preloads or metadata
      // while the full image is still using the connection.
      if (status !== "ready") setLoadedThumbnail(thumbnailSrc);
    }}
    onError={() => {
      if (status === "ready") setResult({ src, status: "failed" });
    }}
  />;
}
