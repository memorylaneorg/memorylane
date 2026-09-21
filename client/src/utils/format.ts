import i18n from "../i18n";

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: i === 0 ? 0 : 1 }).format(bytes / 1024 ** i)} ${units[i]}`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat(i18n.resolvedLanguage).format(value);
}

export function formatDate(value: string | number | Date, options: Intl.DateTimeFormatOptions = { dateStyle: "medium" }): string {
  return new Intl.DateTimeFormat(i18n.resolvedLanguage, options).format(new Date(value));
}

// "0:15", "12:03", "1:02:03" - the standard video-duration badge format.
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
