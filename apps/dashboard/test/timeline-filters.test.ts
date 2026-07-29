import { describe, expect, it } from "vitest";
import {
  filterSessions,
  parseTimelineFilters,
  type FilterableSession,
} from "@/components/TimelineFilters";

/** Timeline noise filters — hiding un-ticketed / zero-minute sessions. */

const SESSIONS: FilterableSession[] = [
  { issueKey: "MNLDT-5", reportedSeconds: 2460 }, // ticketed, real time
  { issueKey: null, reportedSeconds: 2520 }, // no key (main branch), real time
  { issueKey: null, reportedSeconds: 0 }, // no key AND empty
  { issueKey: "TK-1", reportedSeconds: 0 }, // ticketed but 0m
];

describe("parseTimelineFilters", () => {
  it("defaults to showing everything", () => {
    expect(parseTimelineFilters({})).toEqual({
      ticketedOnly: false,
      hideEmpty: false,
    });
  });

  it("reads both flags from search params", () => {
    expect(parseTimelineFilters({ ticketed: "1", nonzero: "1" })).toEqual({
      ticketedOnly: true,
      hideEmpty: true,
    });
  });

  it("ignores values other than '1'", () => {
    expect(parseTimelineFilters({ ticketed: "true" }).ticketedOnly).toBe(false);
  });
});

describe("filterSessions", () => {
  it("returns everything when no filter is active", () => {
    const out = filterSessions(SESSIONS, {
      ticketedOnly: false,
      hideEmpty: false,
    });
    expect(out).toHaveLength(4);
  });

  it("ticketedOnly drops sessions with no issue key", () => {
    const out = filterSessions(SESSIONS, {
      ticketedOnly: true,
      hideEmpty: false,
    });
    expect(out.map((s) => s.issueKey)).toEqual(["MNLDT-5", "TK-1"]);
  });

  it("hideEmpty drops zero-reported sessions, keeping un-ticketed real work", () => {
    const out = filterSessions(SESSIONS, {
      ticketedOnly: false,
      hideEmpty: true,
    });
    expect(out).toHaveLength(2);
    expect(out.every((s) => s.reportedSeconds > 0)).toBe(true);
  });

  it("both filters together keep only ticketed sessions with real time", () => {
    const out = filterSessions(SESSIONS, {
      ticketedOnly: true,
      hideEmpty: true,
    });
    expect(out).toEqual([{ issueKey: "MNLDT-5", reportedSeconds: 2460 }]);
  });

  it("counts hidden rows without double-counting overlaps", () => {
    // The no-key/0m session matches BOTH filters; it must be hidden once.
    const state = { ticketedOnly: true, hideEmpty: true };
    const hidden = SESSIONS.length - filterSessions(SESSIONS, state).length;
    expect(hidden).toBe(3);
  });
});
