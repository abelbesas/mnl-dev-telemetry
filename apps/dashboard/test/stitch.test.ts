import { describe, expect, it } from "vitest";
import {
  clampedSecondsForSpan,
  friendlyAiTool,
  stitchUserEvents,
  type StitchEvent,
  type WorkingHours,
} from "@/lib/stitch";
import { wallTimeToUtc, zonedParts } from "@/lib/tz";

/**
 * Stitching is "the math that is the product" (spec §4.2). These are the Phase-4
 * acceptance checks encoded as tests: gap handling, explicit boundaries,
 * grouping, the AI flag, the working-hours clamp, and deterministic re-runs.
 */

const MANILA: WorkingHours = {
  tz: "Asia/Manila", // UTC+8, no DST → local H == UTC (H-8)
  workdayStart: "09:00",
  workdayEnd: "18:00",
};

let seq = 0;
function ev(
  overrides: Omit<Partial<StitchEvent>, "ts"> & { ts: string },
): StitchEvent {
  return {
    id: `e${seq++}`,
    type: "commit",
    source: "git_hook",
    issueKey: "DEV-1",
    repo: "acme",
    branch: "feature/DEV-1",
    aiCoAuthor: null,
    toolName: null,
    ...overrides,
    ts: new Date(overrides.ts),
  };
}

// --- Timezone primitives --------------------------------------------------

describe("tz helpers", () => {
  it("maps Manila wall-clock to UTC at +8", () => {
    // 2026-07-27 09:00 Manila == 01:00 UTC.
    expect(wallTimeToUtc(2026, 7, 27, 9, 0, "Asia/Manila").toISOString()).toBe(
      "2026-07-27T01:00:00.000Z",
    );
  });

  it("handles a DST zone correctly (New York, summer = -4)", () => {
    expect(
      wallTimeToUtc(2026, 7, 27, 9, 0, "America/New_York").toISOString(),
    ).toBe("2026-07-27T13:00:00.000Z");
  });

  it("reports weekday 1..7 Mon..Sun", () => {
    // 2026-07-27 is a Monday.
    expect(zonedParts(new Date("2026-07-27T05:00:00Z"), "Asia/Manila").weekday).toBe(1);
    // 2026-07-25 is a Saturday.
    expect(zonedParts(new Date("2026-07-25T05:00:00Z"), "Asia/Manila").weekday).toBe(6);
  });
});

// --- Working-hours clamp --------------------------------------------------

describe("clampedSecondsForSpan", () => {
  it("counts a span fully inside working hours in full", () => {
    // Mon 10:00–11:00 Manila == 02:00–03:00 UTC.
    const s = clampedSecondsForSpan(
      new Date("2026-07-27T02:00:00Z"),
      new Date("2026-07-27T03:00:00Z"),
      MANILA,
    );
    expect(s).toBe(3600);
  });

  it("clamps the pre-09:00 portion of a morning span", () => {
    // Mon 08:30–09:30 Manila == 00:30–01:30 UTC → only 09:00–09:30 counts.
    const s = clampedSecondsForSpan(
      new Date("2026-07-27T00:30:00Z"),
      new Date("2026-07-27T01:30:00Z"),
      MANILA,
    );
    expect(s).toBe(1800);
  });

  it("clamps the post-18:00 portion of an evening span", () => {
    // Mon 17:30–18:30 Manila == 09:30–10:30 UTC → only 17:30–18:00 counts.
    const s = clampedSecondsForSpan(
      new Date("2026-07-27T09:30:00Z"),
      new Date("2026-07-27T10:30:00Z"),
      MANILA,
    );
    expect(s).toBe(1800);
  });

  it("reports zero for an after-hours span", () => {
    // Mon 19:00–20:00 Manila == 11:00–12:00 UTC.
    const s = clampedSecondsForSpan(
      new Date("2026-07-27T11:00:00Z"),
      new Date("2026-07-27T12:00:00Z"),
      MANILA,
    );
    expect(s).toBe(0);
  });

  it("reports zero on a weekend", () => {
    // Sat 2026-07-25 10:00–11:00 Manila == 02:00–03:00 UTC.
    const s = clampedSecondsForSpan(
      new Date("2026-07-25T02:00:00Z"),
      new Date("2026-07-25T03:00:00Z"),
      MANILA,
    );
    expect(s).toBe(0);
  });

  it("sums working windows across a multi-day span, skipping the weekend", () => {
    // Fri 17:00 → Mon 10:00 Manila. Fri 17:00–18:00 = 1h; Sat/Sun = 0;
    // Mon 09:00–10:00 = 1h; total 2h.
    const s = clampedSecondsForSpan(
      new Date("2026-07-24T09:00:00Z"), // Fri 17:00 Manila
      new Date("2026-07-27T02:00:00Z"), // Mon 10:00 Manila
      MANILA,
    );
    expect(s).toBe(2 * 3600);
  });
});

// --- Gap handling & explicit boundaries -----------------------------------

describe("stitchUserEvents — session boundaries", () => {
  it("keeps events within the gap in one session and splits past it", () => {
    const events = [
      ev({ ts: "2026-07-27T02:00:00Z" }),
      ev({ ts: "2026-07-27T02:30:00Z" }), // +30m, within 45m gap
      ev({ ts: "2026-07-27T03:45:00Z" }), // +75m from prev, exceeds gap
    ];
    const sessions = stitchUserEvents(events, MANILA);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.eventCount).toBe(2);
    expect(sessions[0]!.rawSeconds).toBe(1800);
    expect(sessions[1]!.eventCount).toBe(1);
    expect(sessions[1]!.rawSeconds).toBe(0);
  });

  it("closes a session on an explicit session_end even within the gap", () => {
    const events = [
      ev({ ts: "2026-07-27T02:00:00Z" }),
      ev({ ts: "2026-07-27T02:10:00Z", type: "session_end", source: "cc_hook" }),
      ev({ ts: "2026-07-27T02:20:00Z" }), // 10m later — still a NEW session
    ];
    const sessions = stitchUserEvents(events, MANILA);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.eventCount).toBe(2); // includes the session_end
    expect(sessions[1]!.eventCount).toBe(1);
  });

  it("closes a session on task_stop", () => {
    const events = [
      ev({ ts: "2026-07-27T02:00:00Z", type: "task_start", source: "mcp" }),
      ev({ ts: "2026-07-27T02:15:00Z", type: "task_stop", source: "mcp" }),
      ev({ ts: "2026-07-27T02:20:00Z" }),
    ];
    const sessions = stitchUserEvents(events, MANILA);
    expect(sessions).toHaveLength(2);
  });
});

// --- Grouping -------------------------------------------------------------

describe("stitchUserEvents — grouping", () => {
  it("groups by issue key", () => {
    const events = [
      ev({ ts: "2026-07-27T02:00:00Z", issueKey: "DEV-1" }),
      ev({ ts: "2026-07-27T02:05:00Z", issueKey: "DEV-2", branch: "feature/DEV-2" }),
      ev({ ts: "2026-07-27T02:10:00Z", issueKey: "DEV-1" }),
    ];
    const sessions = stitchUserEvents(events, MANILA);
    expect(sessions).toHaveLength(2);
    const keys = sessions.map((s) => s.issueKey).sort();
    expect(keys).toEqual(["DEV-1", "DEV-2"]);
    expect(sessions.find((s) => s.issueKey === "DEV-1")!.eventCount).toBe(2);
  });

  it("falls back to repo+branch when there is no issue key", () => {
    const events = [
      ev({ ts: "2026-07-27T02:00:00Z", issueKey: null, branch: "main" }),
      ev({ ts: "2026-07-27T02:10:00Z", issueKey: null, branch: "main" }),
      ev({ ts: "2026-07-27T02:20:00Z", issueKey: null, branch: "spike" }),
    ];
    const sessions = stitchUserEvents(events, MANILA);
    expect(sessions).toHaveLength(2); // main (2 events) + spike (1 event)
    expect(sessions.every((s) => s.issueKey === null)).toBe(true);
    expect(sessions.map((s) => s.repo)).toEqual(["acme", "acme"]);
  });
});

// --- AI attribution -------------------------------------------------------

describe("stitchUserEvents — AI flag", () => {
  it("flags a session containing an mcp event", () => {
    const sessions = stitchUserEvents(
      [
        ev({ ts: "2026-07-27T02:00:00Z" }),
        ev({ ts: "2026-07-27T02:05:00Z", type: "tool_call", source: "mcp", toolName: "log_context" }),
      ],
      MANILA,
    );
    expect(sessions[0]!.aiAssisted).toBe(true);
    expect(sessions[0]!.aiTool).toBe("Claude Code");
  });

  it("flags a session from a cc_hook event", () => {
    const sessions = stitchUserEvents(
      [ev({ ts: "2026-07-27T02:00:00Z", type: "session_start", source: "cc_hook" })],
      MANILA,
    );
    expect(sessions[0]!.aiAssisted).toBe(true);
  });

  it("flags a commit carrying an AI co-author trailer", () => {
    const sessions = stitchUserEvents(
      [ev({ ts: "2026-07-27T02:00:00Z", aiCoAuthor: "Claude <noreply@anthropic.com>" })],
      MANILA,
    );
    expect(sessions[0]!.aiAssisted).toBe(true);
    expect(sessions[0]!.aiTool).toBe("Claude Code");
  });

  it("leaves a plain human session unflagged", () => {
    const sessions = stitchUserEvents(
      [
        ev({ ts: "2026-07-27T02:00:00Z" }),
        ev({ ts: "2026-07-27T02:05:00Z", type: "push", source: "git_hook" }),
      ],
      MANILA,
    );
    expect(sessions[0]!.aiAssisted).toBe(false);
    expect(sessions[0]!.aiTool).toBeNull();
  });

  it("normalises co-author trailers to friendly tool names", () => {
    expect(friendlyAiTool("Claude <noreply@anthropic.com>")).toBe("Claude Code");
    expect(friendlyAiTool("Copilot")).toBe("GitHub Copilot");
    expect(friendlyAiTool("Cursor Agent")).toBe("Cursor");
    expect(friendlyAiTool("some-bot")).toBe("Some-bot");
  });
});

// --- Determinism ----------------------------------------------------------

describe("stitchUserEvents — determinism", () => {
  it("produces identical sessions regardless of input order", () => {
    const base = [
      ev({ ts: "2026-07-27T02:00:00Z", issueKey: "DEV-1" }),
      ev({ ts: "2026-07-27T02:20:00Z", issueKey: "DEV-1", type: "tool_call", source: "mcp", toolName: "t" }),
      ev({ ts: "2026-07-27T04:00:00Z", issueKey: "DEV-2", branch: "feature/DEV-2" }),
      ev({ ts: "2026-07-27T04:10:00Z", issueKey: "DEV-2", branch: "feature/DEV-2" }),
      ev({ ts: "2026-07-27T06:00:00Z", issueKey: "DEV-1" }),
    ];
    const shuffled = [base[3], base[0], base[4], base[1], base[2]] as StitchEvent[];

    const a = stitchUserEvents(base, MANILA);
    const b = stitchUserEvents(shuffled, MANILA);
    expect(b).toEqual(a);
  });
});
