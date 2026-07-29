import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_IDLE_MS,
  HEARTBEAT_INTERVAL_MS,
  isActivityScheme,
  shouldSendHeartbeat,
  type HeartbeatDecisionInput,
} from "../src/lib/heartbeat";

/**
 * Acceptance (brief §5): "Idle: leaving the editor open but untouched for 20
 * minutes produces NO further heartbeats (unit-test the pure idle-decision
 * function)."
 *
 * This is the rule that keeps heartbeats trustworthy — a ping that fires on
 * window presence alone would log 8 phantom hours overnight and poison the very
 * metric the phase exists to fix.
 */

const T0 = Date.parse("2026-07-29T02:00:00.000Z");
const min = (n: number) => n * 60_000;

function input(overrides: Partial<HeartbeatDecisionInput> = {}): HeartbeatDecisionInput {
  return {
    now: T0,
    lastActivityAt: T0,
    lastSentAt: null,
    hasCredentials: true,
    repo: { name: "acme-web", branch: "TEX-123-add-widget" },
    ...overrides,
  };
}

describe("shouldSendHeartbeat — sends", () => {
  it("sends on the first tick after real activity", () => {
    // This is what fixes the 10:00-work/10:30-commit case: the session opens at
    // the first ping, within a minute of the dev starting work.
    expect(shouldSendHeartbeat(input())).toEqual({ send: true });
  });

  it("sends again once the interval has elapsed and work continues", () => {
    const now = T0 + HEARTBEAT_INTERVAL_MS;
    expect(
      shouldSendHeartbeat(
        input({ now, lastActivityAt: now - min(1), lastSentAt: T0 }),
      ),
    ).toEqual({ send: true });
  });

  it("sends on a keyless branch (time still groups by repo + branch)", () => {
    expect(
      shouldSendHeartbeat(input({ repo: { name: "acme-web", branch: "main" } })),
    ).toEqual({ send: true });
  });

  it("sends with a null branch (detached HEAD)", () => {
    expect(
      shouldSendHeartbeat(input({ repo: { name: "acme-web", branch: null } })),
    ).toEqual({ send: true });
  });
});

describe("shouldSendHeartbeat — idle (the mandatory gate)", () => {
  it("stops once the editor has been untouched past the idle timeout", () => {
    expect(
      shouldSendHeartbeat(input({ now: T0 + HEARTBEAT_IDLE_MS + min(1) })),
    ).toEqual({ send: false, reason: "idle" });
  });

  it("sends nothing after 20 minutes of an open-but-untouched editor", () => {
    // The literal acceptance check: tick every minute for 20 minutes with no
    // activity after T0, and count how many pings would fire.
    let lastSentAt: number | null = null;
    let sent = 0;
    for (let m = 0; m <= 20; m++) {
      const now = T0 + min(m);
      const decision = shouldSendHeartbeat(
        input({ now, lastActivityAt: T0, lastSentAt }),
      );
      if (decision.send) {
        sent++;
        lastSentAt = now;
      }
    }
    // Only the pings inside the idle window fire; nothing after it.
    expect(sent).toBe(2); // t=0 and t=5 (last activity was at t=0)
    expect(lastSentAt).toBe(T0 + HEARTBEAT_IDLE_MS);
  });

  it("resumes on the next real edit after going idle", () => {
    const idleAt = T0 + min(60);
    expect(shouldSendHeartbeat(input({ now: idleAt, lastSentAt: T0 }))).toEqual({
      send: false,
      reason: "idle",
    });
    // Dev comes back and types.
    expect(
      shouldSendHeartbeat(
        input({ now: idleAt, lastActivityAt: idleAt, lastSentAt: T0 }),
      ),
    ).toEqual({ send: true });
  });

  it("never sends before any activity at all", () => {
    expect(shouldSendHeartbeat(input({ lastActivityAt: null }))).toEqual({
      send: false,
      reason: "no-activity-yet",
    });
  });
});

describe("shouldSendHeartbeat — other gates", () => {
  it("sends nothing when the machine is not set up, and does not nag", () => {
    expect(shouldSendHeartbeat(input({ hasCredentials: false }))).toEqual({
      send: false,
      reason: "not-set-up",
    });
  });

  it("sends nothing with no repo — there would be nothing to attribute to", () => {
    expect(shouldSendHeartbeat(input({ repo: null }))).toEqual({
      send: false,
      reason: "no-repo",
    });
    expect(
      shouldSendHeartbeat(input({ repo: { name: null, branch: "main" } })),
    ).toEqual({ send: false, reason: "no-repo" });
  });

  it("does not ping more often than the interval, however much you type", () => {
    for (const m of [0, 1, 2, 3, 4]) {
      const now = T0 + min(m) + 1;
      expect(
        shouldSendHeartbeat(input({ now, lastActivityAt: now, lastSentAt: T0 })),
      ).toEqual({ send: false, reason: "too-soon" });
    }
  });

  it("checks credentials before anything else (cheapest refusal first)", () => {
    expect(
      shouldSendHeartbeat(
        input({ hasCredentials: false, repo: null, lastActivityAt: null }),
      ),
    ).toEqual({ send: false, reason: "not-set-up" });
  });
});

describe("isActivityScheme", () => {
  it("counts only real file edits", () => {
    expect(isActivityScheme("file")).toBe(true);
  });

  it("ignores our own output channel — otherwise logging keeps itself alive", () => {
    expect(isActivityScheme("output")).toBe(false);
  });

  it("ignores git diffs, settings writes, debug consoles and unknowns", () => {
    for (const scheme of [
      "git",
      "vscode-userdata",
      "debug",
      "untitled",
      "vscode-scm",
      undefined,
    ]) {
      expect(isActivityScheme(scheme)).toBe(false);
    }
  });
});
