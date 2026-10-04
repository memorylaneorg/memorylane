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
  const label = `${dateLabel(start)} – ${dateLabel(end)}`;
  return <div>
    <nav className="mb-2 text-sm text-muted" aria-label={t("moments.title")}><Link to={`/moments${detection === "balanced" ? "" : `?detection=${detection}`}`} className="hover:text-ink">{t("moments.title")}</Link><span> / {label}</span></nav>
    {error && <p role="alert" className="mt-4 text-sm text-red-600">{error}</p>}
    {!moment && !error && <p className="mt-4 text-sm text-muted">{t("common.loading")}</p>}
    {moment && <>
      <header className="mb-7 border-b border-border pb-5"><h1 className="font-serif text-3xl font-semibold text-ink">{label}</h1><p className="mt-1 text-sm text-muted">{t("moments.multiSummary", { days: moment.calendarDays, active: moment.activeDays.length, count: moment.mediaCount })}</p></header>
      <div className="relative space-y-7 border-l border-border pl-6 sm:pl-10">{moment.days.map((day) => {
        const href = `/moments/day/${day.date}?detection=${detection}&parentStart=${start}&parentEnd=${end}`;
        return <section key={day.date} className="relative grid gap-3 lg:grid-cols-[14rem_minmax(0,1fr)_auto] lg:items-center">
          <span className="absolute -left-[29px] top-2.5 size-2 rounded-full bg-accent/65 sm:-left-[45px]" />
          <div><h2 className="text-lg font-semibold text-ink">{dateLabel(day.date)}</h2><p className="text-sm text-muted">{t("moments.items", { count: day.mediaCount })}</p></div>
          <Link to={href} className="grid grid-cols-5 gap-2">{day.samples.map((media) => <img key={media.id} src={api.media.thumbnailUrl(media.id, media.thumbnailVersion)} alt="" className="aspect-[4/3] min-w-0 rounded-md bg-media object-cover ring-1 ring-border" />)}</Link>
          <Link to={href} className="inline-flex w-fit rounded-full border border-border px-4 py-2 text-sm font-medium text-ink hover:bg-hover">{t("moments.view")}</Link>
        </section>;
      })}</div>
    </>}
  </div>;
}
