import type { MomentDetectionLevel } from "@memorylane/shared";

export interface ActiveDay {
  date: string;
  mediaCount: number;
}

export interface DetectedMoment {
  kind: "event" | "multi-day";
  startDate: string;
  endDate: string;
  calendarDays: number;
  mediaCount: number;
  activeDays: ActiveDay[];
}

const THRESHOLDS: Record<MomentDetectionLevel, { activeDay: number; multiDay: number }> = {
  broad: { activeDay: 25, multiDay: 100 },
  balanced: { activeDay: 10, multiDay: 40 },
  detailed: { activeDay: 3, multiDay: 12 },
};

function dayNumber(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / 86_400_000;
}

export function detectMoments(days: ActiveDay[], level: MomentDetectionLevel): DetectedMoment[] {
  const threshold = THRESHOLDS[level];
  const active = days.filter((day) => day.mediaCount >= threshold.activeDay).sort((a, b) => a.date.localeCompare(b.date));
  const runs: ActiveDay[][] = [];
  for (const day of active) {
    const run = runs.at(-1);
    if (!run || dayNumber(day.date) - dayNumber(run.at(-1)!.date) >= 3) runs.push([day]);
    else run.push(day);
  }

  const moments: DetectedMoment[] = [];
  for (const run of runs) {
    const total = run.reduce((sum, day) => sum + day.mediaCount, 0);
    if (run.length >= 3 && total >= threshold.multiDay) {
      const startDate = run[0].date;
      const endDate = run.at(-1)!.date;
      moments.push({
        kind: "multi-day",
        startDate,
        endDate,
        calendarDays: dayNumber(endDate) - dayNumber(startDate) + 1,
        mediaCount: total,
        activeDays: run,
      });
    } else {
      for (const day of run) {
        moments.push({ kind: "event", startDate: day.date, endDate: day.date, calendarDays: 1, mediaCount: day.mediaCount, activeDays: [day] });
      }
    }
  }
  return moments.sort((a, b) => b.endDate.localeCompare(a.endDate) || b.startDate.localeCompare(a.startDate));
}

export function momentDetectionLevel(value: unknown): MomentDetectionLevel {
  return value === "broad" || value === "detailed" ? value : "balanced";
}
