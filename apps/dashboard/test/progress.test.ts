import { describe, expect, it } from "vitest";
import {
  computeSessionProgress,
  sessionProgress,
  type EstimateInfo,
  type ProgressSession,
} from "@/lib/progress";

/**
 * Timeline progress bars — cumulative burn against a ticket's estimate.
 * The worked example in the spec: a 2h ticket, 30m in the morning (25%) then 1h
 * in the afternoon (75% cumulative).
 */

const H = 3600;
const EST_2H: EstimateInfo = { estimateSeconds: 2 * H, source: "manual" };

function s(
  id: string,
  ts: string,
  seconds: number,
  issueKey: string | null = "TASK-1",
): ProgressSession {
  return { id, issueKey, startedAt: new Date(ts), reportedSeconds: seconds };
}

describe("sessionProgress — within estimate", () => {
  it("first 30m of a 2h ticket reads 25%", () => {
    const p = sessionProgress(0, 0.5 * H, EST_2H);
    expect(p.percent).toBe(25);
    expect(p.priorWidth).toBe(0);
    expect(p.sessionWidth).toBe(25);
    expect(p.overSessionWidth).toBe(0);
    expect(p.estimateMarkerPct).toBeNull();
    expect(p.remainingSeconds).toBe(1.5 * H);
    expect(p.overSeconds).toBe(0);
  });

  it("a later 1h session reads 75% cumulative, split prior vs this session", () => {
    const p = sessionProgress(0.5 * H, 1 * H, EST_2H);
    expect(p.percent).toBe(75);
    // 25% already burned, this session adds 50% — together the 75% fill.
    expect(p.priorWidth).toBe(25);
    expect(p.sessionWidth).toBe(50);
    expect(p.priorWidth + p.sessionWidth).toBe(75);
    expect(p.cumulativeSeconds).toBe(1.5 * H);
  });

  it("exactly on estimate is 100% with no overrun and no marker", () => {
    const p = sessionProgress(1 * H, 1 * H, EST_2H);
    expect(p.percent).toBe(100);
    expect(p.priorWidth + p.sessionWidth).toBe(100);
    expect(p.overSeconds).toBe(0);
    expect(p.remainingSeconds).toBe(0);
    expect(p.estimateMarkerPct).toBeNull();
  });
});

describe("sessionProgress — over estimate", () => {
  it("rescales the bar and marks where the estimate sat", () => {
    // 1.5h prior + 1.5h now = 3h against a 2h estimate → 150%.
    const p = sessionProgress(1.5 * H, 1.5 * H, EST_2H);
    expect(p.percent).toBe(150);
    expect(p.overSeconds).toBe(1 * H);
    expect(p.remainingSeconds).toBe(0);
    // Container now represents 150%, so the estimate line sits at 2/3.
    expect(p.estimateMarkerPct).toBeCloseTo(66.7, 1);
    // Everything up to the estimate stays in normal colours; the rest is over.
    expect(p.priorWidth).toBe(50);
    expect(p.sessionWidth).toBeCloseTo(16.7, 1);
    expect(p.overSessionWidth).toBeCloseTo(33.3, 1);
    expect(p.overPriorWidth).toBe(0);
  });

  it("attributes the overrun to earlier sessions when they blew the budget", () => {
    // Already 3h (150%) before this session, which adds another 1h → 200%.
    const p = sessionProgress(3 * H, 1 * H, EST_2H);
    expect(p.percent).toBe(200);
    expect(p.estimateMarkerPct).toBe(50);
    expect(p.priorWidth).toBe(50); // the in-estimate part of prior work
    expect(p.overPriorWidth).toBe(25); // prior work past the estimate
    expect(p.overSessionWidth).toBe(25); // this session, all of it over
    expect(p.sessionWidth).toBe(0); // nothing of it fell inside the estimate
  });

  it("keeps segment widths within the container", () => {
    for (const [prior, cur] of [
      [0, 0],
      [0, 10 * H],
      [5 * H, 5 * H],
      [0.1 * H, 0.1 * H],
    ]) {
      const p = sessionProgress(prior!, cur!, EST_2H);
      const total =
        p.priorWidth + p.sessionWidth + p.overPriorWidth + p.overSessionWidth;
      expect(total).toBeLessThanOrEqual(100.1);
    }
  });

  it("a zero-minute session inherits the cumulative total unchanged", () => {
    const p = sessionProgress(1 * H, 0, EST_2H);
    expect(p.percent).toBe(50);
    expect(p.sessionWidth).toBe(0);
    expect(p.priorWidth).toBe(50);
  });
});

describe("computeSessionProgress", () => {
  it("accumulates chronologically regardless of input order", () => {
    const morning = s("a", "2026-08-05T04:00:00Z", 0.5 * H);
    const afternoon = s("b", "2026-08-05T07:00:00Z", 1 * H);
    const estimates = new Map([["TASK-1", EST_2H]]);

    // Timeline renders newest-first, so hand them over in that order.
    const out = computeSessionProgress(
      [afternoon, morning],
      estimates,
      new Map(),
    );

    expect(out.get("a")!.percent).toBe(25);
    expect(out.get("b")!.percent).toBe(75);
  });

  it("carries pre-range time in so the week's first bar isn't misleading", () => {
    const out = computeSessionProgress(
      [s("a", "2026-08-05T04:00:00Z", 0.5 * H)],
      new Map([["TASK-1", EST_2H]]),
      new Map([["TASK-1", 1 * H]]), // an hour was already burned last week
    );
    // 1h prior + 30m = 75%, not 25%.
    expect(out.get("a")!.percent).toBe(75);
    expect(out.get("a")!.priorWidth).toBe(50);
  });

  it("keeps tickets independent of each other", () => {
    const out = computeSessionProgress(
      [
        s("a", "2026-08-05T04:00:00Z", 1 * H, "TASK-1"),
        s("b", "2026-08-05T05:00:00Z", 1 * H, "TASK-2"),
      ],
      new Map([
        ["TASK-1", EST_2H],
        ["TASK-2", EST_2H],
      ]),
      new Map(),
    );
    expect(out.get("a")!.percent).toBe(50);
    expect(out.get("b")!.percent).toBe(50);
  });

  it("omits sessions with no issue key or no estimate", () => {
    const out = computeSessionProgress(
      [
        s("noKey", "2026-08-05T04:00:00Z", 1 * H, null),
        s("noEst", "2026-08-05T05:00:00Z", 1 * H, "TASK-9"),
        s("ok", "2026-08-05T06:00:00Z", 1 * H, "TASK-1"),
      ],
      new Map([["TASK-1", EST_2H]]),
      new Map(),
    );
    expect(out.has("noKey")).toBe(false);
    expect(out.has("noEst")).toBe(false);
    expect(out.has("ok")).toBe(true);
  });

  it("ignores a zero or negative estimate rather than dividing by it", () => {
    const out = computeSessionProgress(
      [s("a", "2026-08-05T04:00:00Z", 1 * H)],
      new Map([["TASK-1", { estimateSeconds: 0, source: "jira" as const }]]),
      new Map(),
    );
    expect(out.size).toBe(0);
  });

  it("preserves the estimate source for the tooltip", () => {
    const out = computeSessionProgress(
      [s("a", "2026-08-05T04:00:00Z", 1 * H)],
      new Map([["TASK-1", { estimateSeconds: 2 * H, source: "jira" as const }]]),
      new Map(),
    );
    expect(out.get("a")!.source).toBe("jira");
  });
});
