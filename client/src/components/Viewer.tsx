import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Sparkles, Star, X, ZoomIn, ZoomOut } from "lucide-react";
import { FOCAL_BUCKETS, type MediaDto } from "@memorylane/shared";
import { api } from "../api/client";
import { formatMemoryBlurb } from "../utils/blurb";
import { displaySrc } from "../utils/mediaSrc";
import { formatBytes, formatDuration } from "../utils/format";
import { useEngagementTracking } from "../hooks/useEngagementTracking";
import { usePluginActive } from "../utils/plugins";
import { ApplePreviewNotice } from "./ApplePreviewNotice";
import { OriginalUnavailableNotice } from "./OriginalUnavailableNotice";
import TagEditor from "./TagEditor";
import { useTranslation } from "react-i18next";

interface ViewerProps {
  items: MediaDto[];
  startIndex: number;
  onClose: () => void;
  // Starts the slideshow playing immediately instead of requiring a manual Play click.
  autoPlay?: boolean;
  // The real total item count in this set, when it's larger than `items`
  // (a paginated folder/favorites view) - without this, reaching the end of
  // whatever page happens to be loaded silently wraps back to photo 1
  // instead of fetching more, since `items.length` alone can't tell the
  // difference between "that's really all of them" and "just not loaded yet".
  total?: number;
  onRequestMore?: () => void | Promise<void>;
}

const SLIDESHOW_INTERVAL_MS = 5000;

export default function Viewer({ items, startIndex, onClose, autoPlay = false, total, onRequestMore }: ViewerProps) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(startIndex);
  const [fallback, setFallback] = useState(false);
  const [playing, setPlaying] = useState(autoPlay);
  // A Live Photo opens on its still image - this only becomes true once the
  // user explicitly taps the LIVE badge to play the paired ~3s video.
  const [livePlaying, setLivePlaying] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(!!document.fullscreenElement);
  const [favoriteOverrides, setFavoriteOverrides] = useState<Record<number, boolean>>({});
  const [openInPhotosError, setOpenInPhotosError] = useState<string | null>(null);
  // Zoom only ever applies to the still image, not video - reset on every
  // photo change (below) so zooming into one photo never carries over to
  // the next. Panning only does anything once zoom > 1; below that the
  // image is already fully visible, so a drag has nothing to reveal.
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const panStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const ZOOM_MIN = 1;
  const ZOOM_MAX = 4;
  const ZOOM_STEP = 0.5;
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();
  // Set when goNext() is waiting on more items to arrive rather than
  // wrapping - the effect below advances the index once they land.
  const awaitingMoreRef = useRef(false);

  const current = items[index];
  useEngagementTracking(current?.id);
  const aiSearchAvailable = usePluginActive("com.memorylane.ai-search");

  // Always land on the still image first when navigating to a new item, at
  // its default zoom - a zoomed-in view of the last photo carrying over to
  // the next one would be disorienting.
  useEffect(() => {
    setLivePlaying(false);
    setOpenInPhotosError(null);
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [current?.id]);

  const zoomIn = useCallback(() => setZoom((z) => Math.min(ZOOM_MAX, z + ZOOM_STEP)), []);
  const zoomOut = useCallback(() => {
    setZoom((z) => {
      const next = Math.max(ZOOM_MIN, z - ZOOM_STEP);
      if (next === ZOOM_MIN) setPan({ x: 0, y: 0 });
      return next;
    });
  }, []);

  // Pointer-based drag-to-pan (works for mouse and touch alike) - only takes
  // over once zoomed in; at zoom 1 the whole image already fits, and a
  // pointer-down there should fall through to the swipe-to-navigate handlers
  // below instead.
  const handleImagePointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
    if (zoom <= ZOOM_MIN) return;
    // Without this, the browser's own native image-drag gesture (picking the
    // <img> up as a draggable object) fights with the manual panning below -
    // pointermove events still fire, but the drag feels stuck/sluggish since
    // two different drag mechanisms are both trying to own the gesture.
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    panStartRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    setPanning(true);
  };
  const handleImagePointerMove = (e: React.PointerEvent<HTMLImageElement>) => {
    if (!panStartRef.current) return;
    const start = panStartRef.current;
    setPan({ x: start.panX + (e.clientX - start.x), y: start.panY + (e.clientY - start.y) });
  };
  const endImagePan = () => {
    panStartRef.current = null;
    setPanning(false);
  };
  const handleImageWheel = (e: React.WheelEvent<HTMLImageElement>) => {
    // Wheel zoom belongs only to the still image. Videos retain their native
    // controls and normal scrolling behavior because this handler is never
    // attached to either video element.
    e.preventDefault();
    const pixels = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 16
      : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? e.deltaY * window.innerHeight
        : e.deltaY;
    setZoom((currentZoom) => {
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, currentZoom - pixels * 0.0025));
      if (next === ZOOM_MIN) setPan({ x: 0, y: 0 });
      return next;
    });
  };

  const totalCount = total ?? items.length;

  const goNext = useCallback(() => {
    setFallback(false);
    setIndex((i) => {
      if (i < items.length - 1) return i + 1;
      // At the end of what's loaded - if the real set is bigger, fetch more
      // and stay put until it arrives, rather than wrapping to photo 1.
      if (items.length < totalCount && onRequestMore) {
        awaitingMoreRef.current = true;
        void onRequestMore();
        return i;
      }
      return 0;
    });
  }, [items.length, totalCount, onRequestMore]);

  const goPrev = useCallback(() => {
    setFallback(false);
    setIndex((i) => (i - 1 + items.length) % items.length);
  }, [items.length]);

  // Fires once the parent's items array actually grows past where we were
  // waiting - advancing here (rather than inside goNext itself) means it
  // still works no matter how long the fetch takes.
  useEffect(() => {
    if (awaitingMoreRef.current && items.length > index) {
      awaitingMoreRef.current = false;
      setIndex((i) => i + 1);
    }
  }, [items.length, index]);

  const goToFolder = useCallback(() => {
    if (!current) return;
    onClose();
    navigate(`/folder/${current.parentFolderId}`);
  }, [current, navigate, onClose]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && ["INPUT", "TEXTAREA"].includes((e.target as HTMLElement | null)?.tagName ?? "")) return;
      else if (e.key === "ArrowRight") goNext();
      else if (e.key === "ArrowLeft") goPrev();
      else if (e.key === " ") {
        // Don't hijack Space when a button/input (or a focused video, whose
        // own native space-to-pause should win) already owns it - a global
        // slideshow toggle stealing the keystroke out from under it would
        // fire both at once.
        const target = e.target as HTMLElement | null;
        if (target && ["BUTTON", "INPUT", "TEXTAREA", "A", "VIDEO"].includes(target.tagName)) return;
        e.preventDefault();
        setPlaying((p) => !p);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [goNext, goPrev, onClose]);

  // A video playing (standalone, or a Live Photo's tapped-into video) drives
  // its own advance via onEnded below instead of the fixed interval - cutting
  // it off after 5s regardless of length wouldn't feel like part of the same
  // slideshow, it'd feel like the video was interrupted.
  const isVideoActive = current?.mediaType === "video" || livePlaying;
  useEffect(() => {
    if (playing && !isVideoActive) {
      timerRef.current = setInterval(goNext, SLIDESHOW_INTERVAL_MS);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [playing, isVideoActive, goNext]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      overlayRef.current?.requestFullscreen().catch(() => {
        // Fullscreen can be denied (no user gesture, unsupported, iframe restrictions) - the
        // overlay already covers the whole viewport, so the slideshow still works fine without it.
      });
    }
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handleFullscreenChange);

    // Auto-play implies "start the full slideshow experience" - try to go fullscreen too.
    if (autoPlay && !document.fullscreenElement) {
      overlayRef.current?.requestFullscreen().catch(() => {});
    }

    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      // Don't leave the browser stuck in fullscreen once the viewer closes.
      if (document.fullscreenElement) void document.exitFullscreen();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Basic touch swipe support - disabled while zoomed in, where a touch
  // drag on the image means "pan around it" instead (see handleImagePointer*
  // above), not "go to the next photo".
  const touchStartX = useRef<number | null>(null);
  const handleTouchStart = (e: React.TouchEvent) => {
    if (zoom > ZOOM_MIN) return;
    touchStartX.current = e.touches[0].clientX;
  };
  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null) return;
    const delta = e.changedTouches[0].clientX - touchStartX.current;
    if (delta > 50) goPrev();
    else if (delta < -50) goNext();
    touchStartX.current = null;
  };

  if (!current) return null;

  const isFavorite = favoriteOverrides[current.id] ?? current.favorite;
  const toggleFavorite = async () => {
    const next = !isFavorite;
    setFavoriteOverrides((prev) => ({ ...prev, [current.id]: next }));
    try {
      await api.media.setFavorite(current.id, next);
    } catch {
      setFavoriteOverrides((prev) => ({ ...prev, [current.id]: !next }));
    }
  };

  // Jumps to Reports pre-filtered on exactly one EXIF value clicked in the
  // info panel below (only ever one at a time - "what else did I shoot with
  // this lens", not a combined filter across everything shown). Reports'
  // own filter state lives entirely in the URL (see ReportsPage.tsx's
  // filtersFromParams), so this just builds the same query string by hand -
  // only the couple of keys each call actually needs, not a full ReportFilters.
  const openReport = (params: Record<string, string>) => {
    onClose();
    navigate(`/reports?${new URLSearchParams(params).toString()}`);
  };

  const blurb = formatMemoryBlurb(current);

  // Reports facets the info panel below links out to - bucketed/rounded
  // exactly the way the server computes them (server/src/api/reports-routes.ts's
  // FACETS), so the linked report actually contains this photo rather than
  // coming up empty over a formatting mismatch.
  const focalBucket = current.focalLength != null
    ? FOCAL_BUCKETS.find((bucket) => current.focalLength! >= bucket.min && current.focalLength! <= bucket.max)
    : undefined;
  const apertureRounded = current.aperture != null ? current.aperture.toFixed(1) : undefined;
  const exifLinkClass = "underline decoration-white/30 underline-offset-2 hover:decoration-white hover:text-white";

  // Names of people in the current photo (People must be on; otherwise the
  // endpoint 404s and we show nothing). Loaded lazily per photo.
  const [peopleLine, setPeopleLine] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setPeopleLine(null);
    Promise.all([api.media.faces(current.id), api.persons.list(true)])
      .then(([faces, persons]) => {
        if (cancelled) return;
        const names = [...new Set(faces.filter((f) => f.personId !== null).map((f) => persons.find((p) => p.id === f.personId)?.displayName).filter(Boolean))];
        setPeopleLine(names.length ? names.join(", ") : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [current.id]);

  const controlButtonClass =
    "h-12 w-12 rounded-full border-none bg-overlay-control text-2xl text-white transition-colors hover:bg-overlay-control-hover";

  // True only for the plain still-image case - zoom/pan don't apply to
  // video or a Live Photo's playing clip, so the zoom controls and the
  // pan-drag handlers below only ever show up/take effect there.
  const isZoomable = current.mediaType !== "video" && !livePlaying;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[100] flex bg-overlay/97"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Everything except the info panel lives in this flex-1 column, so
          opening the info panel (a real sibling column now, not an overlay
          on top of the image - see below) shrinks this side instead of
          covering part of the photo. Every "absolute" element inside positions
          against this div, not the full-viewport outer one. */}
      <div className="relative flex flex-1 items-center justify-center overflow-hidden">
        {/* One flex row for the whole top-right cluster - each button used to be
            individually `absolute`-positioned with a manually chosen `right-N`
            offset (right-5/16/24), which didn't leave enough room for each
            button's own 48px width and left them overlapping (e.g. the AI
            "Find similar" button overlapping both its neighbors). A flex row
            lets the browser space them instead of hand-picked pixel math. */}
        <div className="absolute top-5 right-5 flex items-center gap-2">
          <button
            className={`grid place-items-center ${controlButtonClass}`}
            onClick={toggleFavorite}
            aria-label={isFavorite ? t("viewer.unfavorite") : t("viewer.favorite")}
            aria-pressed={isFavorite}
          >
            <Star
              size={22}
              strokeWidth={1.8}
              className={isFavorite ? "fill-amber-400 text-amber-400" : "text-white"}
            />
          </button>
          {aiSearchAvailable && (
            <button
              className={controlButtonClass}
              onClick={() => {
                onClose();
                navigate(`/similar/${current.id}`);
              }}
              aria-label={t("viewer.similar")}
              title={t("viewer.similar")}
            >
              <Sparkles size={16} strokeWidth={1.8} />
            </button>
          )}
          <button className={controlButtonClass} onClick={onClose} aria-label={t("viewer.close")}>
            ✕
          </button>
        </div>

        {current.sourceKind === "apple-photos" && !current.originalAvailable && (
          <ApplePreviewNotice error={openInPhotosError} onOpen={() => {
            void api.plugins.openInPhotos(current.id).catch((error: unknown) => {
              setOpenInPhotosError(error instanceof Error ? error.message : "Could not open Photos");
            });
          }} />
        )}

        <OriginalUnavailableNotice fallback={fallback} sourceKind={current.sourceKind} />

        <button
          className={`absolute top-1/2 left-5 -translate-y-1/2 ${controlButtonClass}`}
          onClick={goPrev}
          aria-label={t("viewer.previous")}
        >
          ‹
        </button>

        <div className="relative flex max-h-[82vh] max-w-[92vw] items-center justify-center">
          {current.mediaType === "video" ? (
            // Original file served as-is (see file-streaming.ts's Range support
            // for seeking) - no transcoding, so playback depends entirely on
            // what the browser's own <video> element can decode.
            <video
              key={current.id}
              src={api.media.fileUrl(current.id)}
              controls
              autoPlay
              // When the slideshow is running, a video's own length stands in
              // for the fixed photo interval - it advances when playback
              // actually finishes rather than being cut off mid-clip.
              onEnded={() => {
                if (playing) goNext();
              }}
              className="max-h-[82vh] max-w-[92vw] object-contain"
            />
          ) : current.livePhotoVideoId != null && livePlaying ? (
            <video
              key={`${current.id}-live`}
              src={api.media.fileUrl(current.livePhotoVideoId)}
              autoPlay
              controls
              onEnded={() => {
                setLivePlaying(false);
                if (playing) goNext();
              }}
              className="max-h-[82vh] max-w-[92vw] object-contain"
            />
          ) : (
            <img
              key={current.id}
              src={displaySrc(current, fallback)}
              alt={current.filename}
              draggable={false}
              onError={() => {
                if (!fallback) setFallback(true);
              }}
              onDragStart={(e) => e.preventDefault()}
              onPointerDown={handleImagePointerDown}
              onPointerMove={handleImagePointerMove}
              onPointerUp={endImagePan}
              onPointerLeave={endImagePan}
              onPointerCancel={endImagePan}
              onWheel={handleImageWheel}
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transition: panning ? "none" : "transform 0.15s ease-out",
                cursor: zoom > ZOOM_MIN ? (panning ? "grabbing" : "grab") : "default",
                touchAction: zoom > ZOOM_MIN ? "none" : "auto",
              }}
              className="max-h-[82vh] max-w-[92vw] select-none object-contain"
            />
          )}
          {current.livePhotoVideoId != null && !livePlaying && (
            <button
              onClick={() => setLivePlaying(true)}
              className="absolute top-3 left-3 flex items-center gap-1 rounded-full bg-overlay-control px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-overlay-control-hover"
              aria-label={t("viewer.playLive")}
            >
              ◉ LIVE
            </button>
          )}
          {current.rawPairId != null && (
            // The browser can't render a RAW file inline - this just opens the
            // original in a new tab, where the browser's own download handling
            // takes over (no in-app RAW viewer/editor).
            <a
              href={api.media.fileUrl(current.rawPairId)}
              target="_blank"
              rel="noopener noreferrer"
              className={`absolute left-3 flex items-center gap-1 rounded-full bg-overlay-control px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-overlay-control-hover ${
                current.livePhotoVideoId != null ? "top-12" : "top-3"
              }`}
              aria-label={t("viewer.openRaw")}
            >
              RAW
            </a>
          )}
        </div>

        <button
          className={`absolute top-1/2 right-5 -translate-y-1/2 ${controlButtonClass}`}
          onClick={goNext}
          aria-label={t("viewer.next")}
        >
          ›
        </button>

        <div className="absolute bottom-5 left-1/2 flex max-w-[92vw] -translate-x-1/2 flex-col items-center gap-1.5">
          <div className="flex flex-wrap items-center justify-center gap-4 rounded-full bg-overlay-control px-4 py-2 text-sm text-white">
            <button onClick={() => setPlaying((p) => !p)} className="text-white">
              {playing ? "Pause" : "Play"}
            </button>
            <span className="max-w-[240px] truncate">{current.filename}</span>
            <span>
              {index + 1} / {totalCount}
            </span>
            {isZoomable && (
              <span className="flex items-center gap-2">
                <button
                  onClick={zoomOut}
                  disabled={zoom <= ZOOM_MIN}
                  aria-label={t("viewer.zoomOut")}
                  title={t("viewer.zoomOut")}
                  className="text-white disabled:opacity-40"
                >
                  <ZoomOut size={16} strokeWidth={1.8} />
                </button>
                <button
                  onClick={zoomIn}
                  disabled={zoom >= ZOOM_MAX}
                  aria-label={t("viewer.zoomIn")}
                  title={t("viewer.zoomIn")}
                  className="text-white disabled:opacity-40"
                >
                  <ZoomIn size={16} strokeWidth={1.8} />
                </button>
              </span>
            )}
            <button onClick={() => setShowInfo((s) => !s)} className="text-white">
              Info
            </button>
            <button onClick={toggleFullscreen} className="text-white">
              {isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
            </button>
          </div>
          {/* Subtle caption below the photo, overlaid on the image rather than
              floating off to a corner. */}
          {blurb && <p className="text-xs font-medium text-white/60">{blurb}</p>}
          {peopleLine && <p className="text-xs font-medium text-white/70">People: {peopleLine}</p>}
        </div>
      </div>

      {/* A real side column next to the image, not an overlay on top of it -
          the flex-1 wrapper above shrinks to make room instead of the panel
          covering part of the photo. */}
      {showInfo && (
        <div className="relative flex w-full max-w-xs shrink-0 flex-col gap-2 overflow-y-auto bg-black/80 px-5 py-6 text-sm text-white sm:w-80">
          <button
            onClick={() => setShowInfo(false)}
            className="absolute top-4 right-4 text-white/70 hover:text-white"
            aria-label={t("viewer.closeInfo")}
          >
            <X size={18} strokeWidth={1.8} />
          </button>
          <h2 className="mb-1 pr-8 text-base font-semibold">{t("viewer.info")}</h2>
          {current.capturedDate && <div>Taken: {new Date(current.capturedDate).toLocaleString()}</div>}
          {current.cameraMake && (
            <div>
              {t("viewer.camera")}:{" "}
              {current.cameraModel ? (
                <button
                  onClick={() => openReport({ camera: current.cameraModel! })}
                  className={exifLinkClass}
                  title={t("viewer.cameraTitle")}
                >
                  {current.cameraMake} {current.cameraModel}
                </button>
              ) : (
                current.cameraMake
              )}
            </div>
          )}
          {current.lensModel && (
            <div>
              {t("viewer.lens")}:{" "}
              <button
                onClick={() => openReport({ lens: current.lensModel! })}
                className={exifLinkClass}
                title={t("viewer.lensTitle")}
              >
                {current.lensModel}
              </button>
            </div>
          )}
          {/* The four exposure settings ExifTool reads off nearly every
              camera - shown together as one line, only when at least one is
              actually present (a phone photo without a lens model might
              still have these; a screenshot or a scanned RAW-less JPEG
              usually has none). Each is independently clickable (except
              shutter speed, which Reports has no facet for) - one EXIF value
              at a time, not a combined filter across everything shown here. */}
          {(current.focalLength != null || current.aperture != null || current.shutterSpeed || current.iso != null) && (
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {current.focalLength != null && (
                focalBucket ? (
                  <button
                    onClick={() => openReport({ focalMin: String(focalBucket.min), focalMax: String(focalBucket.max) })}
                    className={exifLinkClass}
                    title={t("viewer.focalTitle")}
                  >
                    {t("viewer.focalLength", { value: current.focalLength })}
                  </button>
                ) : (
                  <span>{t("viewer.focalLength", { value: current.focalLength })}</span>
                )
              )}
              {current.aperture != null && (
                <button
                  onClick={() => openReport({ apertureMin: apertureRounded!, apertureMax: apertureRounded! })}
                  className={exifLinkClass}
                  title={t("viewer.apertureTitle")}
                >
                  f/{current.aperture}
                </button>
              )}
              {current.shutterSpeed && <span>{current.shutterSpeed}</span>}
              {current.iso != null && (
                <button
                  onClick={() => openReport({ isoMin: String(current.iso), isoMax: String(current.iso) })}
                  className={exifLinkClass}
                  title={t("viewer.isoTitle")}
                >
                  ISO {current.iso}
                </button>
              )}
            </div>
          )}
          {current.width && current.height && (
            <div>
              {t("viewer.dimensions", { width: current.width, height: current.height })}
            </div>
          )}
          <div>{t("viewer.type", { type: current.mediaType.toUpperCase() })}</div>
          <div>Size: {formatBytes(current.fileSize)}</div>
          {current.durationSeconds != null && <div>Duration: {formatDuration(current.durationSeconds)}</div>}
          <div className="break-all text-white/70">Path: {current.absolutePath}</div>
          <TagEditor mediaId={current.id} />
          <button
            onClick={goToFolder}
            className="mt-1 self-start text-left text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
          >
            Go to folder
          </button>
        </div>
      )}
    </div>
  );
}
