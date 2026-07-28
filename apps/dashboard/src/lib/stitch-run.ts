import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  events,
  taskSessions,
  users,
  type NewTaskSessionRow,
} from "@/db/schema";
import { stitchUserEvents, type StitchEvent, type WorkingHours } from "./stitch";

/**
 * Server-side stitching job (spec §4.2). Loads each user's events + working-hours
 * settings, runs the pure stitcher, and replaces that user's `task_sessions` in
 * one transaction. Fully re-runnable from scratch: every run rebuilds sessions
 * from the append-only event log and stamps a fresh `stitch_version`, so a
 * re-run produces identical sessions (deterministic) — corrections happen here,
 * never by mutating events (spec §4.1).
 */

export interface StitchRunResult {
  stitchVersion: number;
  users: number;
  sessions: number;
}

function metadataString(
  metadata: unknown,
  key: string,
): string | null {
  if (metadata && typeof metadata === "object" && key in metadata) {
    const value = (metadata as Record<string, unknown>)[key];
    return typeof value === "string" ? value : null;
  }
  return null;
}

export async function runStitch(
  opts: { userId?: string } = {},
): Promise<StitchRunResult> {
  const db = getDb();

  // Monotonic version stamp shared by every session this run writes.
  const [versionRow] = await db
    .select({
      max: sql<number>`coalesce(max(${taskSessions.stitchVersion}), 0)`,
    })
    .from(taskSessions);
  const stitchVersion = (versionRow?.max ?? 0) + 1;

  const userRows = opts.userId
    ? await db.select().from(users).where(eq(users.id, opts.userId))
    : await db.select().from(users);

  let sessionCount = 0;

  for (const user of userRows) {
    const rows = await db
      .select({
        id: events.id,
        type: events.type,
        source: events.source,
        issueKey: events.issueKey,
        repo: events.repo,
        branch: events.branch,
        ts: events.ts,
        metadata: events.metadata,
      })
      .from(events)
      .where(eq(events.userId, user.id))
      .orderBy(events.ts);

    const stitchEvents: StitchEvent[] = rows.map((r) => ({
      id: r.id,
      type: r.type,
      source: r.source,
      issueKey: r.issueKey,
      repo: r.repo,
      branch: r.branch,
      ts: r.ts,
      aiCoAuthor: metadataString(r.metadata, "ai_co_author"),
      toolName: metadataString(r.metadata, "tool"),
    }));

    const settings: WorkingHours = {
      tz: user.tz,
      workdayStart: user.workdayStart,
      workdayEnd: user.workdayEnd,
    };
    const sessions = stitchUserEvents(stitchEvents, settings);

    const newRows: NewTaskSessionRow[] = sessions.map((s) => ({
      userId: user.id,
      issueKey: s.issueKey,
      repo: s.repo,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      reportedSeconds: s.reportedSeconds,
      aiAssisted: s.aiAssisted,
      aiTool: s.aiTool,
      eventCount: s.eventCount,
      stitchVersion,
    }));

    await db.transaction(async (tx) => {
      await tx.delete(taskSessions).where(eq(taskSessions.userId, user.id));
      if (newRows.length > 0) await tx.insert(taskSessions).values(newRows);
    });

    sessionCount += newRows.length;
  }

  return { stitchVersion, users: userRows.length, sessions: sessionCount };
}
