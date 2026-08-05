import "dotenv/config";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { taskSessions, users, worklogDrafts } from "@/db/schema";
import {
  approveDay,
  approveDraft,
  dismissDraft,
  getUserDraft,
  getUserDrafts,
  updateDraft,
} from "@/lib/drafts";
import { runRollup } from "@/lib/rollup-run";
import { syncDraft } from "@/lib/sync-run";

/**
 * DB-level tests for the two acceptance checks that are properties of the
 * *queries*, not the UI (brief §8):
 *
 *   - "User A cannot read or approve user B's draft (test the query, not the UI)"
 *   - "Nightly rollup … re-running changes nothing (idempotent); approved/synced
 *      drafts are untouched"
 *
 * Skips itself when Postgres isn't reachable, so `pnpm test` stays green in an
 * environment without the docker-compose DB.
 */

const A_EMAIL = "phase5-a@test.local";
const B_EMAIL = "phase5-b@test.local";

let dbAvailable = false;
let userA = "";
let userB = "";

/** Sessions land on a Wednesday inside 09:00–18:00 Manila, so nothing is clamped. */
const DAY_1 = new Date("2026-08-05T02:00:00Z"); // 10:00 Manila, Wed
const DAY_2 = new Date("2026-08-06T02:00:00Z");

beforeAll(async () => {
  try {
    const db = getDb();
    await db.execute("select 1");
    dbAvailable = true;
  } catch {
    return;
  }
  await cleanup();

  const db = getDb();
  const [a] = await db
    .insert(users)
    .values({ email: A_EMAIL, name: "Phase5 A", tz: "Asia/Manila" })
    .returning();
  const [b] = await db
    .insert(users)
    .values({ email: B_EMAIL, name: "Phase5 B", tz: "Asia/Manila" })
    .returning();
  userA = a!.id;
  userB = b!.id;

  await db.insert(taskSessions).values([
    {
      userId: userA,
      issueKey: "WEB-101",
      startedAt: DAY_1,
      endedAt: new Date(DAY_1.getTime() + 3600_000),
      reportedSeconds: 3600,
      aiAssisted: true,
      aiTool: "Claude Code",
      eventCount: 4,
    },
    {
      userId: userA,
      issueKey: "WEB-101",
      startedAt: new Date(DAY_1.getTime() + 7200_000),
      endedAt: new Date(DAY_1.getTime() + 9000_000),
      reportedSeconds: 1800,
      aiAssisted: false,
      aiTool: null,
      eventCount: 2,
    },
    {
      userId: userA,
      issueKey: "API-7",
      startedAt: DAY_2,
      endedAt: new Date(DAY_2.getTime() + 1800_000),
      reportedSeconds: 1800,
      aiAssisted: false,
      aiTool: null,
      eventCount: 2,
    },
    // A session with no issue key — must never become a draft.
    {
      userId: userA,
      issueKey: null,
      repo: "scratch",
      startedAt: DAY_2,
      endedAt: new Date(DAY_2.getTime() + 3600_000),
      reportedSeconds: 3600,
      aiAssisted: false,
      aiTool: null,
      eventCount: 1,
    },
    // User B's own work, on the same ticket and day as A's.
    {
      userId: userB,
      issueKey: "WEB-101",
      startedAt: DAY_1,
      endedAt: new Date(DAY_1.getTime() + 3600_000),
      reportedSeconds: 3600,
      aiAssisted: false,
      aiTool: null,
      eventCount: 3,
    },
  ]);
});

afterAll(async () => {
  if (dbAvailable) await cleanup();
});

async function cleanup(): Promise<void> {
  const db = getDb();
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.email, [A_EMAIL, B_EMAIL]));
  const ids = existing.map((r) => r.id);
  if (ids.length === 0) return;
  // worklog_drafts / task_sessions cascade from users.
  await db.delete(users).where(inArray(users.id, ids));
}

const dbIt = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!dbAvailable) {
      console.warn("skipping: Postgres not reachable (run `pnpm db:up`)");
      return;
    }
    await fn();
  });

describe("rollup (DB)", () => {
  dbIt("produces one draft per ticket per day", async () => {
    const result = await runRollup({ userId: userA });
    expect(result.created).toBe(2); // WEB-101 on day 1, API-7 on day 2

    const drafts = await getUserDrafts(userA);
    expect(drafts.map((d) => `${d.date}/${d.issueKey}`).sort()).toEqual([
      "2026-08-05/WEB-101",
      "2026-08-06/API-7",
    ]);
    // Both of A's WEB-101 sessions summed into one draft.
    const web = drafts.find((d) => d.issueKey === "WEB-101")!;
    expect(web.seconds).toBe(5400);
    expect(web.description).toBe("WEB-101 — 2 sessions, AI-assisted (Claude Code)");
  });

  dbIt("skips sessions with no issue key", async () => {
    const drafts = await getUserDrafts(userA);
    expect(drafts.every((d) => d.issueKey)).toBe(true);
    expect(drafts).toHaveLength(2);
  });

  dbIt("is idempotent — re-running changes nothing", async () => {
    const before = await getUserDrafts(userA);
    const rerun = await runRollup({ userId: userA });

    expect(rerun.created).toBe(0);
    expect(rerun.updated).toBe(0);
    expect(rerun.unchanged).toBe(2);

    const after = await getUserDrafts(userA);
    expect(after.map((d) => [d.id, d.seconds, d.description])).toEqual(
      before.map((d) => [d.id, d.seconds, d.description]),
    );
  });

  dbIt("keeps each user's drafts separate on the same ticket and day", async () => {
    await runRollup({ userId: userB });
    const aDrafts = await getUserDrafts(userA);
    const bDrafts = await getUserDrafts(userB);
    const aWeb = aDrafts.find((d) => d.issueKey === "WEB-101")!;
    const bWeb = bDrafts.find((d) => d.issueKey === "WEB-101")!;
    expect(aWeb.id).not.toBe(bWeb.id);
    expect(aWeb.seconds).toBe(5400);
    expect(bWeb.seconds).toBe(3600);
  });

  dbIt("a hand-edited draft survives the next rollup", async () => {
    const web = (await getUserDrafts(userA)).find((d) => d.issueKey === "WEB-101")!;
    expect(web.seconds).toBe(5400);

    const edit = await updateDraft(userA, web.id, {
      seconds: 9000,
      description: "pairing with Bob on the auth bug",
    });
    expect(edit.ok).toBe(true);

    await runRollup({ userId: userA });

    // The dev's correction must NOT be reverted to the session-derived 5400.
    const after = await getUserDraft(userA, web.id);
    expect(after!.seconds).toBe(9000);
    expect(after!.description).toBe("pairing with Bob on the auth bug");
    expect(after!.edited).toBe(true);

    // Restore so the later status tests start from the generated values.
    const db = getDb();
    await db
      .update(worklogDrafts)
      .set({
        seconds: 5400,
        edited: false,
        description: "WEB-101 — 2 sessions, AI-assisted (Claude Code)",
      })
      .where(eq(worklogDrafts.id, web.id));
  });

  dbIt("leaves approved and dismissed drafts untouched on a re-run", async () => {
    const drafts = await getUserDrafts(userA);
    const web = drafts.find((d) => d.issueKey === "WEB-101")!;
    const api = drafts.find((d) => d.issueKey === "API-7")!;

    await approveDraft(userA, web.id);
    await dismissDraft(userA, api.id);

    const result = await runRollup({ userId: userA });
    expect(result.preserved).toBe(2);
    expect(result.updated).toBe(0);

    const after = await getUserDrafts(userA, {
      statuses: ["draft", "approved", "synced", "dismissed"],
    });
    expect(after.find((d) => d.id === web.id)!.status).toBe("approved");
    expect(after.find((d) => d.id === api.id)!.status).toBe("dismissed");
  });
});

describe("own-data enforcement (DB)", () => {
  dbIt("user A cannot READ user B's draft", async () => {
    const bDrafts = await getUserDrafts(userB);
    const bDraft = bDrafts[0]!;

    // The query, not the UI, is what refuses.
    expect(await getUserDraft(userA, bDraft.id)).toBeNull();
    expect(await getUserDraft(userB, bDraft.id)).not.toBeNull();

    const aList = await getUserDrafts(userA, {
      statuses: ["draft", "approved", "synced", "dismissed"],
    });
    expect(aList.some((d) => d.id === bDraft.id)).toBe(false);
  });

  dbIt("user A cannot APPROVE user B's draft", async () => {
    const bDraft = (await getUserDrafts(userB))[0]!;

    const result = await approveDraft(userA, bDraft.id);
    expect(result.ok).toBe(false);
    expect(result.draft).toBeUndefined();

    // B's row is untouched.
    const after = await getUserDraft(userB, bDraft.id);
    expect(after!.status).toBe("draft");
    expect(after!.approvedAt).toBeNull();
  });

  dbIt("user A cannot EDIT or DISMISS user B's draft", async () => {
    const bDraft = (await getUserDrafts(userB))[0]!;

    expect((await updateDraft(userA, bDraft.id, { seconds: 99 })).ok).toBe(false);
    expect((await dismissDraft(userA, bDraft.id)).ok).toBe(false);

    const after = await getUserDraft(userB, bDraft.id);
    expect(after!.seconds).toBe(bDraft.seconds);
    expect(after!.status).toBe("draft");
  });

  dbIt("approve-all only touches the caller's drafts for that day", async () => {
    const bDraft = (await getUserDrafts(userB))[0]!;
    await approveDay(userA, bDraft.date);
    expect((await getUserDraft(userB, bDraft.id))!.status).toBe("draft");
  });
});

describe("sync guards (DB)", () => {
  dbIt("a dismissed draft never syncs", async () => {
    const db = getDb();
    const [dismissed] = await db
      .select()
      .from(worklogDrafts)
      .where(
        and(eq(worklogDrafts.userId, userA), eq(worklogDrafts.status, "dismissed")),
      )
      .limit(1);
    expect(dismissed).toBeDefined();

    // Called directly, bypassing the queue — it must still refuse.
    const outcome = await syncDraft(userA, dismissed!, {
      resolveIssue: async () => {
        throw new Error("adapter must not be reached for a dismissed draft");
      },
      createIssue: async () => {
        throw new Error("adapter must not be reached for a dismissed draft");
      },
      pushWorklog: async () => {
        throw new Error("adapter must not be reached for a dismissed draft");
      },
    });

    expect(outcome.status).toBe("skipped");
    expect(outcome.message).toMatch(/not approved/i);
    expect((await getUserDraft(userA, dismissed!.id))!.status).toBe("dismissed");
  });

  dbIt("a failed push records the error and leaves the draft approved", async () => {
    const db = getDb();
    const [approved] = await db
      .select()
      .from(worklogDrafts)
      .where(and(eq(worklogDrafts.userId, userA), eq(worklogDrafts.status, "approved")))
      .limit(1);
    expect(approved).toBeDefined();

    const outcome = await syncDraft(userA, approved!, {
      resolveIssue: async () => null,
      createIssue: async () => {
        throw new Error("Tempo is down");
      },
      pushWorklog: async () => {
        throw new Error("Tempo is down");
      },
    });

    expect(outcome.status).toBe("failed");
    const after = await getUserDraft(userA, approved!.id);
    // Still approved, so the nightly retry picks it up — and the tag probe
    // makes that retry safe.
    expect(after!.status).toBe("approved");
    expect(after!.syncError).toContain("Tempo is down");
    expect(after!.syncAttemptedAt).not.toBeNull();
  });

  dbIt("a successful push marks the draft synced exactly once", async () => {
    const db = getDb();
    const [approved] = await db
      .select()
      .from(worklogDrafts)
      .where(and(eq(worklogDrafts.userId, userA), eq(worklogDrafts.status, "approved")))
      .limit(1);

    let pushes = 0;
    const adapter = {
      resolveIssue: async (key: string) => ({ key, id: 10_001, summary: null }),
      createIssue: async (key: string) => ({ key, id: 10_001, summary: null }),
      pushWorklog: async () => {
        pushes++;
        return { tempoWorklogId: "777", issueKey: "WEB-101", deduped: false };
      },
    };

    const first = await syncDraft(userA, approved!, adapter);
    expect(first.status).toBe("synced");

    const synced = await getUserDraft(userA, approved!.id);
    expect(synced!.status).toBe("synced");
    expect(synced!.tempoWorklogId).toBe("777");
    expect(synced!.syncError).toBeNull();

    // Re-running the worker must not push again.
    const second = await syncDraft(userA, synced!, adapter);
    expect(second.status).toBe("skipped");
    expect(pushes).toBe(1);
  });
});
