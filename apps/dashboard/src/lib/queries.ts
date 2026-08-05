import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { generateAgentToken, hashAgentToken } from "@mnl-dev-telemetry/shared";
import { getDb } from "@/db";
import {
  agentTokens,
  auditLog,
  taskEstimates,
  taskSessions,
  users,
  type AgentTokenRow,
  type TaskSessionRow,
  type UserRow,
} from "@/db/schema";
import type { Range } from "./range";

/**
 * Data-access layer. Individual views ALWAYS filter by `userId` here — own-data
 * enforcement lives in the query, not just the UI (spec §2.6 / §4.5). The
 * team-aggregate reads deliberately span all users and are only ever called
 * from lead-gated pages.
 */

// --- Individual (own-data) ------------------------------------------------

export async function getUserSessions(
  userId: string,
  range: Range,
): Promise<TaskSessionRow[]> {
  const db = getDb();
  return db
    .select()
    .from(taskSessions)
    .where(
      and(
        eq(taskSessions.userId, userId),
        gte(taskSessions.startedAt, range.from),
        lte(taskSessions.startedAt, range.to),
      ),
    )
    .orderBy(desc(taskSessions.startedAt));
}

/**
 * Estimates for a set of tickets, keyed by issue key. Estimates are ticket-level
 * (not per-user), so no user filter — they're the same number for everyone.
 */
export async function getEstimatesForIssueKeys(
  issueKeys: string[],
): Promise<Map<string, { estimateSeconds: number; source: "manual" | "jira" }>> {
  if (issueKeys.length === 0) return new Map();
  const db = getDb();
  const rows = await db
    .select({
      issueKey: taskEstimates.issueKey,
      estimateSeconds: taskEstimates.estimateSeconds,
      source: taskEstimates.source,
    })
    .from(taskEstimates)
    .where(inArray(taskEstimates.issueKey, issueKeys));

  return new Map(
    rows.map((r) => [
      r.issueKey,
      { estimateSeconds: r.estimateSeconds, source: r.source },
    ]),
  );
}

/**
 * This user's reported time per ticket *before* `before` — the baseline the
 * timeline's cumulative progress bars build on, so the first bar of a week
 * accounts for time already burned earlier (lib/progress.ts).
 */
export async function getPriorSecondsByIssueKey(
  userId: string,
  issueKeys: string[],
  before: Date,
): Promise<Map<string, number>> {
  if (issueKeys.length === 0) return new Map();
  const db = getDb();
  const rows = await db
    .select({
      issueKey: taskSessions.issueKey,
      seconds: sql<number>`coalesce(sum(${taskSessions.reportedSeconds}), 0)`,
    })
    .from(taskSessions)
    .where(
      and(
        eq(taskSessions.userId, userId),
        inArray(taskSessions.issueKey, issueKeys),
        lt(taskSessions.startedAt, before),
      ),
    )
    .groupBy(taskSessions.issueKey);

  const out = new Map<string, number>();
  for (const r of rows) {
    if (r.issueKey) out.set(r.issueKey, Number(r.seconds));
  }
  return out;
}

export interface TaskDetail {
  issueKey: string;
  sessions: TaskSessionRow[];
  actualSeconds: number;
  rawSeconds: number;
  estimateSeconds: number | null;
  /** Where the estimate came from — null when the ticket has none at all. */
  estimateSource: "manual" | "jira" | null;
  aiAssisted: boolean;
  aiTools: string[];
}

/** All of *this user's* sessions on one ticket, plus the ticket estimate. */
export async function getTaskDetail(
  userId: string,
  issueKey: string,
): Promise<TaskDetail | null> {
  const db = getDb();
  const sessions = await db
    .select()
    .from(taskSessions)
    .where(
      and(eq(taskSessions.userId, userId), eq(taskSessions.issueKey, issueKey)),
    )
    .orderBy(asc(taskSessions.startedAt));

  if (sessions.length === 0) return null;

  const [estimate] = await db
    .select()
    .from(taskEstimates)
    .where(eq(taskEstimates.issueKey, issueKey))
    .limit(1);

  const actualSeconds = sessions.reduce((a, s) => a + s.reportedSeconds, 0);
  const rawSeconds = sessions.reduce(
    (a, s) => a + Math.round((s.endedAt.getTime() - s.startedAt.getTime()) / 1000),
    0,
  );
  const aiTools = [
    ...new Set(sessions.map((s) => s.aiTool).filter((t): t is string => !!t)),
  ];

  return {
    issueKey,
    sessions,
    actualSeconds,
    rawSeconds,
    estimateSeconds: estimate?.estimateSeconds ?? null,
    estimateSource: estimate?.source ?? null,
    aiAssisted: sessions.some((s) => s.aiAssisted),
    aiTools,
  };
}

/**
 * Save a hand-entered estimate. Always stamps `source: 'manual'` — a human
 * typing a number is an explicit override, and the next Jira pull-down will
 * only replace it if Jira actually has an estimate (see lib/estimates.ts).
 */
export async function upsertEstimate(
  issueKey: string,
  estimateSeconds: number,
  updatedBy: string,
): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db
    .insert(taskEstimates)
    .values({ issueKey, estimateSeconds, updatedBy, source: "manual" })
    .onConflictDoUpdate({
      target: taskEstimates.issueKey,
      set: {
        estimateSeconds,
        updatedBy,
        source: "manual",
        syncedAt: null,
        updatedAt: now,
      },
    });
}

// --- Audit ----------------------------------------------------------------

/**
 * Append an audit row (spec §5: token issue/revoke, draft approval, sync push).
 * Auditing is observability, not the operation — a failure here is logged and
 * swallowed so it can never roll back the action it was recording.
 */
export async function recordAudit(
  userId: string | null,
  action: string,
  target: string | null,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await getDb().insert(auditLog).values({ userId, action, target, metadata });
  } catch (err) {
    console.error(`audit: failed to record ${action}`, err);
  }
}

// --- Settings: user + tokens ----------------------------------------------

export async function getUser(userId: string): Promise<UserRow | null> {
  const db = getDb();
  const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return row ?? null;
}

export async function updateWorkingHours(
  userId: string,
  tz: string,
  workdayStart: string,
  workdayEnd: string,
): Promise<void> {
  const db = getDb();
  await db
    .update(users)
    .set({ tz, workdayStart, workdayEnd })
    .where(eq(users.id, userId));
}

export async function getUserTokens(userId: string): Promise<AgentTokenRow[]> {
  const db = getDb();
  return db
    .select()
    .from(agentTokens)
    .where(eq(agentTokens.userId, userId))
    .orderBy(desc(agentTokens.createdAt));
}

/** Issue a new agent token for the user; returns the one-time plaintext. */
export async function issueToken(
  userId: string,
  label: string,
): Promise<string> {
  const db = getDb();
  const token = generateAgentToken();
  const [row] = await db
    .insert(agentTokens)
    .values({ userId, tokenHash: hashAgentToken(token), label })
    .returning();
  await db.insert(auditLog).values({
    userId,
    action: "token.issue",
    target: row?.id ?? null,
    metadata: { label, via: "dashboard" },
  });
  return token;
}

/** Revoke a token — scoped to the owner so one user can't revoke another's. */
export async function revokeToken(
  userId: string,
  tokenId: string,
): Promise<void> {
  const db = getDb();
  const [row] = await db
    .update(agentTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(agentTokens.id, tokenId),
        eq(agentTokens.userId, userId),
        isNull(agentTokens.revokedAt),
      ),
    )
    .returning();
  if (row) {
    await db.insert(auditLog).values({
      userId,
      action: "token.revoke",
      target: tokenId,
      metadata: { label: row.label },
    });
  }
}

// --- Team aggregates (lead-only pages) ------------------------------------

export async function getAllSessions(range: Range): Promise<TaskSessionRow[]> {
  const db = getDb();
  return db
    .select()
    .from(taskSessions)
    .where(
      and(
        gte(taskSessions.startedAt, range.from),
        lte(taskSessions.startedAt, range.to),
      ),
    )
    .orderBy(asc(taskSessions.startedAt));
}

export async function getAllEstimates(): Promise<
  { issueKey: string; estimateSeconds: number }[]
> {
  const db = getDb();
  return db
    .select({
      issueKey: taskEstimates.issueKey,
      estimateSeconds: taskEstimates.estimateSeconds,
    })
    .from(taskEstimates);
}

export async function getTeamHeadcount(): Promise<{
  devs: number;
  leads: number;
}> {
  const db = getDb();
  const [row] = await db
    .select({
      devs: sql<number>`count(*) filter (where ${users.role} = 'dev')`,
      leads: sql<number>`count(*) filter (where ${users.role} = 'lead')`,
    })
    .from(users);
  return { devs: Number(row?.devs ?? 0), leads: Number(row?.leads ?? 0) };
}
