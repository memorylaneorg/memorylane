import { useCallback, useEffect, useState } from "react";
import type { MediaDto, StackDetailDto } from "@memorylane/shared";
import { api, ApiError } from "../api/client";
import Modal from "./Modal";
import MediaGrid from "./MediaGrid";
import Viewer from "./Viewer";
import { useConfirm } from "./ConfirmDialog";

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
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const ids = [...selected];
  const items = detail?.items ?? [];
  const isCover = (id: number) => detail?.stack.coverMediaId === id;

  return (
    <Modal title={detail ? `Stack · ${detail.stack.count} photos · ${detail.stack.kind}` : "Stack"} onClose={onClose} wide>
      {!detail && <p className="text-sm text-muted">Loading...</p>}
      {detail && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <button
              className={buttonClass}
              onClick={() => setViewerIndex(ids.length ? Math.max(0, items.findIndex((m) => m.id === ids[0])) : 0)}
              disabled={busy || items.length === 0}
            >
              View
            </button>
            <button
              className={buttonClass}
              disabled={busy || ids.length !== 1 || isCover(ids[0])}
              onClick={() => void run(() => api.stacks.setCover(stackId, ids[0]))}
              title="Use the selected photo as this stack's cover"
            >
              Set as cover
            </button>
            <button
              className={buttonClass}
              disabled={busy || ids.length < 2 || ids.length >= items.length}
              onClick={() => void run(() => api.stacks.split(stackId, ids))}
              title="Move the selected photos into their own stack"
            >
              Split into new stack
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
              title="Remove the selected photos from this stack (they won't be auto-stacked again)"
            >
              Remove from stack
            </button>
            <button
              className={`${buttonClass} ml-auto text-red-600`}
              disabled={busy}
              onClick={async () => {
                if (
                  await confirm({
                    title: "Delete this stack?",
                    message: "The photos stay in your library - they just won't be grouped, and won't be auto-stacked again.",
                    confirmLabel: "Delete stack",
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
              Delete stack
            </button>
          </div>
          <p className="text-xs text-muted">
            {ids.length === 0 ? "Click photos to select them." : `${ids.length} selected.`}
            {detail.stack.userModified ? " Edited by you - automatic re-stacking leaves this stack alone." : " Grouped automatically."}
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
