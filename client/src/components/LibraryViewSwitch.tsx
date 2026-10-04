import { FolderOpen, Images, LibraryBig, Star } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

export default function LibraryViewSwitch({ collectionCount = 0 }: { collectionCount?: number }) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const active = location.pathname.startsWith("/collections")
    ? "collections"
    : location.pathname.startsWith("/favorites")
      ? "favorites"
      : location.pathname === "/library/media"
        ? "all"
        : "folders";
  const items = [
    { key: "folders", label: t("pages.folders"), to: "/library/folders", icon: FolderOpen },
    { key: "favorites", label: t("pages.favorites"), to: "/favorites", icon: Star },
    { key: "collections", label: `${t("collections.title")} (${collectionCount})`, to: "/collections", icon: LibraryBig },
    { key: "all", label: t("common.all"), to: "/library/media", icon: Images },
  ] as const;

  return <div role="tablist" aria-label={t("pages.yourLibrary")} className="flex w-fit items-center gap-0.5 rounded-md border border-border p-0.5">
    {items.map((item) => {
      const Icon = item.icon;
      const selected = active === item.key;
      return <button key={item.key} type="button" role="tab" aria-selected={selected} onClick={() => navigate(item.to)} className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-sm font-medium transition-colors ${selected ? "bg-accent text-page" : "text-muted hover:bg-hover hover:text-ink"}`}>
        <Icon size={15} strokeWidth={1.8} aria-hidden />{item.label}
      </button>;
    })}
  </div>;
}
