import {
  HEARTBEAT_IDLE_MINUTES,
  HEARTBEAT_INTERVAL_MINUTES,
  STITCH_GAP_MINUTES,
} from "@mnl-dev-telemetry/shared";
import type { RepoContext } from "./presentation";

/**
 * "Should we ping right now?" — the whole idle rule, as one pure function
 * (Phase 6 §4a). This is the piece that must not be wrong: a heartbeat that
 * fires on window focus alone would log 8 phantom hours when someone leaves the
 * editor open overnight, poisoning the exact metric heartbeats exist to fix.
 *
 * So the gate is *real edit activity*, never presence of a window: the caller
 * stamps `lastActivityAt` from document changes / saves / selection moves, and
 * we stop pinging `HEARTBEAT_IDLE_MINUTES` after the last one.
 */

export const HEARTBEAT_INTERVAL_MS = HEARTBEAT_INTERVAL_MINUTES * 60_000;
export const HEARTBEAT_IDLE_MS = HEARTBEAT_IDLE_MINUTES * 60_000;

// The stitcher closes a session on a gap > STITCH_GAP_MINUTES. Pings must be far
// more frequent than that or they would create separate sessions instead of
// bracketing one, which is the entire point (§4a "stitcher interaction").
if (HEARTBEAT_INTERVAL_MINUTES >= STITCH_GAP_MINUTES) {
  throw new Error("HEARTBEAT_INTERVAL_MINUTES must be < STITCH_GAP_MINUTES");
}

export interface HeartbeatDecisionInput {
  now: number;
  /** Epoch ms of the last real edit activity, or null if there has been none. */
  lastActivityAt: number | null;
  /** Epoch ms of the last heartbeat we sent, or null if none yet. */
  lastSentAt: number | null;
  /** False when the machine isn't set up — send nothing, and don't nag. */
  hasCredentials: boolean;
  /** Heartbeats attribute to a repo; without one there is nothing to attribute. */
  repo: RepoContext | null;
  intervalMs?: number;
  idleTimeoutMs?: number;
}

export type HeartbeatSkipReason =
  | "not-set-up"
  | "no-repo"
  | "no-activity-yet"
  | "idle"
  | "too-soon";

export type HeartbeatDecision =
  | { send: true }
  | { send: false; reason: HeartbeatSkipReason };

export function shouldSendHeartbeat(
  input: HeartbeatDecisionInput,
): HeartbeatDecision {
  const intervalMs = input.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const idleTimeoutMs = input.idleTimeoutMs ?? HEARTBEAT_IDLE_MS;

  if (!input.hasCredentials) return { send: false, reason: "not-set-up" };

  // A ping with no repo would group under an empty repo+branch key in the
  // stitcher — noise, not signal. Branch may be null (detached HEAD); that's
  // fine, git-hook events behave the same way.
  if (!input.repo?.name) return { send: false, reason: "no-repo" };

  if (input.lastActivityAt === null) {
    return { send: false, reason: "no-activity-yet" };
  }
  if (input.now - input.lastActivityAt > idleTimeoutMs) {
    return { send: false, reason: "idle" };
  }
  if (input.lastSentAt !== null && input.now - input.lastSentAt < intervalMs) {
    return { send: false, reason: "too-soon" };
  }
  return { send: true };
}

/**
 * Whether a document is one whose edits count as "the dev is working".
 *
 * File-scheme only, and deliberately so: our own `output` channel, `git` diff
 * views, `vscode-userdata` settings writes and debug consoles all raise
 * document-change events too. Counting those would let the extension keep itself
 * alive by logging — an actual feedback loop, not a hypothetical one.
 *
 * PRIVACY (spec §2): callers pass only the scheme. The URI, file name and
 * contents are never read, stored or sent — the only thing a document change
 * ever produces is a timestamp.
 */
export function isActivityScheme(scheme: string | undefined): boolean {
  return scheme === "file";
}
