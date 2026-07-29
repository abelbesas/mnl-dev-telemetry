import { NextResponse } from "next/server";
import { eventBatchSchema, type IngestResponse } from "@mnl-dev-telemetry/shared";
import { getDb } from "@/db";
import { events } from "@/db/schema";
import { authenticateAgentToken } from "@/lib/auth-token";
import {
  dedupeEvents,
  parseBearerToken,
  RateLimiter,
  toEventRow,
} from "@/lib/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Generous per-token window — catches runaway loops, not real devs (spec §4.1).
const limiter = new RateLimiter(300, 60_000);

/** POST /api/ingest/events — batched, token-authed, idempotent (spec §4.1). */
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

  const parsed = eventBatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { unique, duplicateUuids } = dedupeEvents(parsed.data.events);
  const rows = unique.map((event) => toEventRow(tokenRow.userId, event));

  const db = getDb();
  // ON CONFLICT DO NOTHING against the event_uuid unique index makes retries
  // safe; `returning` tells us which rows were actually inserted.
  const inserted = await db
    .insert(events)
    .values(rows)
    .onConflictDoNothing({ target: events.eventUuid })
    .returning({ eventUuid: events.eventUuid });

  const insertedUuids = new Set(inserted.map((r) => r.eventUuid));
  const skippedUuids = [
    ...duplicateUuids,
    ...unique
      .map((e) => e.event_uuid)
      .filter((uuid) => !insertedUuids.has(uuid)),
  ];

  const responseBody: IngestResponse = {
    inserted: insertedUuids.size,
    skipped: skippedUuids.length,
    skipped_uuids: skippedUuids,
  };

  return NextResponse.json(responseBody, { status: 200 });
}
