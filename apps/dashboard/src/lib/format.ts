/** Small presentation helpers shared across the dashboard pages. */

/** "2h 15m", "45m", "0m" — compact duration from seconds. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/** Decimal hours, e.g. 2.3 — for compact stat tiles. */
export function toHours(seconds: number): number {
  return Math.round((seconds / 3600) * 10) / 10;
}

const TIME_FMT = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Manila",
});
const DAY_FMT = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "Asia/Manila",
});
const SHORT_DAY_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "Asia/Manila",
});

export function formatClock(d: Date, tz = "Asia/Manila"): string {
  return tz === "Asia/Manila"
    ? TIME_FMT.format(d)
    : new Intl.DateTimeFormat("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: tz,
      }).format(d);
}

export function formatDay(d: Date, tz = "Asia/Manila"): string {
  return tz === "Asia/Manila"
    ? DAY_FMT.format(d)
    : new Intl.DateTimeFormat("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        timeZone: tz,
      }).format(d);
}

export function formatShortDay(d: Date): string {
  return SHORT_DAY_FMT.format(d);
}

/** Local calendar-day key (YYYY-MM-DD in tz) for grouping sessions by day. */
export function dayKey(d: Date, tz = "Asia/Manila"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: tz,
  }).format(d);
  return parts; // en-CA yields YYYY-MM-DD
}
