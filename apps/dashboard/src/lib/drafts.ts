import { and, asc, desc, eq, gte, inArray, lte, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { worklogDrafts, type WorklogDraftRow } from "@/db/schema";
import { recordAudit } from "@/lib/queries";

/**
 * Worklog-draft data access (brief §6D).
 *
 * **Own-data is enforced here, not in the UI** (spec §2.6). Every read filters
 * by `user_id`, and every mutation matches on `id AND user_id` — so a user who
 * guesses another user's draft id changes zero rows rather than someone else's
 * timesheet. The acceptance check ("User A cannot read or approve user B's
 * draft") is a property of these queries.
 */

export type DraftStatus = "draft" | "approved" | "synced" | "dismissed";

export interface DraftFilter {
  /** Inclusive local-date bounds, `YYYY-MM-DD`. */
  from?: string;
  to?: string;
  statuses?: DraftStatus[];
}

export async function getUserDrafts(
  userId: string,
  filter: DraftFilter = {},
): Promise<WorklogDraftRow[]> {
  const db = getDb();
  const conditions = [eq(worklogDrafts.userId, userId)];
  if (filter.from) conditions.push(gte(worklogDrafts.date, filter.from));
  if (filter.to) conditions.push(lte(worklogDrafts.date, filter.to));
  if (filter.statuses?.length) {
    conditions.push(inArray(worklogDrafts.status, filter.statuses));
  }
  return db
    .select()
    .from(worklogDrafts)
    .where(and(...conditions))
    .orderBy(desc(worklogDrafts.date), asc(worklogDrafts.issueKey));
}

/** Read one draft, scoped to its owner. Returns null for anyone else's. */
export async function getUserDraft(
  userId: string,
  draftId: string,
): Promise<WorklogDraftRow | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(worklogDrafts)
    .where(and(eq(worklogDrafts.id, draftId), eq(worklogDrafts.userId, userId)))
    .limit(1);
  return row ?? null;
}

export interface MutationResult {
  ok: boolean;
  message: string;
}

/**
 * Edit a draft's seconds / description. Only an un-actioned `draft` is editable
 * — once approved or synced the numbers must match what went to Tempo.
 */
export async function updateDraft(
  userId: string,
  draftId: string,
  changes: { seconds?: number; description?: string },
): Promise<MutationResult> {
  if (changes.seconds !== undefined) {
    if (!Number.isFinite(changes.seconds) || changes.seconds <= 0) {
      // Tempo rejects timeSpentSeconds < 1; catch it here with a real message.
      return { ok: false, message: "Time must be greater than zero." };
    }
    if (changes.seconds > 24 * 3600) {
      return { ok: false, message: "A single day's worklog can't exceed 24 hours." };
    }
  }

  const db = getDb();
  const rows = await db
    .update(worklogDrafts)
    .set({
      ...(changes.seconds !== undefined ? { seconds: Math.round(changes.seconds) } : {}),
      ...(changes.description !== undefined
        ? { description: changes.description.slice(0, 500) }
        : {}),
      // Pins the row against the nightly rollup, which would otherwise re-derive
      // these numbers from sessions and silently undo the edit.
      edited: true,
    })
    .where(
      and(
        eq(worklogDrafts.id, draftId),
        eq(worklogDrafts.userId, userId),
        eq(worklogDrafts.status, "draft"),
      ),
    )
    .returning({ id: worklogDrafts.id });

  return rows.length > 0
    ? { ok: true, message: "Draft updated" }
    : { ok: false, message: "That draft can't be edited (already actioned, or not yours)." };
}

/**
 * Approve a draft — the human gate before anything reaches Tempo (spec §2.5).
 * Returns the row so the caller can immediately attempt a push.
 */
export async function approveDraft(
  userId: string,
  draftId: string,
): Promise<{ ok: boolean; message: string; draft?: WorklogDraftRow }> {
  const db = getDb();
  const [row] = await db
    .update(worklogDrafts)
    .set({ status: "approved", approvedAt: new Date(), syncError: null })
    .where(
      and(
        eq(worklogDrafts.id, draftId),
        eq(worklogDrafts.userId, userId),
        eq(worklogDrafts.status, "draft"),
      ),
    )
    .returning();

  if (!row) {
    return {
      ok: false,
      message: "That draft can't be approved (already actioned, or not yours).",
    };
  }
  await recordAudit(userId, "draft.approve", row.id, {
    issueKey: row.issueKey,
    date: row.date,
    seconds: row.seconds,
  });
  return { ok: true, message: `Approved ${row.issueKey}`, draft: row };
}

/** Approve every remaining draft on one local date. */
export async function approveDay(
  userId: string,
  date: string,
): Promise<{ ok: boolean; message: string; drafts: WorklogDraftRow[] }> {
  const db = getDb();
  const rows = await db
    .update(worklogDrafts)
    .set({ status: "approved", approvedAt: new Date(), syncError: null })
    .where(
      and(
        eq(worklogDrafts.userId, userId),
        eq(worklogDrafts.date, date),
        eq(worklogDrafts.status, "draft"),
      ),
    )
    .returning();

  for (const row of rows) {
    await recordAudit(userId, "draft.approve", row.id, {
      issueKey: row.issueKey,
      date: row.date,
      seconds: row.seconds,
      via: "approve-all",
    });
  }
  return {
    ok: rows.length > 0,
    message: rows.length
      ? `Approved ${rows.length} draft${rows.length === 1 ? "" : "s"} for ${date}`
      : `Nothing left to approve on ${date}`,
    drafts: rows,
  };
}

/**
 * Dismiss a draft. A dismissed draft must never sync (brief §8), and the
 * nightly rollup won't resurrect it — `canRollupOverwrite` excludes the status.
 */
export async function dismissDraft(
  userId: string,
  draftId: string,
): Promise<MutationResult> {
  const db = getDb();
  const [row] = await db
    .update(worklogDrafts)
    .set({ status: "dismissed" })
    .where(
      and(
        eq(worklogDrafts.id, draftId),
        eq(worklogDrafts.userId, userId),
        // Anything but an already-synced row may be dismissed; un-syncing would
        // leave a live Tempo worklog with no record on our side.
        ne(worklogDrafts.status, "synced"),
      ),
    )
    .returning();

  if (!row) {
    return {
      ok: false,
      message: "That draft can't be dismissed (already synced, or not yours).",
    };
  }
  await recordAudit(userId, "draft.dismiss", row.id, {
    issueKey: row.issueKey,
    date: row.date,
  });
  return { ok: true, message: `Dismissed ${row.issueKey}` };
}

/** Put a dismissed draft back in play. */
export async function restoreDraft(
  userId: string,
  draftId: string,
): Promise<MutationResult> {
  const db = getDb();
  const rows = await db
    .update(worklogDrafts)
    .set({ status: "draft", approvedAt: null })
    .where(
      and(
        eq(worklogDrafts.id, draftId),
        eq(worklogDrafts.userId, userId),
        eq(worklogDrafts.status, "dismissed"),
      ),
    )
    .returning({ id: worklogDrafts.id });
  return rows.length > 0
    ? { ok: true, message: "Draft restored" }
    : { ok: false, message: "That draft isn't dismissed." };
}

/** Approved-but-not-yet-synced drafts — the sync worker's queue. */
export async function getPendingSyncDrafts(
  userId?: string,
  limit = 100,
): Promise<WorklogDraftRow[]> {
  const db = getDb();
  const conditions = [eq(worklogDrafts.status, "approved")];
  if (userId) conditions.push(eq(worklogDrafts.userId, userId));
  return db
    .select()
    .from(worklogDrafts)
    .where(and(...conditions))
    .orderBy(asc(worklogDrafts.date))
    .limit(limit);
}
