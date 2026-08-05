import { describe, expect, it } from "vitest";
import {
  buildDraftDescription,
  canRollupOverwrite,
  draftMatches,
  localDateKey,
  rollupSessions,
  type RollupSession,
} from "../src/lib/rollup";
import {
  buildSyncTag,
  buildWorklogDescription,
  hasSyncTag,
  parseSyncTag,
  stripSyncTag,
} from "../src/lib/sync-tag";

/**
 * Rollup grouping + idempotency-tag tests (brief §8: "unit tests for pure logic
 * — rollup grouping, description/tag generation, idempotency-tag parsing").
 */

const MANILA = "Asia/Manila"; // UTC+8, no DST

let counter = 0;
function session(overrides: Partial<RollupSession> = {}): RollupSession {
  counter++;
  return {
    id: `s${String(counter).padStart(3, "0")}`,
    issueKey: "WEB-101",
    startedAt: new Date("2026-08-05T02:00:00Z"), // 10:00 Manila
    reportedSeconds: 3600,
    aiAssisted: false,
    aiTool: null,
    ...overrides,
  };
}

describe("localDateKey", () => {
  it("uses the user's local calendar day, not UTC", () => {
    // 23:30 UTC on the 4th is already 07:30 on the 5th in Manila.
    const instant = new Date("2026-08-04T23:30:00Z");
    expect(localDateKey(instant, MANILA)).toBe("2026-08-05");
    expect(localDateKey(instant, "UTC")).toBe("2026-08-04");
  });

  it("zero-pads month and day", () => {
    expect(localDateKey(new Date("2026-01-02T05:00:00Z"), MANILA)).toBe("2026-01-02");
  });
});

describe("rollupSessions", () => {
  it("produces one draft per ticket per day, summing reported seconds", () => {
    const drafts = rollupSessions(
      [
        session({ reportedSeconds: 3600 }),
        session({ reportedSeconds: 1800 }),
        session({ issueKey: "API-7", reportedSeconds: 900 }),
      ],
      MANILA,
    );
    expect(drafts).toHaveLength(2);
    const web = drafts.find((d) => d.issueKey === "WEB-101")!;
    expect(web.seconds).toBe(5400);
    expect(web.date).toBe("2026-08-05");
    expect(web.sessionIds).toHaveLength(2);
  });

  it("splits the same ticket across two local days", () => {
    const drafts = rollupSessions(
      [
        session({ startedAt: new Date("2026-08-05T02:00:00Z") }), // 5th Manila
        session({ startedAt: new Date("2026-08-06T02:00:00Z") }), // 6th Manila
      ],
      MANILA,
    );
    expect(drafts.map((d) => d.date)).toEqual(["2026-08-05", "2026-08-06"]);
  });

  it("skips sessions with no issue key — there is nowhere to log them", () => {
    const drafts = rollupSessions(
      [session({ issueKey: null }), session({ issueKey: null })],
      MANILA,
    );
    expect(drafts).toEqual([]);
  });

  it("skips zero-second sessions, which Tempo would reject anyway", () => {
    // Tempo requires timeSpentSeconds >= 1; a fully clamped-out session must
    // not become a draft that can never sync.
    const drafts = rollupSessions([session({ reportedSeconds: 0 })], MANILA);
    expect(drafts).toEqual([]);
  });

  it("still rolls up a ticket whose other sessions were zero", () => {
    const drafts = rollupSessions(
      [session({ reportedSeconds: 0 }), session({ reportedSeconds: 1200 })],
      MANILA,
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.seconds).toBe(1200);
    expect(drafts[0]!.sessionIds).toHaveLength(1);
  });

  it("marks a draft AI-assisted if ANY of its sessions was", () => {
    const drafts = rollupSessions(
      [
        session({ aiAssisted: false }),
        session({ aiAssisted: true, aiTool: "Claude Code" }),
      ],
      MANILA,
    );
    expect(drafts[0]!.aiAssisted).toBe(true);
    expect(drafts[0]!.aiTools).toEqual(["Claude Code"]);
    expect(drafts[0]!.description).toContain("AI-assisted (Claude Code)");
  });

  it("de-duplicates and sorts AI tool names", () => {
    const drafts = rollupSessions(
      [
        session({ aiAssisted: true, aiTool: "Claude Code" }),
        session({ aiAssisted: true, aiTool: "Claude Code" }),
        session({ aiAssisted: true, aiTool: "GitHub Copilot" }),
      ],
      MANILA,
    );
    expect(drafts[0]!.aiTools).toEqual(["Claude Code", "GitHub Copilot"]);
  });

  it("is deterministic — shuffled input yields identical output", () => {
    const sessions = [
      session({ issueKey: "WEB-101" }),
      session({ issueKey: "API-7" }),
      session({ issueKey: "WEB-101", startedAt: new Date("2026-08-06T02:00:00Z") }),
      session({ issueKey: "ZED-2" }),
    ];
    const forward = rollupSessions(sessions, MANILA);
    const reversed = rollupSessions([...sessions].reverse(), MANILA);
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });

  it("orders drafts by date then issue key", () => {
    const drafts = rollupSessions(
      [
        session({ issueKey: "ZED-2", startedAt: new Date("2026-08-06T02:00:00Z") }),
        session({ issueKey: "API-7", startedAt: new Date("2026-08-06T02:00:00Z") }),
        session({ issueKey: "WEB-1", startedAt: new Date("2026-08-05T02:00:00Z") }),
      ],
      MANILA,
    );
    expect(drafts.map((d) => `${d.date}/${d.issueKey}`)).toEqual([
      "2026-08-05/WEB-1",
      "2026-08-06/API-7",
      "2026-08-06/ZED-2",
    ]);
  });

  it("carries no code, paths or prompts into the description (spec §2.2)", () => {
    const drafts = rollupSessions([session()], MANILA);
    expect(drafts[0]!.description).toBe("WEB-101 — 1 session");
  });
});

describe("buildDraftDescription", () => {
  it("singularises a one-session draft", () => {
    expect(
      buildDraftDescription({ issueKey: "A-1", sessionCount: 1, aiTools: [] }),
    ).toBe("A-1 — 1 session");
  });

  it("lists AI tools when present", () => {
    expect(
      buildDraftDescription({
        issueKey: "A-1",
        sessionCount: 3,
        aiTools: ["Claude Code"],
      }),
    ).toBe("A-1 — 3 sessions, AI-assisted (Claude Code)");
  });
});

describe("rollup idempotency guards", () => {
  it("only rewrites untouched drafts", () => {
    expect(canRollupOverwrite("draft")).toBe(true);
    // Once a human has decided, a re-run must not undo it (brief §6C).
    expect(canRollupOverwrite("approved")).toBe(false);
    expect(canRollupOverwrite("synced")).toBe(false);
    expect(canRollupOverwrite("dismissed")).toBe(false);
  });

  it("never re-derives a draft the dev hand-edited", () => {
    // Without this the on-load rollup silently reverts the dev's correction
    // back to the session-derived number.
    expect(canRollupOverwrite("draft", true)).toBe(false);
    expect(canRollupOverwrite("draft", false)).toBe(true);
  });

  it("detects an unchanged draft so a re-run writes nothing", () => {
    const candidate = rollupSessions([session({ id: "s1" })], MANILA)[0]!;
    const stored = {
      seconds: candidate.seconds,
      description: candidate.description,
    };
    expect(draftMatches(stored, candidate)).toBe(true);
    expect(draftMatches({ ...stored, seconds: 999 }, candidate)).toBe(false);
    expect(draftMatches({ ...stored, description: "something else" }, candidate)).toBe(
      false,
    );
    expect(draftMatches({ ...stored, description: null }, candidate)).toBe(false);
  });

  it("ignores session-id churn, which every re-stitch produces", () => {
    // The stitcher rebuilds task_sessions with new UUIDs on each run. If that
    // counted as a change, every nightly rollup would rewrite every draft.
    const first = rollupSessions([session({ id: "old-uuid" })], MANILA)[0]!;
    const second = rollupSessions([session({ id: "new-uuid" })], MANILA)[0]!;
    expect(first.sessionIds).not.toEqual(second.sessionIds);
    expect(
      draftMatches({ seconds: first.seconds, description: first.description }, second),
    ).toBe(true);
  });
});

describe("sync tag", () => {
  const DRAFT_ID = "8f1c0b3a-2f5e-4a1b-9c7d-0e1f2a3b4c5d";

  it("builds the documented tag format", () => {
    expect(buildSyncTag(DRAFT_ID)).toBe(`[mnl-dev-telemetry:${DRAFT_ID}]`);
  });

  it("appends the tag after the human text", () => {
    expect(buildWorklogDescription("WEB-101 — 2 sessions", DRAFT_ID)).toBe(
      `WEB-101 — 2 sessions [mnl-dev-telemetry:${DRAFT_ID}]`,
    );
  });

  it("still tags a draft with an empty description", () => {
    expect(buildWorklogDescription(null, DRAFT_ID)).toBe(buildSyncTag(DRAFT_ID));
    expect(buildWorklogDescription("   ", DRAFT_ID)).toBe(buildSyncTag(DRAFT_ID));
  });

  it("round-trips: a built description parses back to its draft id", () => {
    const description = buildWorklogDescription("some work", DRAFT_ID);
    expect(parseSyncTag(description)).toBe(DRAFT_ID);
    expect(hasSyncTag(description, DRAFT_ID)).toBe(true);
  });

  it("does not match a different draft's tag", () => {
    const description = buildWorklogDescription("some work", DRAFT_ID);
    expect(hasSyncTag(description, "another-id")).toBe(false);
  });

  it("finds the tag after a human edited the description in Tempo", () => {
    expect(
      parseSyncTag(`I rewrote this note [mnl-dev-telemetry:${DRAFT_ID}] and added more`),
    ).toBe(DRAFT_ID);
    expect(parseSyncTag(`[ mnl-dev-telemetry : ${DRAFT_ID} ]`)).toBe(DRAFT_ID);
  });

  it("returns null for untagged or absent descriptions", () => {
    expect(parseSyncTag("just a normal worklog")).toBeNull();
    expect(parseSyncTag("")).toBeNull();
    expect(parseSyncTag(null)).toBeNull();
    expect(parseSyncTag("[other-tool:123]")).toBeNull();
  });

  it("strips the tag for display", () => {
    expect(stripSyncTag(buildWorklogDescription("real work", DRAFT_ID))).toBe(
      "real work",
    );
    expect(stripSyncTag(buildSyncTag(DRAFT_ID))).toBe("");
    expect(stripSyncTag(null)).toBe("");
  });
});
