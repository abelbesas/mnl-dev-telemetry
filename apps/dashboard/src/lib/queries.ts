import { and, asc, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
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

export interface TaskDetail {
  issueKey: string;
  sessions: TaskSessionRow[];
  actualSeconds: number;
  rawSeconds: number;
  estimateSeconds: number | null;
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
    aiAssisted: sessions.some((s) => s.aiAssisted),
    aiTools,
  };
}

export async function upsertEstimate(
  issueKey: string,
  estimateSeconds: number,
  updatedBy: string,
): Promise<void> {
  const db = getDb();
  await db
    .insert(taskEstimates)
    .values({ issueKey, estimateSeconds, updatedBy })
    .onConflictDoUpdate({
      target: taskEstimates.issueKey,
      set: { estimateSeconds, updatedBy, updatedAt: new Date() },
    });
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
