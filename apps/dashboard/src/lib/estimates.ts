import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { taskEstimates, type TaskEstimateRow } from "@/db/schema";
import { JiraClient, oauthTransport, originalEstimateSeconds } from "@/lib/jira/client";
import { getCredentials, NoConnectionError } from "@/lib/jira/connection";

/**
 * Estimate precedence + Jira pull-down (Phase-5 brief §6B).
 *
 * Jira-sourced estimates land in the SAME `task_estimates` table as manual ones
 * (brief §3) so Task detail keeps one code path; `source` records which is which.
 */

export type EstimateSource = "manual" | "jira";

export interface CurrentEstimate {
  estimateSeconds: number;
  source: EstimateSource;
}

export type EstimateDecision =
  | { action: "upsert"; estimateSeconds: number; source: "jira"; reason: string }
  | { action: "keep"; reason: string };

/**
 * Decide what a Jira fetch should do to the stored estimate. Pure, so the two
 * rules that matter are directly testable:
 *
 *  1. A real Jira estimate wins over a manual one (it is the source of truth).
 *  2. Jira having NO estimate must never wipe a manual value — very common,
 *     because teams that estimate in story points leave `originalEstimate`
 *     empty, and that is a per-instance custom field we deliberately don't read.
 */
export function resolveEstimate(
  current: CurrentEstimate | null,
  jiraEstimateSeconds: number | null,
): EstimateDecision {
  if (jiraEstimateSeconds == null || jiraEstimateSeconds <= 0) {
    return {
      action: "keep",
      reason: current
        ? `Jira has no original estimate; kept the existing ${current.source} value.`
        : "Jira has no original estimate.",
    };
  }
  if (
    current &&
    current.source === "jira" &&
    current.estimateSeconds === jiraEstimateSeconds
  ) {
    return { action: "keep", reason: "Already in sync with Jira." };
  }
  return {
    action: "upsert",
    estimateSeconds: jiraEstimateSeconds,
    source: "jira",
    reason: current
      ? `Jira estimate replaced the stored ${current.source} value.`
      : "Estimate pulled from Jira.",
  };
}

/**
 * True when a compression ratio is meaningful. Guards the brief's known gap:
 * dividing by a zero/absent estimate produced a nonsense `0.01×` before.
 */
export function canComputeRatio(estimateSeconds: number | null): boolean {
  return typeof estimateSeconds === "number" && estimateSeconds > 0;
}

export function compressionRatio(
  actualSeconds: number,
  estimateSeconds: number | null,
): number | null {
  return canComputeRatio(estimateSeconds)
    ? actualSeconds / (estimateSeconds as number)
    : null;
}

// --- DB + Jira ------------------------------------------------------------

export async function getEstimateRow(
  issueKey: string,
): Promise<TaskEstimateRow | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(taskEstimates)
    .where(eq(taskEstimates.issueKey, issueKey))
    .limit(1);
  return row ?? null;
}

/** Outcome of a pull-down, shaped for the UI rather than for throwing. */
export interface EstimateSyncResult {
  status: "updated" | "unchanged" | "no-estimate" | "unavailable";
  message: string;
  estimateSeconds: number | null;
  source: EstimateSource | null;
}

/**
 * Fetch one issue's original estimate and reconcile it with what's stored.
 *
 * **Never throws.** Task detail calls this on load, and a Jira outage must show
 * as a line of text on the page, not a 500 (brief §9).
 */
export async function syncEstimateFromJira(
  userId: string,
  issueKey: string,
): Promise<EstimateSyncResult> {
  const existing = await getEstimateRow(issueKey).catch(() => null);
  const current: CurrentEstimate | null = existing
    ? { estimateSeconds: existing.estimateSeconds, source: existing.source }
    : null;

  const unavailable = (message: string): EstimateSyncResult => ({
    status: "unavailable",
    message,
    estimateSeconds: current?.estimateSeconds ?? null,
    source: current?.source ?? null,
  });

  let jiraSeconds: number | null;
  try {
    const creds = await getCredentials(userId);
    const client = new JiraClient(
      oauthTransport(creds.accessToken, creds.cloudId, creds.siteUrl),
    );
    jiraSeconds = originalEstimateSeconds(await client.getIssue(issueKey));
  } catch (err) {
    if (err instanceof NoConnectionError) {
      return unavailable(
        err.needsReconnect
          ? `${err.message} Reconnect in Settings.`
          : "Connect Jira in Settings to pull estimates automatically.",
      );
    }
    console.error(`estimates: Jira fetch failed for ${issueKey}`, err);
    return unavailable(
      err instanceof Error
        ? `Couldn't reach Jira for ${issueKey}: ${err.message}`
        : `Couldn't reach Jira for ${issueKey}.`,
    );
  }

  const decision = resolveEstimate(current, jiraSeconds);
  if (decision.action === "keep") {
    return {
      status: jiraSeconds == null ? "no-estimate" : "unchanged",
      message: decision.reason,
      estimateSeconds: current?.estimateSeconds ?? null,
      source: current?.source ?? null,
    };
  }

  await upsertJiraEstimate(issueKey, decision.estimateSeconds);
  return {
    status: "updated",
    message: decision.reason,
    estimateSeconds: decision.estimateSeconds,
    source: "jira",
  };
}

async function upsertJiraEstimate(
  issueKey: string,
  estimateSeconds: number,
): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db
    .insert(taskEstimates)
    .values({
      issueKey,
      estimateSeconds,
      source: "jira",
      syncedAt: now,
      updatedAt: now,
      // A Jira-sourced row has no human author; leave `updated_by` null.
      updatedBy: null,
    })
    .onConflictDoUpdate({
      target: taskEstimates.issueKey,
      set: {
        estimateSeconds,
        source: "jira",
        syncedAt: now,
        updatedAt: now,
        updatedBy: null,
      },
    });
}

/**
 * Batch pull-down for a set of tickets (brief §6B "and a small batch job").
 * Runs from the nightly cron; per-issue failures are collected, never thrown,
 * so one unresolvable ticket doesn't abort the run.
 */
export async function syncEstimatesForIssues(
  userId: string,
  issueKeys: string[],
): Promise<{ updated: number; skipped: number; failed: number }> {
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  for (const key of [...new Set(issueKeys)]) {
    const result = await syncEstimateFromJira(userId, key);
    if (result.status === "updated") updated++;
    else if (result.status === "unavailable") failed++;
    else skipped++;
  }
  return { updated, skipped, failed };
}
