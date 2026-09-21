import { useEffect, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  // The scrollable body's own ref - callers that paginate a list inside the
  // modal need this to pass as useInfiniteScroll's scrollRootRef, since the
  // body clips its own scroll independent of the page viewport.
  bodyRef?: RefObject<HTMLDivElement>;
  // Slightly wider than the default for content-heavy modals (e.g. a list
  // with row detail) - most modals should leave this at the default.
  wide?: boolean;
}

// A generic centered dialog: backdrop, Escape-to-close, click-outside-to-
// close, and a bounded/scrollable body independent of the page underneath -
// used both for the video-modernization candidates list and its preview
// lightbox, rather than either growing the Settings page itself or eagerly
// rendering everything inline.
export default function Modal({ title, onClose, children, bodyRef, wide = false }: ModalProps) {
  const { t } = useTranslation();
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-overlay/80 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`flex max-h-[85vh] w-full flex-col rounded-lg border border-border bg-surface shadow-card ${
          wide ? "max-w-3xl" : "max-w-xl"
        }`}
      >
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-4 py-3">
          <h2 className="font-serif text-base font-semibold text-ink">{title}</h2>
          <button
            onClick={onClose}
            aria-label={t("common.close")}
            className="grid size-7 place-items-center rounded text-muted hover:bg-hover hover:text-ink"
          >
            ✕
          </button>
        </div>
        <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto p-4">
          {children}
        </div>
      </div>
    </div>
  );
}
