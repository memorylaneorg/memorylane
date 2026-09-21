import { LayoutGrid, Image, Video } from "lucide-react";
import type { MediaTypeFilter as MediaTypeFilterValue } from "@memorylane/shared";

interface MediaTypeFilterProps {
  value: MediaTypeFilterValue;
  onChange: (value: MediaTypeFilterValue) => void;
}

const OPTIONS: { value: MediaTypeFilterValue; label: string; Icon: typeof LayoutGrid }[] = [
  { value: "all", label: "All", Icon: LayoutGrid },
  { value: "photo", label: "Photos only", Icon: Image },
  { value: "video", label: "Videos only", Icon: Video },
];

// A small icon toggle group for the "All / Photos / Videos" grid filter -
// shared by every paginated grid listing (folder browsing, Favorites) so the
// filter behaves and looks identical everywhere it appears.
export default function MediaTypeFilter({ value, onChange }: MediaTypeFilterProps) {
  return (
    <div role="group" aria-label="Filter by media type" className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
      {OPTIONS.map(({ value: optionValue, label, Icon }) => (
        <button
          key={optionValue}
          type="button"
          onClick={() => onChange(optionValue)}
          title={label}
          aria-label={label}
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
