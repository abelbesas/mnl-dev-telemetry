import { NextResponse } from "next/server";
import {
  heartbeatRequestSchema,
  type HeartbeatResponse,
} from "@devpulse/shared";
import { getDb } from "@/db";
import { events } from "@/db/schema";
import { authenticateAgentToken } from "@/lib/auth-token";
import { parseBearerToken, RateLimiter, toEventRow } from "@/lib/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Same generous per-token window as `/events`. A well-behaved editor sends ~12
 * heartbeats an hour, so this only ever catches a runaway loop (spec §4.1).
 */
const limiter = new RateLimiter(300, 60_000);

/**
 * `POST /api/ingest/heartbeat` — the "lightweight" endpoint spec §4.1 promised
 * and Phase 1 never built (Phase 6 §4a).
 *
 * A heartbeat is an ordinary append-only `events` row (`type: "heartbeat"`,
 * `source: "extension"`) with the issue key derived from the branch by the same
 * `toEventRow` every other event goes through — so the stitcher needs no
 * special-casing, and pings simply bracket a session at both ends instead of it
 * starting at the first commit and ending at the last.
 *
 * Deliberately NOT batched: one insert, one row. Idempotent on `event_uuid`
 * exactly like `/events`, so a retried ping can never double-count.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const token = parseBearerToken(req.headers.get("authorization"));
  if (!token) {
    return NextResponse.json(
      { error: "missing bearer token" },
      { status: 401 },
    );
  }

  const tokenRow = await authenticateAgentToken(token);
  if (!tokenRow) {
    return NextResponse.json(
      { error: "invalid or revoked token" },
      { status: 401 },
    );
  }

  const { allowed, retryAfter } = limiter.check(tokenRow.id, Date.now());
  if (!allowed) {
    return NextResponse.json(
      { error: "rate limit exceeded" },
      { status: 429, headers: { "retry-after": String(retryAfter) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = heartbeatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const db = getDb();
  const inserted = await db
    .insert(events)
    .values(toEventRow(tokenRow.userId, parsed.data))
    .onConflictDoNothing({ target: events.eventUuid })
    .returning({ eventUuid: events.eventUuid });

  const responseBody: HeartbeatResponse = {
    inserted: inserted.length > 0 ? 1 : 0,
    skipped: inserted.length > 0 ? 0 : 1,
  };

  return NextResponse.json(responseBody, { status: 200 });
}
