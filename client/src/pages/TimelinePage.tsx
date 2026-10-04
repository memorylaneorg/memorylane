import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, RefreshCw } from "lucide-react";
import type { TimelineSummaryDto } from "@memorylane/shared";
import { api } from "../api/client";
import { useTranslation } from "react-i18next";

function monthName(month: number): string {
  return new Intl.DateTimeFormat(undefined, { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2020, month - 1, 1)));
}

function monthHref(year: number, month: number): string {
  return `/timeline/${year}/${String(month).padStart(2, "0")}`;
}

export default function TimelinePage() {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<TimelineSummaryDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.timeline.summary().then(setSummary).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  const [refreshing, setRefreshing] = useState(false);
  const refresh = () => {
    setRefreshing(true);
    setError(null);
    void api.timeline.summary(true).then(setSummary)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setRefreshing(false));
  };

  return (
    <div>
      <header className="mb-8 flex items-start justify-between gap-4 border-b border-border pb-5">
        <div>
          <h1 className="font-serif text-3xl font-semibold text-ink">{t("timeline.title")}</h1>
          <p className="mt-1 text-sm text-muted">{t("timeline.intro")}</p>
        </div>
        <button type="button" onClick={refresh} disabled={refreshing} title={t("common.refresh")} aria-label={t("common.refresh")}
          className="shrink-0 rounded-lg border border-border bg-surface p-2.5 text-muted hover:bg-hover hover:text-ink disabled:opacity-50">
          <RefreshCw size={16} className={refreshing ? "animate-spin" : ""} />
        </button>
      </header>

      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {!summary && !error && <p className="text-sm text-muted">{t("common.loading")}</p>}
      {summary && summary.years.length === 0 && <p className="text-sm text-muted">{t("timeline.empty")}</p>}

      {summary && summary.years.length > 0 && (
        <main className="min-w-0">
          <div className="relative border-l border-border pl-6 sm:pl-10">
              {summary.years.map((year) => (
                <section key={year.year} id={`timeline-year-${year.year}`} className="scroll-mt-24 pb-12 last:pb-0">
                  <div className="relative mb-6 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <span className="absolute -left-[31px] top-2 size-3 rounded-full bg-accent ring-8 ring-accent/10 sm:-left-[47px]" />
                    <h2 className="font-serif text-4xl font-semibold text-ink">{year.year}</h2>
                    <p className="text-sm text-muted">{t("timeline.months", { count: year.months.length })} · {t("timeline.items", { count: year.mediaCount })}</p>
                  </div>

                  <div className="space-y-7">
                    {year.months.map((month) => (
                      <article key={month.month} className="relative grid gap-3 lg:grid-cols-[8rem_minmax(0,1fr)_auto] lg:items-center">
                        <span className="absolute -left-[29px] top-2.5 size-2 rounded-full bg-accent/65 sm:-left-[45px]" />
                        <div>
                          <h3 className="text-lg font-semibold text-ink">{monthName(month.month)}</h3>
                          <p className="text-sm text-muted">{t("timeline.items", { count: month.mediaCount })}</p>
                        </div>
                        <Link to={monthHref(month.year, month.month)} className="grid grid-cols-5 gap-2" aria-label={t("timeline.openMonth", { month: monthName(month.month), year: month.year })}>
                          {month.samples.map((media) => (
                            <img key={media.id} src={api.media.thumbnailUrl(media.id, media.thumbnailVersion)} alt="" loading="lazy" className="aspect-[4/3] min-w-0 rounded-md bg-media object-cover ring-1 ring-border" />
                          ))}
                        </Link>
                        <Link to={monthHref(month.year, month.month)} className="inline-flex w-fit items-center gap-1 rounded-full border border-border px-4 py-2 text-sm font-medium text-ink hover:bg-hover">
                          {t("timeline.more")} <ChevronRight size={15} />
                        </Link>
                      </article>
                    ))}
                  </div>
                </section>
              ))}
          </div>
        </main>
      )}
    </div>
  );
}
