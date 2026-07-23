import { extractIssueKey, type IngestEvent } from "@devpulse/shared";
import type { NewEventRow } from "@/db/schema";

/**
 * Pure ingestion helpers, kept separate from the route handler so they can be
 * unit-tested without a database or HTTP layer.
 */

/** Pull the token out of an `Authorization: Bearer <token>` header. */
export function parseBearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

/**
 * De-duplicate events by `event_uuid` within a single batch, keeping the first
 * occurrence. Intra-batch duplicates are reported as skipped, matching the
 * cross-request idempotency behaviour (spec §4.1).
 */
export function dedupeEvents(events: IngestEvent[]): {
  unique: IngestEvent[];
  duplicateUuids: string[];
} {
  const seen = new Set<string>();
  const unique: IngestEvent[] = [];
  const duplicateUuids: string[] = [];

  for (const event of events) {
    if (seen.has(event.event_uuid)) {
      duplicateUuids.push(event.event_uuid);
      continue;
    }
    seen.add(event.event_uuid);
    unique.push(event);
  }

  return { unique, duplicateUuids };
}

/**
 * Map a validated event onto a DB row for a given user. The server owns the
 * user attribution (agent tokens are write-only for their own user, spec §4).
 * Derives the issue key from an explicit value, else from the branch name.
 */
export function toEventRow(userId: string, event: IngestEvent): NewEventRow {
  const issueKey =
    event.issue_key ?? extractIssueKey(event.branch, null) ?? null;

  return {
    eventUuid: event.event_uuid,
    userId,
    source: event.source,
    type: event.type,
    repo: event.repo ?? null,
    branch: event.branch ?? null,
    issueKey,
    ts: new Date(event.ts),
    metadata: event.metadata ?? {},
  };
}

/**
 * Minimal per-token fixed-window rate limiter. In-memory (single instance) —
 * it exists to catch runaway loops, not to meter devs (spec §4.1). Swap for a
 * shared store if the dashboard is ever scaled horizontally.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Returns whether the request is allowed, plus seconds until reset. */
  check(key: string, now: number): { allowed: boolean; retryAfter: number } {
    const entry = this.hits.get(key);
    if (!entry || now >= entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfter: 0 };
    }
    entry.count += 1;
    if (entry.count > this.limit) {
      return {
        allowed: false,
        retryAfter: Math.ceil((entry.resetAt - now) / 1000),
      };
    }
    return { allowed: true, retryAfter: 0 };
  }
}
