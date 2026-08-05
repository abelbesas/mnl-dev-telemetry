import type { TempoWorklog } from "@mnl-dev-telemetry/shared";
import { JiraApiError, type JiraClient } from "./client";
import type { TempoClient } from "./tempo";
import { buildWorklogDescription, hasSyncTag } from "@/lib/sync-tag";

/**
 * The outbound sync adapter interface (spec §4.6). One implementation ships now
 * — Jira Cloud + Tempo v4 — but client-Jira adapters (Phase 7) slot in behind
 * the same three operations without touching the sync worker.
 */

export interface ResolvedIssue {
  key: string;
  /** Numeric Jira issue id. Tempo needs this, not the key. */
  id: number;
  summary: string | null;
}

export interface WorklogPushInput {
  draftId: string;
  issueKey: string;
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  seconds: number;
  description: string | null;
}

export interface WorklogPushResult {
  tempoWorklogId: string;
  /** The issue actually logged against — a mirror key when one was used. */
  issueKey: string;
  /** True when an existing tagged worklog was found instead of created. */
  deduped: boolean;
}

export interface SyncAdapter {
  /** Resolve an issue key to its numeric id. Null when not on this instance. */
  resolveIssue(key: string): Promise<ResolvedIssue | null>;
  /** Find-or-create a mirror ticket for an unresolvable external key. */
  createIssue(externalKey: string): Promise<ResolvedIssue>;
  pushWorklog(input: WorklogPushInput): Promise<WorklogPushResult>;
}

/** A sync failure with enough context for the Drafts row to explain itself. */
export class SyncError extends Error {
  readonly needsReconnect: boolean;
  /** False for permanent failures (bad project, no permission) — don't retry. */
  readonly retryable: boolean;

  constructor(
    message: string,
    opts: { needsReconnect?: boolean; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "SyncError";
    this.needsReconnect = opts.needsReconnect ?? false;
    this.retryable = opts.retryable ?? true;
  }
}

/** Label applied to every mirror ticket we create (spec §4.6). */
export const MIRROR_LABEL = "mnl-dev-telemetry-mirror";

/** Hooks the adapter uses to find/record mirrors, injected so it stays testable. */
export interface MirrorStore {
  find(externalKey: string): Promise<{ key: string; id: number | null } | null>;
  save(externalKey: string, internalKey: string, internalId: number): Promise<void>;
}

export interface MirrorConfig {
  /** Client used to create mirrors — the service account when configured. */
  client: JiraClient;
  projectKey: string;
  issueType: string;
}

export interface JiraTempoAdapterOptions {
  jira: JiraClient;
  tempo: TempoClient;
  /** Jira accountId of the dev — Tempo's worklog author. */
  authorAccountId: string;
  /** Absent when no service account is configured; mirroring is then disabled. */
  mirror?: MirrorConfig & { store: MirrorStore };
}

/**
 * Jira Cloud + Tempo v4 adapter.
 *
 * Push flow, and why each step exists:
 *   1. resolve key → numeric issueId  (Tempo v4 takes `issueId`, not `issueKey`)
 *   2. unresolvable? → find-or-create a mirror ticket in our Jira
 *   3. search Tempo for an existing worklog carrying this draft's tag
 *   4. only then create — so a retry after a timeout never double-logs
 */
export class JiraTempoAdapter implements SyncAdapter {
  private readonly jira: JiraClient;
  private readonly tempo: TempoClient;
  private readonly authorAccountId: string;
  private readonly mirror?: MirrorConfig & { store: MirrorStore };

  constructor(opts: JiraTempoAdapterOptions) {
    this.jira = opts.jira;
    this.tempo = opts.tempo;
    this.authorAccountId = opts.authorAccountId;
    this.mirror = opts.mirror;
  }

  async resolveIssue(key: string): Promise<ResolvedIssue | null> {
    try {
      const issue = await this.jira.getIssue(key);
      const id = Number(issue.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw new SyncError(`Jira returned a non-numeric id for ${key}`, {
          retryable: false,
        });
      }
      return { key: issue.key, id, summary: issue.fields?.summary ?? null };
    } catch (err) {
      // 404 is the documented "this key isn't on this site" signal — the cue to
      // mirror, not an error. Anything else is a real failure.
      if (err instanceof JiraApiError && err.notFound) return null;
      throw toSyncError(err, `resolving ${key}`);
    }
  }

  /**
   * Find-or-create the mirror ticket for a client key (spec §4.6).
   *
   * Three lookups, cheapest first: our own `mirror_links` table, then a JQL
   * search (so a lost DB row doesn't create a second mirror), then create.
   */
  async createIssue(externalKey: string): Promise<ResolvedIssue> {
    const mirror = this.mirror;
    if (!mirror) {
      throw new SyncError(
        `${externalKey} isn't in your connected Jira, and mirror tickets aren't configured on the server (JIRA_BASE_URL / MIRROR_PROJECT_KEY).`,
        { retryable: false },
      );
    }

    const known = await mirror.store.find(externalKey);
    if (known?.id) {
      return { key: known.key, id: known.id, summary: null };
    }
    if (known) {
      // Link exists but the numeric id was never cached — resolve it once.
      const resolved = await this.resolveMirror(mirror, known.key);
      if (resolved) {
        await mirror.store.save(externalKey, resolved.key, resolved.id);
        return resolved;
      }
    }

    const found = await this.searchMirror(mirror, externalKey);
    if (found) {
      await mirror.store.save(externalKey, found.key, found.id);
      return found;
    }

    let created: { key: string; id: number };
    try {
      const issue = await mirror.client.createIssue({
        projectKey: mirror.projectKey,
        issueType: mirror.issueType,
        summary: `${externalKey} (mirror)`,
        // The external key lives in the description AND in mirror_links, so the
        // pairing survives a DB reset (that's what the JQL search reads).
        description: `Mirror of external ticket ${externalKey}. Time logged here by MnlDevTelemetry because ${externalKey} isn't reachable from the connected Jira.`,
        labels: [MIRROR_LABEL],
      });
      created = { key: issue.key, id: Number(issue.id) };
    } catch (err) {
      throw toSyncError(err, `creating a mirror ticket for ${externalKey}`);
    }

    if (!Number.isInteger(created.id) || created.id <= 0) {
      throw new SyncError(`Mirror ticket ${created.key} has no usable numeric id`, {
        retryable: false,
      });
    }
    await mirror.store.save(externalKey, created.key, created.id);
    return { key: created.key, id: created.id, summary: null };
  }

  private async resolveMirror(
    mirror: MirrorConfig,
    key: string,
  ): Promise<ResolvedIssue | null> {
    try {
      const issue = await mirror.client.getIssue(key);
      const id = Number(issue.id);
      return Number.isInteger(id) && id > 0
        ? { key: issue.key, id, summary: issue.fields?.summary ?? null }
        : null;
    } catch (err) {
      if (err instanceof JiraApiError && err.notFound) return null;
      throw toSyncError(err, `resolving mirror ${key}`);
    }
  }

  /** Look for an existing mirror by label + summary, before creating another. */
  private async searchMirror(
    mirror: MirrorConfig,
    externalKey: string,
  ): Promise<ResolvedIssue | null> {
    try {
      const jql = `project = "${mirror.projectKey}" AND labels = "${MIRROR_LABEL}" AND summary ~ "${externalKey}" ORDER BY created ASC`;
      const issues = await mirror.client.searchJql(jql, 5);
      for (const issue of issues) {
        const id = Number(issue.id);
        if (Number.isInteger(id) && id > 0) {
          return { key: issue.key, id, summary: issue.fields?.summary ?? null };
        }
      }
      return null;
    } catch (err) {
      // A search failure must not block the push — worst case we create a
      // second mirror, which is recoverable; failing to log time is not.
      console.error(`mirror search for ${externalKey} failed`, err);
      return null;
    }
  }

  async pushWorklog(input: WorklogPushInput): Promise<WorklogPushResult> {
    const resolved =
      (await this.resolveIssue(input.issueKey)) ??
      (await this.createIssue(input.issueKey));

    const description = buildWorklogDescription(input.description, input.draftId);

    // --- Idempotency probe (brief §6E) ------------------------------------
    // Tempo has no idempotency key, so before creating we look for a worklog
    // already carrying this draft's tag. This is what makes a retry after a
    // timeout safe.
    const existing = await this.findTagged(resolved.id, input.date, input.draftId);
    if (existing) {
      return {
        tempoWorklogId: String(existing.tempoWorklogId),
        issueKey: resolved.key,
        deduped: true,
      };
    }

    let worklog: TempoWorklog;
    try {
      worklog = await this.tempo.createWorklog({
        issueId: resolved.id,
        authorAccountId: this.authorAccountId,
        timeSpentSeconds: input.seconds,
        startDate: input.date,
        description,
      });
    } catch (err) {
      throw toSyncError(err, `logging time to ${resolved.key}`);
    }

    return {
      tempoWorklogId: String(worklog.tempoWorklogId),
      issueKey: resolved.key,
      deduped: false,
    };
  }

  /** Existing worklog on this issue/day/author carrying this draft's tag. */
  private async findTagged(
    issueId: number,
    date: string,
    draftId: string,
  ): Promise<TempoWorklog | null> {
    let worklogs: TempoWorklog[];
    try {
      worklogs = await this.tempo.searchWorklogs({
        issueIds: [issueId],
        from: date,
        to: date,
        authorIds: [this.authorAccountId],
      });
    } catch (err) {
      // If we cannot prove a worklog is absent, we must not create one — that
      // is exactly the double-log this probe exists to prevent.
      throw toSyncError(err, "checking Tempo for an existing worklog", {
        retryable: true,
      });
    }
    return worklogs.find((w) => hasSyncTag(w.description, draftId)) ?? null;
  }
}

/** Normalise a client error into a SyncError the UI can render verbatim. */
function toSyncError(
  err: unknown,
  context: string,
  overrides: { retryable?: boolean } = {},
): SyncError {
  if (err instanceof SyncError) return err;
  const status = (err as { status?: number } | undefined)?.status;
  const needsReconnect = Boolean(
    (err as { needsReconnect?: boolean } | undefined)?.needsReconnect,
  );
  // 4xx (other than 429) won't fix themselves; retrying just burns quota.
  const retryable =
    overrides.retryable ??
    (status === undefined || status === 429 || status === 0 || status >= 500);
  const detail = err instanceof Error ? err.message : String(err);
  return new SyncError(`Failed while ${context}: ${detail}`, {
    needsReconnect,
    retryable,
  });
}
