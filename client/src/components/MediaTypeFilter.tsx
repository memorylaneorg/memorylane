import { LayoutGrid, Image, Video } from "lucide-react";
import type { MediaTypeFilter as MediaTypeFilterValue } from "@memorylane/shared";
import { useTranslation } from "react-i18next";

interface MediaTypeFilterProps {
  value: MediaTypeFilterValue;
  onChange: (value: MediaTypeFilterValue) => void;
}

const OPTIONS: { value: MediaTypeFilterValue; labelKey: string; Icon: typeof LayoutGrid }[] = [
  { value: "all", labelKey: "common.all", Icon: LayoutGrid },
  { value: "photo", labelKey: "common.photosOnly", Icon: Image },
  { value: "video", labelKey: "common.videosOnly", Icon: Video },
];

// A small icon toggle group for the "All / Photos / Videos" grid filter -
// shared by every paginated grid listing (folder browsing, Favorites) so the
// filter behaves and looks identical everywhere it appears.
export default function MediaTypeFilter({ value, onChange }: MediaTypeFilterProps) {
  const { t } = useTranslation();
  return (
    <div role="group" aria-label={t("common.filterMedia")} className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
      {OPTIONS.map(({ value: optionValue, labelKey, Icon }) => (
        <button
          key={optionValue}
          type="button"
          onClick={() => onChange(optionValue)}
          title={t(labelKey)}
          aria-label={t(labelKey)}
          aria-pressed={value === optionValue}
          className={`grid size-7 place-items-center rounded transition-colors ${
            value === optionValue ? "bg-accent text-page" : "text-muted hover:bg-hover hover:text-ink"
          }`}
        >
          <Icon size={15} strokeWidth={1.8} />
        </button>
      ))}
    </div>
  );
}
