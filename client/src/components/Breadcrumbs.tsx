import { Link } from "react-router-dom";
import type { FolderBreadcrumbDto } from "@memorylane/shared";

export default function Breadcrumbs({ items }: { items: FolderBreadcrumbDto[] }) {
  return (
    <nav className="mb-2 text-sm text-muted">
      <Link to="/" className="hover:text-ink">
        Library
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
