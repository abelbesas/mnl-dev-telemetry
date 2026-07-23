import { z } from "zod";
import { ISSUE_KEY_REGEX } from "./issue-key";
import { MAX_EVENTS_PER_BATCH } from "./config";

/**
 * Event payload contract (spec §3). These zod schemas are the single source of
 * truth reused by the ingestion API (validation), the git hooks and MCP server
 * (construction). Treat any change here as breaking.
 *
 * PRIVACY (spec §2): payloads carry metadata only. Object schemas below use
 * zod's default behaviour of STRIPPING unknown keys, so a hook that
 * accidentally attaches a file path or diff will have it dropped rather than
 * stored — validation never widens what we persist.
 */

// --- Enums ----------------------------------------------------------------

export const EVENT_SOURCES = [
  "git_hook",
  "mcp",
  "cc_hook",
  "extension",
] as const;
export const eventSourceSchema = z.enum(EVENT_SOURCES);
export type EventSource = z.infer<typeof eventSourceSchema>;

export const EVENT_TYPES = [
  "commit",
  "push",
  "branch_switch",
  "session_start",
  "session_end",
  "tool_call",
  "task_start",
  "task_stop",
  "heartbeat",
] as const;
export const eventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof eventTypeSchema>;

// --- Primitives -----------------------------------------------------------

/** A validated issue key string, e.g. `ABC-123`. */
export const issueKeySchema = z
  .string()
  .regex(ISSUE_KEY_REGEX, "must look like an issue key, e.g. ABC-123");

/** Client-supplied ISO-8601 timestamp (accepts `Z` or numeric offset). */
export const isoTimestampSchema = z.string().datetime({ offset: true });

// --- Per-type metadata ----------------------------------------------------
// Only known, non-sensitive fields; everything else is stripped.

/** Diff stats for a commit (spec §2: files changed, insertions, deletions). */
export const commitMetadataSchema = z.object({
  sha: z.string().min(7).max(64).optional(),
  files_changed: z.number().int().nonnegative().optional(),
  insertions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  /** Set when a commit trailer names an AI co-author (spec §4.2 AI flag). */
  ai_co_author: z.string().max(255).optional(),
});
export type CommitMetadata = z.infer<typeof commitMetadataSchema>;

export const pushMetadataSchema = z.object({
  commit_count: z.number().int().nonnegative().optional(),
  remote: z.string().max(255).optional(),
});

export const branchSwitchMetadataSchema = z.object({
  from_branch: z.string().max(255).optional(),
  to_branch: z.string().max(255).optional(),
});

/** SessionStart / SessionEnd from a Claude Code / editor hook. */
export const sessionMetadataSchema = z.object({
  tool: z.string().max(64).optional(),
  /** Repo basename only — never a full path (spec §2). */
  cwd_repo: z.string().max(255).optional(),
});

export const toolCallMetadataSchema = z.object({
  tool: z.string().min(1).max(128),
});

/** Short human/AI-written summary attached to a session (spec §4.4). */
export const emptyMetadataSchema = z.object({});

// --- Event envelope + discriminated union ---------------------------------

const baseEvent = z.object({
  /** Client-generated idempotency key (spec §4.1). */
  event_uuid: z.string().uuid(),
  source: eventSourceSchema,
  /** Client timestamp when the event happened. */
  ts: isoTimestampSchema,
  /** Repo basename (spec §2: never a path). Optional for repo-less events. */
  repo: z.string().min(1).max(255).optional(),
  branch: z.string().min(1).max(255).optional(),
  issue_key: issueKeySchema.nullish(),
});

const commitEvent = baseEvent.extend({
  type: z.literal("commit"),
  metadata: commitMetadataSchema.optional(),
});
const pushEvent = baseEvent.extend({
  type: z.literal("push"),
  metadata: pushMetadataSchema.optional(),
});
const branchSwitchEvent = baseEvent.extend({
  type: z.literal("branch_switch"),
  metadata: branchSwitchMetadataSchema.optional(),
});
const sessionStartEvent = baseEvent.extend({
  type: z.literal("session_start"),
  metadata: sessionMetadataSchema.optional(),
});
const sessionEndEvent = baseEvent.extend({
  type: z.literal("session_end"),
  metadata: sessionMetadataSchema.optional(),
});
const toolCallEvent = baseEvent.extend({
  type: z.literal("tool_call"),
  metadata: toolCallMetadataSchema,
});
const taskStartEvent = baseEvent.extend({
  type: z.literal("task_start"),
  // task_start(issue_key) — the key is required for this event (spec §4.4).
  issue_key: issueKeySchema,
  metadata: emptyMetadataSchema.optional(),
});
const taskStopEvent = baseEvent.extend({
  type: z.literal("task_stop"),
  metadata: emptyMetadataSchema.optional(),
});
const heartbeatEvent = baseEvent.extend({
  type: z.literal("heartbeat"),
  metadata: emptyMetadataSchema.optional(),
});

/** A single validated ingestion event. */
export const eventSchema = z.discriminatedUnion("type", [
  commitEvent,
  pushEvent,
  branchSwitchEvent,
  sessionStartEvent,
  sessionEndEvent,
  toolCallEvent,
  taskStartEvent,
  taskStopEvent,
  heartbeatEvent,
]);
export type IngestEvent = z.infer<typeof eventSchema>;

/** POST /api/ingest/events body — an array of events (spec §4.1 batching). */
export const eventBatchSchema = z.object({
  events: z.array(eventSchema).min(1).max(MAX_EVENTS_PER_BATCH),
});
export type EventBatch = z.infer<typeof eventBatchSchema>;

/** Response returned by the ingestion endpoint. */
export const ingestResponseSchema = z.object({
  inserted: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  skipped_uuids: z.array(z.string()),
});
export type IngestResponse = z.infer<typeof ingestResponseSchema>;
