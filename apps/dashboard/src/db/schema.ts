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
 * MnlDevTelemetry data model (spec §3). The full model is defined here in Phase 1 so
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
/**
 * Health of an outbound Jira connection. `broken` is set when a token refresh
 * fails (revoked grant, rotated secret) so the UI can say "reconnect" instead of
 * a sync silently failing forever (Phase-5 brief §6A).
 */
export const jiraConnectionStatus = pgEnum("jira_connection_status", [
  "active",
  "broken",
]);
/** Where a task estimate came from (Phase-5 brief §5). */
export const estimateSource = pgEnum("estimate_source", ["manual", "jira"]);
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

export const worklogDrafts = pgTable(
  "worklog_drafts",
  {
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
    /**
     * Last sync failure, surfaced on the Drafts row. A Jira/Tempo outage must
     * land here — never as a 500 on a page (Phase-5 brief §9).
     */
    syncError: text("sync_error"),
    syncAttemptedAt: timestamp("sync_attempted_at", { withTimezone: true }),
    /** Mirror ticket actually logged against, when it differs from `issueKey`. */
    syncedIssueKey: text("synced_issue_key"),
    /**
     * Set once a dev hand-edits the seconds/description. The rollup then leaves
     * the row alone — re-deriving it from sessions would silently revert their
     * correction, which is the whole point of an editable draft.
     */
    edited: boolean("edited").notNull().default(false),
  },
  (t) => [
    /**
     * One draft per user per ticket per day — this constraint is what makes the
     * nightly rollup idempotent (brief §6C): a re-run collides and updates
     * rather than inserting a duplicate.
     */
    uniqueIndex("worklog_drafts_user_issue_date_key").on(
      t.userId,
      t.issueKey,
      t.date,
    ),
    index("worklog_drafts_user_status_idx").on(t.userId, t.status),
  ],
);

export const jiraConnections = pgTable(
  "jira_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Owner of this connection. **Null = org-level** (the optional env-var
     * service account used only for mirror-ticket creation). Per-user OAuth
     * rows always carry a user (Phase-5 brief §2/§5).
     */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    baseUrl: text("base_url").notNull(),
    kind: jiraKind("kind").notNull(),
    /**
     * Encrypted OAuth token bundle (spec §5): `{ enc: "<v1 envelope>" }`. The
     * whole bundle is one AES-256-GCM ciphertext, so the row leaks nothing about
     * token shape. Never decrypted outside the server, never sent to an agent.
     */
    auth: jsonb("auth"),
    /**
     * Encrypted Tempo credential, stored separately because **Tempo auth is not
     * Jira auth** — linking Jira grants no Tempo access (brief §4).
     */
    tempoAuth: jsonb("tempo_auth"),
    tempoEnabled: boolean("tempo_enabled").notNull().default(false),
    /** cloudId from accessible-resources — addresses the site's API. */
    cloudId: text("cloud_id"),
    /** The user's Jira accountId — Tempo's `authorAccountId`. */
    accountId: text("account_id"),
    siteUrl: text("site_url"),
    /** Access-token expiry; a refresh is attempted transparently before this. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    status: jiraConnectionStatus("status").notNull().default("active"),
    /** Why the connection went `broken`, shown as "reconnect" context. */
    statusReason: text("status_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    /**
     * One connection per user. Postgres allows repeated NULLs in a unique
     * index, so org-level rows (user_id NULL) are unconstrained — exactly the
     * behaviour we want.
     */
    uniqueIndex("jira_connections_user_id_key").on(t.userId),
  ],
);

/**
 * Maps a client-project ticket we can't resolve (`external_issue_key`) to the
 * mirror ticket we created in our own Jira (`internal_issue_key`), so time can
 * still be logged somewhere (spec §4.6). Unique on the external key: one mirror
 * per client ticket, which is what makes find-or-create idempotent.
 */
export const mirrorLinks = pgTable(
  "mirror_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    internalIssueKey: text("internal_issue_key").notNull(),
    externalIssueKey: text("external_issue_key").notNull(),
    /** Numeric Jira id of the mirror, cached so a push skips a resolve call. */
    internalIssueId: text("internal_issue_id"),
    jiraConnectionId: uuid("jira_connection_id").references(
      () => jiraConnections.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("mirror_links_external_issue_key_key").on(t.externalIssueKey),
  ],
);

/**
 * Per-ticket time estimates (spec §4.5 Task detail: "estimate vs actual").
 * Ticket-level (one estimate per issue key), so the Task-detail view can compare
 * it against any dev's actual clamped time. Phase 5 populates these from Jira
 * into the *same* table rather than a second one (brief §3), so Task detail has
 * one code path; `source` records which way a row got its value.
 */
export const taskEstimates = pgTable("task_estimates", {
  id: uuid("id").primaryKey().defaultRandom(),
  issueKey: text("issue_key").notNull().unique(),
  estimateSeconds: integer("estimate_seconds").notNull(),
  source: estimateSource("source").notNull().default("manual"),
  /** When this row was last refreshed from Jira (null for manual entries). */
  syncedAt: timestamp("synced_at", { withTimezone: true }),
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
export type WorklogDraftRow = typeof worklogDrafts.$inferSelect;
export type NewWorklogDraftRow = typeof worklogDrafts.$inferInsert;
export type JiraConnectionRow = typeof jiraConnections.$inferSelect;
export type MirrorLinkRow = typeof mirrorLinks.$inferSelect;
