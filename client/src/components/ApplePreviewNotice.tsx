import { useTranslation } from "react-i18next";

export function ApplePreviewNotice({ onOpen, error }: { onOpen: () => void; error: string | null }) {
  const { t } = useTranslation();
  return <div className="absolute top-16 left-1/2 flex max-w-[90vw] -translate-x-1/2 flex-wrap items-center justify-center gap-3 rounded-lg bg-black/75 px-4 py-2 text-sm text-white">
    <span>{t("common.applePreview")}</span>
    <button type="button" onClick={onOpen} className="font-semibold text-accent underline">{t("common.openPhotos")}</button>
    {error && <span role="alert" className="text-red-300">{error}</span>}
  </div>;
}
