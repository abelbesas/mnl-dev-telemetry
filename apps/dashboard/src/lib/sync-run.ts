import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { mirrorLinks, worklogDrafts, type WorklogDraftRow } from "@/db/schema";
import { getPendingSyncDrafts } from "@/lib/drafts";
import {
  JiraTempoAdapter,
  SyncError,
  type MirrorStore,
  type SyncAdapter,
} from "@/lib/jira/adapter";
import { basicAuthTransport, JiraClient, oauthTransport } from "@/lib/jira/client";
import {
  getCredentials,
  getServiceAccount,
  NoConnectionError,
} from "@/lib/jira/connection";
import { TempoClient } from "@/lib/jira/tempo";
import { recordAudit } from "@/lib/queries";

/**
 * The sync worker (spec §4.6, brief §6E).
 *
 * Contract with the rest of the app: **this never throws for an outbound
 * failure.** Every Jira/Tempo problem is recorded on the draft as `sync_error`
 * and surfaced on the Drafts row, so an Atlassian outage degrades one row rather
 * than 500-ing a page (brief §9).
 */

export interface SyncOutcome {
  draftId: string;
  issueKey: string;
  status: "synced" | "skipped" | "failed";
  message: string;
  tempoWorklogId?: string;
  /** True when an already-tagged Tempo worklog was found instead of created. */
  deduped?: boolean;
}

export interface SyncRunResult {
  synced: number;
  failed: number;
  skipped: number;
  outcomes: SyncOutcome[];
}

/** Mirror-link persistence, injected into the adapter. */
function mirrorStore(connectionId: string | null): MirrorStore {
  return {
    async find(externalKey) {
      const db = getDb();
      const [row] = await db
        .select()
        .from(mirrorLinks)
        .where(eq(mirrorLinks.externalIssueKey, externalKey))
        .limit(1);
      if (!row) return null;
      const id = row.internalIssueId ? Number(row.internalIssueId) : null;
      return {
        key: row.internalIssueKey,
        id: Number.isInteger(id) && (id as number) > 0 ? id : null,
      };
    },
    async save(externalKey, internalKey, internalId) {
      const db = getDb();
      await db
        .insert(mirrorLinks)
        .values({
          externalIssueKey: externalKey,
          internalIssueKey: internalKey,
          internalIssueId: String(internalId),
          jiraConnectionId: connectionId,
        })
        .onConflictDoUpdate({
          target: mirrorLinks.externalIssueKey,
          set: {
            internalIssueKey: internalKey,
            internalIssueId: String(internalId),
          },
        });
    },
  };
}

/**
 * Build the adapter for one user. Throws `NoConnectionError` when the user
 * simply isn't set up — the caller turns that into a per-draft message.
 */
export async function buildAdapter(userId: string): Promise<SyncAdapter> {
  const creds = await getCredentials(userId);
  if (!creds.tempoApiToken) {
    throw new NoConnectionError(
      "No Tempo token saved. Add one in Settings — Tempo auth is separate from Jira.",
    );
  }

  const jira = new JiraClient(
    oauthTransport(creds.accessToken, creds.cloudId, creds.siteUrl),
  );
  const tempo = new TempoClient(creds.tempoApiToken);

  // Mirror tickets are created with the org service account when configured —
  // the one surviving use of the shared account (brief §2).
  const service = getServiceAccount();
  const mirror = service
    ? {
        client: new JiraClient(
          basicAuthTransport(service.baseUrl, service.email, service.apiToken),
        ),
        projectKey: service.projectKey,
        issueType: service.issueType,
        store: mirrorStore(creds.connectionId),
      }
    : undefined;

  return new JiraTempoAdapter({
    jira,
    tempo,
    authorAccountId: creds.accountId,
    mirror,
  });
}

/**
 * Push one approved draft. Never throws.
 *
 * Guard rails, in order: only `approved` rows sync (so a dismissed draft never
 * does — brief §8), an already-`synced` row is a no-op, and the adapter's tag
 * probe makes a repeat run a dedupe rather than a second worklog.
 */
export async function syncDraft(
  userId: string,
  draft: WorklogDraftRow,
  adapter?: SyncAdapter,
): Promise<SyncOutcome> {
  const base = { draftId: draft.id, issueKey: draft.issueKey };

  if (draft.status === "synced") {
    return { ...base, status: "skipped", message: "Already synced." };
  }
  if (draft.status !== "approved") {
    // Belt and braces: the queue only selects `approved`, but a dismissed or
    // still-draft row must never reach Tempo even if called directly.
    return {
      ...base,
      status: "skipped",
      message: `Not approved (status: ${draft.status}).`,
    };
  }

  let resolvedAdapter: SyncAdapter;
  try {
    resolvedAdapter = adapter ?? (await buildAdapter(userId));
  } catch (err) {
    const message =
      err instanceof NoConnectionError || err instanceof Error
        ? err.message
        : "Jira/Tempo is not configured.";
    await recordFailure(userId, draft.id, message);
    return { ...base, status: "failed", message };
  }

  try {
    const result = await resolvedAdapter.pushWorklog({
      draftId: draft.id,
      issueKey: draft.issueKey,
      date: draft.date,
      seconds: draft.seconds,
      description: draft.description,
    });

    const db = getDb();
    await db
      .update(worklogDrafts)
      .set({
        status: "synced",
        syncedAt: new Date(),
        tempoWorklogId: result.tempoWorklogId,
        syncedIssueKey: result.issueKey,
        syncError: null,
        syncAttemptedAt: new Date(),
      })
      .where(and(eq(worklogDrafts.id, draft.id), eq(worklogDrafts.userId, userId)));

    await recordAudit(userId, "draft.sync", draft.id, {
      issueKey: draft.issueKey,
      loggedTo: result.issueKey,
      tempoWorklogId: result.tempoWorklogId,
      seconds: draft.seconds,
      deduped: result.deduped,
    });

    return {
      ...base,
      status: "synced",
      message: result.deduped
        ? `Already in Tempo — matched the existing worklog on ${result.issueKey}.`
        : result.issueKey === draft.issueKey
          ? `Logged ${formatHours(draft.seconds)} to ${result.issueKey}.`
          : `Logged ${formatHours(draft.seconds)} to mirror ticket ${result.issueKey}.`,
      tempoWorklogId: result.tempoWorklogId,
      deduped: result.deduped,
    };
  } catch (err) {
    const message =
      err instanceof SyncError || err instanceof Error
        ? err.message
        : "Sync failed for an unknown reason.";
    // The draft stays `approved`, so the next run retries it — safely, because
    // the tag probe will find any worklog that did land.
    await recordFailure(userId, draft.id, message);
    console.error(`sync: draft ${draft.id} failed`, message);
    return { ...base, status: "failed", message };
  }
}

async function recordFailure(
  userId: string,
  draftId: string,
  message: string,
): Promise<void> {
  try {
    const db = getDb();
    await db
      .update(worklogDrafts)
      .set({ syncError: message.slice(0, 500), syncAttemptedAt: new Date() })
      .where(and(eq(worklogDrafts.id, draftId), eq(worklogDrafts.userId, userId)));
  } catch (err) {
    console.error("sync: could not record failure on draft", err);
  }
}

/**
 * Drain the approved-draft queue. Used by the nightly cron (to retry anything
 * that failed) and after a manual approve.
 */
export async function runSync(
  opts: { userId?: string; limit?: number } = {},
): Promise<SyncRunResult> {
  const drafts = await getPendingSyncDrafts(opts.userId, opts.limit ?? 100);
  const result: SyncRunResult = { synced: 0, failed: 0, skipped: 0, outcomes: [] };

  // Group by user so one adapter (and one token refresh) serves all their
  // drafts, and one user's broken connection can't stall everyone else's.
  const byUser = new Map<string, WorklogDraftRow[]>();
  for (const draft of drafts) {
    const list = byUser.get(draft.userId) ?? [];
    list.push(draft);
    byUser.set(draft.userId, list);
  }

  for (const [userId, userDrafts] of byUser) {
    let adapter: SyncAdapter | undefined;
    let setupError: string | null = null;
    try {
      adapter = await buildAdapter(userId);
    } catch (err) {
      setupError = err instanceof Error ? err.message : "Jira/Tempo is not configured.";
    }

    for (const draft of userDrafts) {
      if (setupError) {
        await recordFailure(userId, draft.id, setupError);
        result.failed++;
        result.outcomes.push({
          draftId: draft.id,
          issueKey: draft.issueKey,
          status: "failed",
          message: setupError,
        });
        continue;
      }
      const outcome = await syncDraft(userId, draft, adapter);
      result.outcomes.push(outcome);
      if (outcome.status === "synced") result.synced++;
      else if (outcome.status === "failed") result.failed++;
      else result.skipped++;
    }
  }

  return result;
}

function formatHours(seconds: number): string {
  const hours = Math.round((seconds / 3600) * 10) / 10;
  return `${hours}h`;
}
