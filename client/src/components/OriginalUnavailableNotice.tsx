import type { MediaDto } from "@memorylane/shared";

export function OriginalUnavailableNotice({
  fallback,
  sourceKind,
}: {
  fallback: boolean;
  sourceKind: MediaDto["sourceKind"];
}) {
  if (!fallback || sourceKind === "apple-photos") return null;

  return (
    <div
      role="status"
      className="absolute top-16 left-1/2 max-w-[90vw] -translate-x-1/2 rounded-lg bg-black/75 px-4 py-2 text-center text-sm text-white"
    >
      <strong>Original unavailable</strong> — showing cached thumbnail. Reconnect the drive or scan folder to view full resolution.
    </div>
  );
}
