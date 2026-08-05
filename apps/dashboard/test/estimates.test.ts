import { describe, expect, it } from "vitest";
import {
  canComputeRatio,
  compressionRatio,
  resolveEstimate,
} from "../src/lib/estimates";

/**
 * Estimate precedence (Phase-5 brief §6B). The two rules worth protecting:
 * Jira wins when it has a real number, and Jira having nothing must never wipe
 * a manual value.
 */

describe("resolveEstimate", () => {
  it("pulls a Jira estimate down when nothing is stored", () => {
    const decision = resolveEstimate(null, 28_800);
    expect(decision).toMatchObject({
      action: "upsert",
      estimateSeconds: 28_800,
      source: "jira",
    });
  });

  it("lets a Jira estimate win over a manual one", () => {
    const decision = resolveEstimate(
      { estimateSeconds: 3600, source: "manual" },
      28_800,
    );
    expect(decision).toMatchObject({ action: "upsert", estimateSeconds: 28_800 });
  });

  it("refreshes a stale Jira estimate", () => {
    const decision = resolveEstimate(
      { estimateSeconds: 3600, source: "jira" },
      7200,
    );
    expect(decision).toMatchObject({ action: "upsert", estimateSeconds: 7200 });
  });

  it("skips the write when already in sync with Jira", () => {
    const decision = resolveEstimate(
      { estimateSeconds: 7200, source: "jira" },
      7200,
    );
    expect(decision.action).toBe("keep");
  });

  it("NEVER wipes a manual estimate when Jira has none", () => {
    for (const jiraValue of [null, 0]) {
      const decision = resolveEstimate(
        { estimateSeconds: 14_400, source: "manual" },
        jiraValue,
      );
      expect(decision.action).toBe("keep");
      expect(decision.reason).toMatch(/no original estimate/i);
    }
  });

  it("does not invent a zero estimate when neither side has one", () => {
    const decision = resolveEstimate(null, null);
    expect(decision.action).toBe("keep");
  });

  it("treats a zero Jira estimate as 'no estimate', not as zero hours", () => {
    const decision = resolveEstimate(null, 0);
    expect(decision.action).toBe("keep");
  });
});

describe("compression ratio guards", () => {
  it("computes a ratio from a real estimate", () => {
    expect(compressionRatio(3600, 7200)).toBe(0.5);
    expect(canComputeRatio(7200)).toBe(true);
  });

  it("returns no ratio for an absent or zero estimate", () => {
    // The bug this guards: 36000 / 0.01 style nonsense on a story-point ticket.
    expect(compressionRatio(36_000, null)).toBeNull();
    expect(compressionRatio(36_000, 0)).toBeNull();
    expect(canComputeRatio(null)).toBe(false);
    expect(canComputeRatio(0)).toBe(false);
  });
});
