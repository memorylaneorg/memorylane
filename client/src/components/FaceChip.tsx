import { Check, X } from "lucide-react";
import type { FaceDto } from "@memorylane/shared";
import { api } from "../api/client";

interface FaceChipProps {
  face: FaceDto;
  // Confirm an automatic assignment (turns it into a user assignment).
  onConfirm?: () => void;
  // "Not this person".
  onReject?: () => void;
  onOpen?: () => void;
}

// A face crop with the two corrections that matter: "yes, that's them" and
// "no, it isn't". User-confirmed faces show a small check and no buttons.
export default function FaceChip({ face, onConfirm, onReject, onOpen }: FaceChipProps) {
  const confirmed = face.assignedBy === "user";
  return (
    <div className="group relative size-24 overflow-hidden rounded-lg bg-media ring-1 ring-border">
      <button type="button" onClick={onOpen} className="block size-full" title="Open photo">
        <img src={api.faces.cropUrl(face.id)} alt="" className="size-full object-cover" loading="lazy" />
      </button>
      {confirmed && (
        <span className="absolute top-1 left-1 grid size-5 place-items-center rounded-full bg-accent text-page" title="Confirmed by you">
          <Check size={12} strokeWidth={2.5} />
        </span>
      )}
      {!confirmed && (onConfirm || onReject) && (
        <div className="absolute inset-x-0 bottom-0 flex justify-center gap-1 bg-black/55 py-1 opacity-0 transition group-hover:opacity-100">
          {onConfirm && (
            <button type="button" onClick={onConfirm} title="Yes, it's them" aria-label="Confirm" className="grid size-6 place-items-center rounded-full bg-white/90 text-green-700 hover:bg-white">
              <Check size={13} strokeWidth={2.5} />
            </button>
          )}
          {onReject && (
            <button type="button" onClick={onReject} title="Not them" aria-label="Not this person" className="grid size-6 place-items-center rounded-full bg-white/90 text-red-600 hover:bg-white">
              <X size={13} strokeWidth={2.5} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
