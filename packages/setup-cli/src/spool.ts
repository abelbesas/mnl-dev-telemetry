import fs from "node:fs";
import path from "node:path";
import { MAX_EVENTS_PER_BATCH, type IngestEvent } from "@mnl-dev-telemetry/shared";

/**
 * Offline spool + retry (spec §4.3, item 2). A hook must never block or break a
 * commit "even fully offline": the agent always writes any un-sent events to a
 * local spool file and retries them on the next invocation. Idempotency is free
 * because every event carries a client-generated `event_uuid`, so re-sending a
 * spooled batch that partially landed is safe.
 *
 * The core decision — what to send, and what to keep on failure — is the pure
 * `flushSpool` below, kept free of fs/network so it is unit-testable.
 */

/**
 * Max events retained in the spool. Chosen below MAX_EVENTS_PER_BATCH so that
 * `pending + fresh` for a single invocation never exceeds one batch (the
 * IngestClient rejects over-large batches locally).
 */
export const SPOOL_CAP = 400;

export interface FlushInput {
  /** Events left over from previous (failed/offline) invocations. */
  pending: IngestEvent[];
  /** Events produced by the current hook invocation. */
  fresh: IngestEvent[];
  /** Sends one batch; resolves on success, rejects on any failure. */
  send: (events: IngestEvent[]) => Promise<void>;
  /** Retention cap for the resulting spool. Defaults to SPOOL_CAP. */
  cap?: number;
}

export interface FlushResult {
  attempted: number;
  sent: boolean;
  /** Events to persist back to the spool (empty on success). */
  remaining: IngestEvent[];
  /** Oldest events dropped because the spool was over `cap`. */
  dropped: number;
}

export async function flushSpool(input: FlushInput): Promise<FlushResult> {
  const cap = input.cap ?? SPOOL_CAP;
  const batch = [...input.pending, ...input.fresh];

  if (batch.length === 0) {
    return { attempted: 0, sent: true, remaining: [], dropped: 0 };
  }

  try {
    await input.send(batch);
    return { attempted: batch.length, sent: true, remaining: [], dropped: 0 };
  } catch {
    // Keep the most recent `cap` events; drop the oldest if we're over.
    const remaining = batch.length > cap ? batch.slice(batch.length - cap) : batch;
    return {
      attempted: batch.length,
      sent: false,
      remaining,
      dropped: batch.length - remaining.length,
    };
  }
}

// --- fs helpers (not covered by the pure tests) ---------------------------

/** Read the spool file, tolerating a missing or corrupt file (→ []). */
export function readSpool(file: string): IngestEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as IngestEvent[]) : [];
  } catch {
    return [];
  }
}

/** Atomically write the spool (write-temp + rename) so a crash can't corrupt it. */
export function writeSpool(file: string, events: IngestEvent[]): void {
  if (events.length === 0) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* ignore */
    }
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(events));
  fs.renameSync(tmp, file);
}

// Guard the invariant that a full spool plus one fresh event fits in a batch.
if (SPOOL_CAP >= MAX_EVENTS_PER_BATCH) {
  throw new Error("SPOOL_CAP must be < MAX_EVENTS_PER_BATCH");
}
