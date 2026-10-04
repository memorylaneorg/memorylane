import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronRight, RefreshCw } from "lucide-react";
import type { MomentDetectionLevel, MomentsSummaryDto } from "@memorylane/shared";
import { api } from "../api/client";
import { useTranslation } from "react-i18next";

const LEVELS: MomentDetectionLevel[] = ["broad", "balanced", "detailed"];

function validLevel(value: string | null): MomentDetectionLevel {
  return value === "broad" || value === "detailed" ? value : "balanced";
}

function displayDate(date: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
}

function displayRange(start: string, end: string): string {
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  const sameYear = startDate.getUTCFullYear() === endDate.getUTCFullYear();
  const first = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" }).format(startDate);
  return `${first} – ${displayDate(end)}`;
}

export default function MomentsPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const detection = validLevel(params.get("detection"));
  const [summary, setSummary] = useState<MomentsSummaryDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSummary(null);
    setError(null);
    void api.moments.summary(detection).then(setSummary).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [detection]);

  const [refreshing, setRefreshing] = useState(false);
  const refresh = () => {
    setRefreshing(true);
    setError(null);
    void api.moments.summary(detection, true).then(setSummary)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setRefreshing(false));
  };

  const chooseLevel = (level: MomentDetectionLevel) => {
    const next = new URLSearchParams(params);
    if (level === "balanced") next.delete("detection"); else next.set("detection", level);
    setParams(next);
  };

  return (
    <div>
      <header className="mb-7 flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5">
        <div>
          <h1 className="font-serif text-3xl font-semibold text-ink">{t("moments.title")}</h1>
          <p className="mt-1 text-sm text-muted">{t("moments.intro")}</p>
        </div>
        <div className="flex items-end gap-3">
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted">{t("moments.detection")}</p>
            <div role="group" aria-label={t("moments.detection")} className="flex rounded-lg border border-border bg-surface p-0.5">
              {LEVELS.map((level) => (
                <button key={level} type="button" aria-pressed={detection === level} onClick={() => chooseLevel(level)}
                  className={`rounded-md px-3 py-1.5 text-sm transition ${detection === level ? "bg-accent text-page" : "text-muted hover:bg-hover hover:text-ink"}`}>
                  {t(`moments.level.${level}`)}
                </button>
              ))}
            </div>
          </div>
          <button type="button" onClick={refresh} disabled={refreshing} title={t("common.refresh")} aria-label={t("common.refresh")}
            className="rounded-lg border border-border bg-surface p-2.5 text-muted hover:bg-hover hover:text-ink disabled:opacity-50">
            <RefreshCw size={16} className={refreshing ? "animate-spin" : ""} />
          </button>
        </div>
      </header>

      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {!summary && !error && <p className="text-sm text-muted">{t("common.loading")}</p>}
      {summary && summary.years.length === 0 && <p className="text-sm text-muted">{t("moments.empty")}</p>}

      {summary && summary.years.length > 0 && (
        <main className="min-w-0">
          <div className="relative border-l border-border pl-6 sm:pl-10">
              {summary.years.map((year) => (
                <section key={year.year} id={`moments-year-${year.year}`} className="scroll-mt-24 pb-12 last:pb-0">
                  <div className="relative mb-6 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <span className="absolute -left-[31px] top-2 size-3 rounded-full bg-accent ring-8 ring-accent/10 sm:-left-[47px]" />
                    <h2 className="font-serif text-4xl font-semibold text-ink">{year.year}</h2>
                    <p className="text-sm text-muted">{t("moments.momentCount", { count: year.moments.length })} · {t("moments.multiCount", { count: year.multiDayCount })} · {t("moments.eventCount", { count: year.eventCount })} · {t("moments.items", { count: year.mediaCount })}</p>
                  </div>
                  <div className="space-y-7">
                    {year.moments.map((moment) => {
                      const href = `/moments/${moment.startDate}/${moment.endDate}?detection=${detection}`;
                      return <article key={`${moment.startDate}-${moment.endDate}`} className="relative grid gap-3 lg:grid-cols-[14rem_minmax(0,1fr)_auto] lg:items-center">
                        <span className="absolute -left-[29px] top-2.5 size-2 rounded-full bg-accent/65 sm:-left-[45px]" />
                        <div>
                          <h3 className="text-lg font-semibold text-ink">{moment.kind === "multi-day" ? displayRange(moment.startDate, moment.endDate) : displayDate(moment.startDate)}</h3>
                          <p className="text-sm text-muted">
                            {t(moment.kind === "multi-day" ? "moments.multiDay" : "moments.event")}
                            {moment.kind === "multi-day" && <> · {t("moments.calendarDays", { count: moment.calendarDays })} · {t("moments.activeDays", { count: moment.activeDays.length })}</>}
                            <> · {t("moments.items", { count: moment.mediaCount })}</>
                          </p>
                        </div>
                        <Link to={href} className="grid grid-cols-5 gap-2" aria-label={t("moments.viewMoment")}>
                          {moment.samples.map((media) => <img key={media.id} src={api.media.thumbnailUrl(media.id, media.thumbnailVersion)} alt="" loading="lazy" className="aspect-[4/3] min-w-0 rounded-md bg-media object-cover ring-1 ring-border" />)}
                        </Link>
                        <Link to={href} className="inline-flex w-fit items-center gap-1 rounded-full border border-border px-4 py-2 text-sm font-medium text-ink hover:bg-hover">{t("moments.view")} <ChevronRight size={15} /></Link>
                      </article>;
                    })}
                  </div>
                </section>
              ))}
          </div>
        </main>
      )}
    </div>
  );
}
