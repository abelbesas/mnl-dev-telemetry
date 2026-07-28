import { describe, expect, it } from "vitest";
import {
  cohortComparison,
  compressionByWeek,
  throughputByWeek,
  ticketRollup,
  weekStart,
  type AggEstimate,
  type AggSession,
} from "@/lib/aggregate";

/** Team-aggregate math (spec §4.5). Pure, so fully unit-testable. */

const h = (n: number) => n * 3600;

function s(overrides: Partial<AggSession> & { issueKey: string | null }): AggSession {
  return {
    startedAt: new Date("2026-07-27T02:00:00Z"),
    reportedSeconds: h(1),
    aiAssisted: false,
    ...overrides,
  };
}

describe("weekStart", () => {
  it("snaps to Monday 00:00 UTC", () => {
    // 2026-07-29 is a Wednesday → week of Mon 2026-07-27.
    expect(weekStart(new Date("2026-07-29T10:00:00Z")).toISOString()).toBe(
      "2026-07-27T00:00:00.000Z",
    );
    // Monday maps to itself.
    expect(weekStart(new Date("2026-07-27T23:00:00Z")).toISOString()).toBe(
      "2026-07-27T00:00:00.000Z",
    );
    // Sunday belongs to the prior Monday.
    expect(weekStart(new Date("2026-08-02T05:00:00Z")).toISOString()).toBe(
      "2026-07-27T00:00:00.000Z",
    );
  });
});

describe("ticketRollup", () => {
  it("sums actual per ticket and ORs the AI flag", () => {
    const rolled = ticketRollup([
      s({ issueKey: "DEV-1", reportedSeconds: h(2) }),
      s({ issueKey: "DEV-1", reportedSeconds: h(1), aiAssisted: true }),
      s({ issueKey: "DEV-2", reportedSeconds: h(3) }),
    ]);
    const dev1 = rolled.find((t) => t.issueKey === "DEV-1")!;
    expect(dev1.actualSeconds).toBe(h(3));
    expect(dev1.aiAssisted).toBe(true);
    expect(rolled).toHaveLength(2);
  });

  it("ignores key-less sessions", () => {
    expect(ticketRollup([s({ issueKey: null })])).toHaveLength(0);
  });
});

describe("compressionByWeek", () => {
  it("aggregates actual/estimate into the completion week", () => {
    const sessions: AggSession[] = [
      // DEV-1: 3h actual, estimate 4h → completes week of 07-27.
      s({ issueKey: "DEV-1", reportedSeconds: h(3), startedAt: new Date("2026-07-27T02:00:00Z") }),
      // DEV-2: 5h actual, estimate 4h → same week.
      s({ issueKey: "DEV-2", reportedSeconds: h(5), startedAt: new Date("2026-07-28T02:00:00Z") }),
    ];
    const estimates: AggEstimate[] = [
      { issueKey: "DEV-1", estimateSeconds: h(4) },
      { issueKey: "DEV-2", estimateSeconds: h(4) },
    ];
    const weeks = compressionByWeek(sessions, estimates);
    expect(weeks).toHaveLength(1);
    expect(weeks[0]!.ticketCount).toBe(2);
    expect(weeks[0]!.actualHours).toBe(8);
    expect(weeks[0]!.estimateHours).toBe(8);
    expect(weeks[0]!.ratio).toBe(1); // 8h / 8h
  });

  it("excludes tickets without an estimate", () => {
    const weeks = compressionByWeek(
      [s({ issueKey: "DEV-9", reportedSeconds: h(2) })],
      [],
    );
    expect(weeks).toHaveLength(0);
  });
});

describe("cohortComparison", () => {
  it("splits AI vs non-AI and averages the compression ratio", () => {
    const sessions: AggSession[] = [
      s({ issueKey: "AI-1", reportedSeconds: h(2), aiAssisted: true }),
      s({ issueKey: "HU-1", reportedSeconds: h(4), aiAssisted: false }),
    ];
    const estimates: AggEstimate[] = [
      { issueKey: "AI-1", estimateSeconds: h(4) }, // ratio 0.5
      { issueKey: "HU-1", estimateSeconds: h(4) }, // ratio 1.0
    ];
    const c = cohortComparison(sessions, estimates);
    expect(c.ai.tickets).toBe(1);
    expect(c.ai.avgRatio).toBe(0.5);
    expect(c.ai.avgActualHours).toBe(2);
    expect(c.nonAi.tickets).toBe(1);
    expect(c.nonAi.avgRatio).toBe(1);
  });
});

describe("throughputByWeek", () => {
  it("counts distinct tickets and reported hours per week", () => {
    const t = throughputByWeek([
      s({ issueKey: "DEV-1", reportedSeconds: h(1), startedAt: new Date("2026-07-27T02:00:00Z") }),
      s({ issueKey: "DEV-1", reportedSeconds: h(1), startedAt: new Date("2026-07-28T02:00:00Z") }),
      s({ issueKey: "DEV-2", reportedSeconds: h(2), startedAt: new Date("2026-07-28T02:00:00Z") }),
    ]);
    expect(t).toHaveLength(1);
    expect(t[0]!.tickets).toBe(2);
    expect(t[0]!.hours).toBe(4);
  });
});
