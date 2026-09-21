import type { MediaDto } from "@memorylane/shared";
import { useTranslation } from "react-i18next";

export function OriginalUnavailableNotice({
  fallback,
  sourceKind,
}: {
  fallback: boolean;
  sourceKind: MediaDto["sourceKind"];
}) {
  const { t } = useTranslation();
  if (!fallback || sourceKind === "apple-photos") return null;

  return (
    <div
      role="status"
      className="absolute top-16 left-1/2 max-w-[90vw] -translate-x-1/2 rounded-lg bg-black/75 px-4 py-2 text-center text-sm text-white"
    >
      <strong>{t("common.originalUnavailable")}</strong> — {t("common.cachedThumbnail")}
    </div>
  );
}
