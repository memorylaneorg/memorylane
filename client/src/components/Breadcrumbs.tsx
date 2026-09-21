import { Link } from "react-router-dom";
import type { FolderBreadcrumbDto } from "@memorylane/shared";
import { useTranslation } from "react-i18next";

export default function Breadcrumbs({ items }: { items: FolderBreadcrumbDto[] }) {
  const { t } = useTranslation();
  return (
    <nav className="mb-2 text-sm text-muted">
      <Link to="/" className="hover:text-ink">
        {t("navigation.library")}
      </Link>
      {items.map((item) => (
        <span key={item.id}>
          {" "}
          / <Link to={`/folder/${item.id}`} className="hover:text-ink">{item.name}</Link>
        </span>
      ))}
    </nav>
  );
}
