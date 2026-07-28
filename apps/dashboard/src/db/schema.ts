import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * DevPulse data model (spec §3). The full model is defined here in Phase 1 so
 * later phases add rows, not migrations to the shared shape. Only `users`,
 * `agent_tokens` and `events` are exercised by Phase 1 code; the rest exist so
 * the schema is complete and stable.
 */

// --- Enums ----------------------------------------------------------------

export const userRole = pgEnum("user_role", ["dev", "lead"]);
export const eventSource = pgEnum("event_source", [
  "git_hook",
  "mcp",
  "cc_hook",
  "extension",
]);
export const eventType = pgEnum("event_type", [
  "commit",
  "push",
  "branch_switch",
  "session_start",
  "session_end",
  "tool_call",
  "task_start",
  "task_stop",
  "heartbeat",
]);
export const draftStatus = pgEnum("draft_status", [
  "draft",
  "approved",
  "synced",
  "dismissed",
]);
export const jiraKind = pgEnum("jira_kind", ["ours", "client"]);
export const deviceAuthStatus = pgEnum("device_auth_status", [
  "pending",
  "approved",
  "denied",
  "expired",
]);

// --- Tables ---------------------------------------------------------------

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  role: userRole("role").notNull().default("dev"),
  /**
   * Per-user working-hours settings used by the stitcher's clamp (spec §4.2/§4.5
   * Settings). Defaults mirror the shared config; editable from the Settings page.
   */
  tz: text("tz").notNull().default("Asia/Manila"),
  workdayStart: text("workday_start").notNull().default("09:00"),
  workdayEnd: text("workday_end").notNull().default("18:00"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const agentTokens = pgTable("agent_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  label: text("label").notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Client-generated idempotency key (spec §4.1). */
    eventUuid: uuid("event_uuid").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: eventSource("source").notNull(),
    type: eventType("type").notNull(),
    repo: text("repo"),
    branch: text("branch"),
    issueKey: text("issue_key"),
    /** Client timestamp. */
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    metadata: jsonb("metadata").notNull().default({}),
  },
  (t) => [
    uniqueIndex("events_event_uuid_key").on(t.eventUuid),
    index("events_user_ts_idx").on(t.userId, t.ts),
    index("events_issue_key_idx").on(t.issueKey),
  ],
);

export const taskSessions = pgTable("task_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  issueKey: text("issue_key"),
  repo: text("repo"),
  /** Raw session span bounds (spec §4.2: "keep raw span too"). */
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
  /**
   * Working-hours-clamped duration (spec §4.2.3: the *reported* seconds). Raw
   * span is `ended_at - started_at`; this is the clamped subset that rolls up
   * into worklog drafts in Phase 5.
   */
  reportedSeconds: integer("reported_seconds").notNull().default(0),
  aiAssisted: boolean("ai_assisted").notNull().default(false),
  aiTool: text("ai_tool"),
  eventCount: integer("event_count").notNull().default(0),
  /** Derived, rebuildable — bumped when the stitcher re-runs (spec §4.2). */
  stitchVersion: integer("stitch_version").notNull().default(0),
});

export const worklogDrafts = pgTable("worklog_drafts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  issueKey: text("issue_key").notNull(),
  date: date("date").notNull(),
  seconds: integer("seconds").notNull(),
  description: text("description"),
  sessionIds: jsonb("session_ids").notNull().default([]),
  status: draftStatus("status").notNull().default("draft"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  syncedAt: timestamp("synced_at", { withTimezone: true }),
  tempoWorklogId: text("tempo_worklog_id"),
});

export const jiraConnections = pgTable("jira_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  label: text("label").notNull(),
  baseUrl: text("base_url").notNull(),
  kind: jiraKind("kind").notNull(),
  /** Encrypted service-account credentials (spec §5). Server-side only. */
  auth: jsonb("auth"),
  tempoEnabled: boolean("tempo_enabled").notNull().default(false),
});

export const mirrorLinks = pgTable("mirror_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  internalIssueKey: text("internal_issue_key").notNull(),
  externalIssueKey: text("external_issue_key").notNull(),
  jiraConnectionId: uuid("jira_connection_id").references(
    () => jiraConnections.id,
    { onDelete: "set null" },
  ),
});

/**
 * Manual per-ticket time estimates (spec §4.5 Task detail: "estimate vs actual").
 * In the MVP an estimate is a manual field entered in the dashboard; Phase 5
 * will populate it from Jira. Ticket-level (one estimate per issue key), so the
 * Task-detail view can compare it against any dev's actual clamped time.
 */
export const taskEstimates = pgTable("task_estimates", {
  id: uuid("id").primaryKey().defaultRandom(),
  issueKey: text("issue_key").notNull().unique(),
  estimateSeconds: integer("estimate_seconds").notNull(),
  updatedBy: uuid("updated_by").references(() => users.id, {
    onDelete: "set null",
  }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Device-authorization grants (spec §4.3, item 1). Short-lived records backing
 * the CLI's device-flow login. `tokenPlaintext` parks the minted agent token
 * between approval and the CLI's next poll, then is cleared on retrieval — the
 * durable copy in `agent_tokens` is still only the sha256 hash (spec §5).
 */
export const deviceAuthorizations = pgTable("device_authorizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  deviceCode: text("device_code").notNull().unique(),
  userCode: text("user_code").notNull().unique(),
  status: deviceAuthStatus("status").notNull().default("pending"),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  /** One-time plaintext token, nulled once the CLI retrieves it. */
  tokenPlaintext: text("token_plaintext"),
  tokenLabel: text("token_label"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
});

/** Audit trail (spec §5): token issue/revoke, draft approval, sync push. */
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  target: text("target"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type UserRow = typeof users.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
export type AgentTokenRow = typeof agentTokens.$inferSelect;
export type DeviceAuthorizationRow = typeof deviceAuthorizations.$inferSelect;
export type TaskSessionRow = typeof taskSessions.$inferSelect;
export type NewTaskSessionRow = typeof taskSessions.$inferInsert;
export type TaskEstimateRow = typeof taskEstimates.$inferSelect;
