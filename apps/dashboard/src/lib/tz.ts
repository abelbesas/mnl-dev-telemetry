/**
 * Pure, dependency-free timezone helpers for the stitcher's working-hours clamp
 * (spec §4.2.3). They lean on the built-in `Intl` time-zone database — so they
 * are DST-correct without pulling in a date library — but expose only
 * deterministic pure functions (no `Date.now()`), which keeps the stitcher's
 * "re-run from scratch is deterministic" property and makes them easy to test.
 */

/** Wall-clock components of an instant, as observed in a given IANA timezone. */
export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
  weekday: number; // 1 = Monday .. 7 = Sunday
}

const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/** Break an instant down into its wall-clock parts in `tz`. */
export function zonedParts(instant: Date, tz: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  }).formatToParts(instant);

  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "";

  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAY_INDEX[get("weekday")] ?? 0,
  };
}

/**
 * Offset (ms) of `tz` at `instant`, defined so that
 * `localWallClock = instant + offset`. Positive east of UTC (e.g. +8h for
 * Asia/Manila).
 */
export function tzOffsetMs(instant: Date, tz: string): number {
  const p = zonedParts(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // `asUtc` reads the wall clock as though it were UTC; the gap from the real
  // instant (to whole seconds, the resolution of the parts) is the offset.
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Parse an "HH:MM" string into `[hour, minute]`. */
export function parseHm(hm: string): [number, number] {
  const [h, m] = hm.split(":");
  return [Number(h), Number(m ?? "0")];
}

/**
 * Convert a wall-clock time in `tz` to the corresponding UTC instant. Two
 * offset passes make it correct across DST transitions (the first guess picks
 * the offset on the wrong side of a jump; the second lands on the right one).
 */
export function wallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const off1 = tzOffsetMs(new Date(utcGuess), tz);
  const off2 = tzOffsetMs(new Date(utcGuess - off1), tz);
  return new Date(utcGuess - off2);
}
