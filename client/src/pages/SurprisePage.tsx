import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { MediaDto } from "@memorylane/shared";
import { api } from "../api/client";
import Viewer from "../components/Viewer";

export default function SurprisePage() {
  const [items, setItems] = useState<MediaDto[] | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    void api.memories.random(100).then((res) => setItems(res.items));
  }, []);

  if (items === null) {
    return <p className="text-sm text-muted">Gathering memories...</p>;
  }

  if (items.length === 0) {
    return (
      <p className="text-sm text-muted">
        No indexed photos yet - add a scan root and run a scan from Settings first.
      </p>
    );
  }

  return <Viewer items={items} startIndex={0} onClose={() => navigate("/")} autoPlay />;
}
