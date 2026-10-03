import { useEffect, useState } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import type { MomentDetectionLevel, MomentDetailDto } from "@memorylane/shared";
import { api } from "../api/client";
import { useTranslation } from "react-i18next";

function level(value: string | null): MomentDetectionLevel { return value === "broad" || value === "detailed" ? value : "balanced"; }
function dateLabel(date: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`)); }

export default function MomentDetailPage() {
  const { t } = useTranslation();
  const { start = "", end = "" } = useParams<{ start: string; end: string }>();
  const [params] = useSearchParams();
  const detection = level(params.get("detection"));
  const [moment, setMoment] = useState<MomentDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end);
  useEffect(() => { if (valid) void api.moments.detail(start, end, detection).then(setMoment).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }, [start, end, detection, valid]);
  if (!valid) return <Navigate to="/moments" replace />;
  if (moment?.kind === "event") return <Navigate to={`/moments/day/${moment.startDate}?detection=${detection}`} replace />;
  return <div>
    <Link to={`/moments${detection === "balanced" ? "" : `?detection=${detection}`}`} className="text-sm text-accent hover:underline">{t("moments.back")}</Link>
    {error && <p role="alert" className="mt-4 text-sm text-red-600">{error}</p>}
    {!moment && !error && <p className="mt-4 text-sm text-muted">{t("common.loading")}</p>}
    {moment && <>
      <header className="mb-7 mt-3 border-b border-border pb-5"><h1 className="font-serif text-3xl font-semibold text-ink">{dateLabel(moment.startDate)} – {dateLabel(moment.endDate)}</h1><p className="mt-1 text-sm text-muted">{t("moments.multiSummary", { days: moment.calendarDays, active: moment.activeDays.length, count: moment.mediaCount })}</p></header>
      <div className="space-y-4">{moment.days.map((day) => <section key={day.date} className="grid gap-4 rounded-xl border border-border bg-surface p-4 lg:grid-cols-[15rem_minmax(0,1fr)_auto] lg:items-center"><div><h2 className="font-semibold text-ink">{dateLabel(day.date)}</h2><p className="text-sm text-muted">{t("moments.items", { count: day.mediaCount })}</p></div><Link to={`/moments/day/${day.date}?detection=${detection}`} className="grid grid-cols-5 gap-2">{day.samples.map((media) => <img key={media.id} src={api.media.thumbnailUrl(media.id, media.thumbnailVersion)} alt="" className="aspect-[4/3] min-w-0 rounded-md object-cover" />)}</Link><Link to={`/moments/day/${day.date}?detection=${detection}`} className="rounded-full border border-border px-4 py-2 text-sm hover:bg-hover">{t("moments.view")}</Link></section>)}</div>
    </>}
  </div>;
}
