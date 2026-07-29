import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_INTERVAL_MINUTES,
  STITCH_GAP_MINUTES,
} from "@mnl-dev-telemetry/shared";
import { stitchUserEvents, type StitchEvent, type WorkingHours } from "@/lib/stitch";

/**
 * Phase 6 §4a — heartbeats as the accuracy fix, verified against the *unchanged*
 * stitcher. The brief is explicit that `stitch.ts` needs no modification; these
 * tests are the proof of that claim, and the first one is the headline
 * acceptance check for the phase:
 *
 *   "edit from 10:00, commit at 10:30, stitch → the session reads ~30 min
 *    starting at 10:00 (not 0 min at 10:30)."
 */

const MANILA: WorkingHours = {
  tz: "Asia/Manila", // UTC+8, no DST → 02:00Z == 10:00 local, inside 09:00–18:00
  workdayStart: "09:00",
  workdayEnd: "18:00",
};

let seq = 0;

/** A heartbeat as the extension sends it: source `extension`, no metadata. */
function heartbeat(ts: string): StitchEvent {
  return {
    id: `h${seq++}`,
    type: "heartbeat",
    source: "extension",
    issueKey: "TEX-777",
    repo: "acme-web",
    branch: "TEX-777-add-widget",
    ts: new Date(ts),
  };
}

function commit(ts: string, aiCoAuthor: string | null = null): StitchEvent {
  return {
    id: `c${seq++}`,
    type: "commit",
    source: "git_hook",
    issueKey: "TEX-777",
    repo: "acme-web",
    branch: "TEX-777-add-widget",
    aiCoAuthor,
    ts: new Date(ts),
  };
}

/** Pings every HEARTBEAT_INTERVAL_MINUTES from `fromMin` to `toMin` (UTC hour 02). */
function pings(fromMin: number, toMin: number): StitchEvent[] {
  const out: StitchEvent[] = [];
  for (let m = fromMin; m <= toMin; m += HEARTBEAT_INTERVAL_MINUTES) {
    out.push(heartbeat(`2026-07-29T02:${String(m).padStart(2, "0")}:00.000Z`));
  }
  return out;
}

describe("the accuracy win (headline acceptance check)", () => {
  it("a commit alone reports zero minutes — the failure being fixed", () => {
    const [session] = stitchUserEvents(
      [commit("2026-07-29T02:30:00.000Z")],
      MANILA,
    );
    expect(session?.startedAt.toISOString()).toBe("2026-07-29T02:30:00.000Z");
    expect(session?.reportedSeconds).toBe(0);
  });

  it("heartbeats from 10:00 + a commit at 10:30 report ~30 min starting at 10:00", () => {
    const events = [...pings(0, 30), commit("2026-07-29T02:30:00.000Z")];
    const sessions = stitchUserEvents(events, MANILA);

    expect(sessions).toHaveLength(1);
    const session = sessions[0]!;
    // Starts when work started (10:00 local), not at the commit.
    expect(session.startedAt.toISOString()).toBe("2026-07-29T02:00:00.000Z");
    expect(session.endedAt.toISOString()).toBe("2026-07-29T02:30:00.000Z");
    expect(session.reportedSeconds).toBe(30 * 60);
    expect(session.rawSeconds).toBe(30 * 60);
    expect(session.eventCount).toBe(8); // 7 pings + 1 commit
  });

  it("keeps counting after the commit — the trailing 90 minutes no longer vanish", () => {
    // Commit at 10:30, work on until 12:00 (02:30 → 04:00 UTC).
    const events = [
      ...pings(0, 30),
      commit("2026-07-29T02:30:00.000Z"),
      ...Array.from({ length: 18 }, (_, i) =>
        heartbeat(
          new Date(
            Date.parse("2026-07-29T02:35:00.000Z") +
              i * HEARTBEAT_INTERVAL_MINUTES * 60_000,
          ).toISOString(),
        ),
      ),
    ];
    const sessions = stitchUserEvents(events, MANILA);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.startedAt.toISOString()).toBe("2026-07-29T02:00:00.000Z");
    expect(sessions[0]!.endedAt.toISOString()).toBe("2026-07-29T04:00:00.000Z");
    expect(sessions[0]!.reportedSeconds).toBe(120 * 60);
  });
});

describe("stitcher interaction (verify, don't change)", () => {
  it("the ping interval is far below the session gap, so pings never split a session", () => {
    expect(HEARTBEAT_INTERVAL_MINUTES).toBeLessThan(STITCH_GAP_MINUTES);

    // Two hours of continuous pings must remain exactly one session.
    const sessions = stitchUserEvents(pings(0, 55), MANILA);
    expect(sessions).toHaveLength(1);
  });

  it("still splits when the dev actually stops for longer than the gap", () => {
    // Morning block, a 50-minute break (> 45), then an afternoon block.
    const morning = pings(0, 20);
    const afternoon = [
      heartbeat("2026-07-29T03:15:00.000Z"),
      heartbeat("2026-07-29T03:20:00.000Z"),
    ];
    const sessions = stitchUserEvents([...morning, ...afternoon], MANILA);

    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.endedAt.toISOString()).toBe("2026-07-29T02:20:00.000Z");
    expect(sessions[1]!.startedAt.toISOString()).toBe("2026-07-29T03:15:00.000Z");
  });

  it("bounds the trailing over-count by one interval instead of losing hours", () => {
    // Dev stops editing right after the 10:30 ping. The session ends there, so
    // we over-count by at most the interval — the opposite failure mode to
    // dropping 90 minutes, and a far cheaper one.
    const sessions = stitchUserEvents(pings(0, 30), MANILA);
    const overCountSeconds =
      sessions[0]!.endedAt.getTime() -
      Date.parse("2026-07-29T02:25:00.000Z"); // last "real" activity moment
    expect(overCountSeconds / 1000).toBeLessThanOrEqual(
      HEARTBEAT_INTERVAL_MINUTES * 60,
    );
  });

  it("does not mark a session AI-assisted (heartbeats are agent-agnostic)", () => {
    // The dev who never touches AI is the user heartbeats exist for; a ping must
    // never imply an agent was involved.
    const sessions = stitchUserEvents(
      [...pings(0, 30), commit("2026-07-29T02:30:00.000Z")],
      MANILA,
    );
    expect(sessions[0]!.aiAssisted).toBe(false);
    expect(sessions[0]!.aiTool).toBeNull();

    // …and it still detects AI when a commit genuinely carries a trailer.
    const withAi = stitchUserEvents(
      [
        ...pings(0, 30),
        commit("2026-07-29T02:30:00.000Z", "Claude <noreply@anthropic.com>"),
      ],
      MANILA,
    );
    expect(withAi[0]!.aiAssisted).toBe(true);
    expect(withAi[0]!.aiTool).toBe("Claude Code");
  });

  it("groups heartbeats by issue key from the branch, like every other event", () => {
    const other: StitchEvent = {
      id: "x1",
      type: "heartbeat",
      source: "extension",
      issueKey: "TEX-888",
      repo: "acme-web",
      branch: "TEX-888-other",
      ts: new Date("2026-07-29T02:10:00.000Z"),
    };
    const sessions = stitchUserEvents([...pings(0, 20), other], MANILA);
    expect(sessions.map((s) => s.issueKey).sort()).toEqual([
      "TEX-777",
      "TEX-888",
    ]);
  });
});
