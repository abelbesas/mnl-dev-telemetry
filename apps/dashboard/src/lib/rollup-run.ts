import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { taskSessions, users, worklogDrafts } from "@/db/schema";
import {
  canRollupOverwrite,
  draftMatches,
  rollupSessions,
  type RollupSession,
} from "./rollup";

/**
 * DB runner for the nightly draft rollup (spec §4.2 step 5, brief §6C).
 *
 * Idempotent by construction: the pure rollup decides what *should* exist, and
 * this reconciles it against `worklog_drafts` — insert when missing, update only
 * untouched `draft` rows, and never touch one the dev has already approved,
 * synced, or dismissed. Re-running changes nothing.
 */

export interface RollupRunResult {
  users: number;
  created: number;
  updated: number;
  /** Rows left alone because the dev already acted on them. */
  preserved: number;
  unchanged: number;
}

export async function runRollup(
  opts: { userId?: string } = {},
): Promise<RollupRunResult> {
  const db = getDb();
  const userRows = opts.userId
    ? await db.select().from(users).where(eq(users.id, opts.userId))
    : await db.select().from(users);

  const result: RollupRunResult = {
    users: userRows.length,
    created: 0,
    updated: 0,
    preserved: 0,
    unchanged: 0,
  };

  for (const user of userRows) {
    const sessionRows = await db
      .select({
        id: taskSessions.id,
        issueKey: taskSessions.issueKey,
        startedAt: taskSessions.startedAt,
        reportedSeconds: taskSessions.reportedSeconds,
        aiAssisted: taskSessions.aiAssisted,
        aiTool: taskSessions.aiTool,
      })
      .from(taskSessions)
      .where(eq(taskSessions.userId, user.id));

    const candidates = rollupSessions(sessionRows as RollupSession[], user.tz);
    if (candidates.length === 0) continue;

    const existing = await db
      .select()
      .from(worklogDrafts)
      .where(eq(worklogDrafts.userId, user.id));
    const byKey = new Map(
      existing.map((row) => [`${row.issueKey} ${row.date}`, row]),
    );

    for (const candidate of candidates) {
      const stored = byKey.get(`${candidate.issueKey} ${candidate.date}`);

      if (!stored) {
        await db.insert(worklogDrafts).values({
          userId: user.id,
          issueKey: candidate.issueKey,
          date: candidate.date,
          seconds: candidate.seconds,
          description: candidate.description,
          sessionIds: candidate.sessionIds,
          status: "draft",
        });
        result.created++;
        continue;
      }

      // The dev already acted on this one, or hand-edited it — either way
      // their version wins over a re-derivation.
      if (!canRollupOverwrite(stored.status, stored.edited)) {
        result.preserved++;
        continue;
      }

      if (draftMatches(stored, candidate)) {
        result.unchanged++;
        continue;
      }

      await db
        .update(worklogDrafts)
        .set({
          seconds: candidate.seconds,
          sessionIds: candidate.sessionIds,
          description: candidate.description,
        })
        .where(
          and(
            eq(worklogDrafts.id, stored.id),
            // Re-assert ownership, status and the edited flag in the WHERE so a
            // concurrent approval or edit can't be clobbered between the read
            // and the write.
            eq(worklogDrafts.userId, user.id),
            eq(worklogDrafts.status, "draft"),
            eq(worklogDrafts.edited, false),
          ),
        );
      result.updated++;
    }
  }

  return result;
}
