import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { MediaDto } from "@memorylane/shared";
import { api } from "../api/client";
import Viewer from "../components/Viewer";
import { useTranslation } from "react-i18next";

export default function SurprisePage() {
  const { t } = useTranslation();
  const [items, setItems] = useState<MediaDto[] | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    void api.memories.random(100).then((res) => setItems(res.items));
  }, []);

  if (items === null) {
    return <p className="text-sm text-muted">{t("pages.gathering")}</p>;
  }

  if (items.length === 0) {
    return (
      <p className="text-sm text-muted">
        {t("pages.noIndexed")}
      </p>
    );
  }

  return <Viewer items={items} startIndex={0} onClose={() => navigate("/")} autoPlay />;
}
