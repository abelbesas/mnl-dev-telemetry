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

// --- Tables ---------------------------------------------------------------

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  role: userRole("role").notNull().default("dev"),
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
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
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
