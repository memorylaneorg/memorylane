import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  // Red confirm button for destructive actions.
  danger?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;
type NoticeFn = (opts: { title: string; message: ReactNode }) => Promise<void>;

const ConfirmContext = createContext<{ confirm: ConfirmFn; notice: NoticeFn } | null>(null);

interface Pending extends ConfirmOptions {
  noticeOnly?: boolean;
  resolve: (ok: boolean) => void;
}

// In-app replacement for window.confirm / window.alert: same promise-style
// call sites, but styled like the rest of the app (the native dialog looks
// foreign and can't be themed). Mount <ConfirmProvider> once near the root;
// call `const { confirm } = useConfirm()` anywhere below it.
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  const confirm = useCallback<ConfirmFn>(
    (opts) =>
      new Promise<boolean>((resolve) => {
        setPending({ ...opts, resolve });
      }),
    [],
  );
  const notice = useCallback<NoticeFn>(
    (opts) =>
      new Promise<void>((resolve) => {
        setPending({ ...opts, noticeOnly: true, confirmLabel: "OK", resolve: () => resolve() });
      }),
    [],
  );

  const close = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };

  useEffect(() => {
    if (!pending) return;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  return (
    <ConfirmContext.Provider value={{ confirm, notice }}>
      {children}
      {pending && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-overlay/70 p-4" onClick={() => close(false)} role="presentation">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-lg border border-border bg-surface p-5 shadow-card"
          >
            <h2 id="confirm-title" className="font-serif text-lg font-semibold text-ink">
              {pending.title}
            </h2>
            <div className="mt-2 text-sm text-muted">{pending.message}</div>
            <div className="mt-5 flex justify-end gap-2">
              {!pending.noticeOnly && (
                <button
                  type="button"
                  onClick={() => close(false)}
                  className="rounded-md border border-border px-3.5 py-2 text-sm text-ink hover:bg-hover"
                >
                  {pending.cancelLabel ?? "Cancel"}
                </button>
              )}
              <button
                ref={confirmRef}
                type="button"
                onClick={() => close(true)}
                className={`rounded-md px-3.5 py-2 text-sm font-semibold ${
                  pending.danger ? "bg-red-600 text-white hover:bg-red-700" : "bg-accent text-page hover:opacity-90"
                }`}
              >
                {pending.confirmLabel ?? "Continue"}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within ConfirmProvider");
  return ctx;
}
