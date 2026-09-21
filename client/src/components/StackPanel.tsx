import { useCallback, useEffect, useState } from "react";
import type { MediaDto, StackDetailDto } from "@memorylane/shared";
import { api, ApiError } from "../api/client";
import Modal from "./Modal";
import MediaGrid from "./MediaGrid";
import Viewer from "./Viewer";
import { useConfirm } from "./ConfirmDialog";
import { useTranslation } from "react-i18next";

interface StackPanelProps {
  stackId: number;
  onClose: () => void;
  // Fired after any change (cover, split, remove, delete) so the page
  // behind can refresh its collapsed grid.
  onChanged: () => void;
}

const buttonClass =
  "rounded-md border border-border px-3 py-1.5 text-sm text-ink hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40";

// Expanded view of one stack: every member selectable, with the user
// operations from design doc §8.5. Members are shown in stack order; the
// cover is marked by its badge in the grid.
export default function StackPanel({ stackId, onClose, onChanged }: StackPanelProps) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<StackDetailDto | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm } = useConfirm();

  const load = useCallback(async () => {
    try {
      setDetail(await api.stacks.get(stackId));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        onChanged();
        onClose();
        return;
      }
      throw err;
    }
  }, [stackId, onChanged, onClose]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (m: MediaDto) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(m.id)) next.delete(m.id);
      else next.add(m.id);
      return next;
    });

  const run = async (op: () => Promise<unknown>, closesOnDissolve = false) => {
    setBusy(true);
    setError(null);
    try {
      const result = await op();
      onChanged();
      if (closesOnDissolve && result === null) {
        onClose();
        return;
      }
      setSelected(new Set());
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("stacks.error"));
    } finally {
      setBusy(false);
    }
  };

  const ids = [...selected];
  const items = detail?.items ?? [];
  const isCover = (id: number) => detail?.stack.coverMediaId === id;

  return (
    <Modal title={detail ? t("stacks.titleDetail", { count: detail.stack.count, kind: detail.stack.kind }) : t("stacks.title")} onClose={onClose} wide>
      {!detail && <p className="text-sm text-muted">{t("common.loading")}</p>}
      {detail && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <button
              className={buttonClass}
              onClick={() => setViewerIndex(ids.length ? Math.max(0, items.findIndex((m) => m.id === ids[0])) : 0)}
              disabled={busy || items.length === 0}
            >
              {t("stacks.view")}
            </button>
            <button
              className={buttonClass}
              disabled={busy || ids.length !== 1 || isCover(ids[0])}
              onClick={() => void run(() => api.stacks.setCover(stackId, ids[0]))}
              title={t("stacks.setCoverHelp")}
            >
              {t("stacks.setCover")}
            </button>
            <button
              className={buttonClass}
              disabled={busy || ids.length < 2 || ids.length >= items.length}
              onClick={() => void run(() => api.stacks.split(stackId, ids))}
              title={t("stacks.splitHelp")}
            >
              {t("stacks.split")}
            </button>
            <button
              className={buttonClass}
              disabled={busy || ids.length === 0}
              onClick={() =>
                void run(async () => {
                  let last: unknown = undefined;
                  for (const id of ids) last = (await api.stacks.removeMember(stackId, id)).stack;
                  return last;
                }, true)
              }
              title={t("stacks.removeHelp")}
            >
              {t("stacks.remove")}
            </button>
            <button
              className={`${buttonClass} ml-auto text-red-600`}
              disabled={busy}
              onClick={async () => {
                if (
                  await confirm({
                    title: t("stacks.deleteTitle"),
                    message: t("stacks.deleteMessage"),
                    confirmLabel: t("stacks.delete"),
                    danger: true,
                  })
                ) {
                  void run(async () => {
                    await api.stacks.remove(stackId);
                    return null;
                  }, true);
                }
              }}
            >
              {t("stacks.delete")}
            </button>
          </div>
          <p className="text-xs text-muted">
            {ids.length === 0 ? t("stacks.selectHelp") : t("stacks.selected", { count: ids.length })}
            {" "}{detail.stack.userModified ? t("stacks.edited") : t("stacks.automatic")}
          </p>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <MediaGrid items={items} onOpen={setViewerIndex} selectable selectedIds={selected} onToggleSelect={toggle} />
        </div>
      )}
      {detail && viewerIndex !== null && (
        <Viewer items={items} startIndex={viewerIndex} onClose={() => setViewerIndex(null)} />
      )}
    </Modal>
  );
}
