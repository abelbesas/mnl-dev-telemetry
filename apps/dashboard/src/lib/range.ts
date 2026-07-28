import { wallTimeToUtc, zonedParts } from "./tz";

/** Runtime date-range helpers for "today" / "this week" views (spec §4.5). */

export interface Range {
  from: Date;
  to: Date;
}

/** UTC instant of local midnight (start of `now`'s calendar day) in `tz`. */
export function startOfDay(now: Date, tz: string): Date {
  const p = zonedParts(now, tz);
  return wallTimeToUtc(p.year, p.month, p.day, 0, 0, tz);
}

/** UTC instant of the most recent local Monday 00:00 in `tz`. */
export function startOfWeek(now: Date, tz: string): Date {
  const sod = startOfDay(now, tz);
  const weekday = zonedParts(now, tz).weekday; // 1 = Mon .. 7 = Sun
  return new Date(sod.getTime() - (weekday - 1) * 86_400_000);
}

export function dayRange(now: Date, tz: string): Range {
  return { from: startOfDay(now, tz), to: now };
}

export function weekRange(now: Date, tz: string): Range {
  return { from: startOfWeek(now, tz), to: now };
}

/** N days back from the start of today — used for the team trend window. */
export function lastNDays(now: Date, tz: string, days: number): Range {
  const from = new Date(startOfDay(now, tz).getTime() - (days - 1) * 86_400_000);
  return { from, to: now };
}
