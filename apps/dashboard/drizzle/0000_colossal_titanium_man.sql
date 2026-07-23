CREATE TYPE "public"."draft_status" AS ENUM('draft', 'approved', 'synced', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."event_source" AS ENUM('git_hook', 'mcp', 'cc_hook', 'extension');--> statement-breakpoint
CREATE TYPE "public"."event_type" AS ENUM('commit', 'push', 'branch_switch', 'session_start', 'session_end', 'tool_call', 'task_start', 'task_stop', 'heartbeat');--> statement-breakpoint
CREATE TYPE "public"."jira_kind" AS ENUM('ours', 'client');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('dev', 'lead');--> statement-breakpoint
CREATE TABLE "agent_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"label" text NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"target" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_uuid" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"source" "event_source" NOT NULL,
	"type" "event_type" NOT NULL,
	"repo" text,
	"branch" text,
	"issue_key" text,
	"ts" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jira_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"base_url" text NOT NULL,
	"kind" "jira_kind" NOT NULL,
	"auth" jsonb,
	"tempo_enabled" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mirror_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"internal_issue_key" text NOT NULL,
	"external_issue_key" text NOT NULL,
	"jira_connection_id" uuid
);
--> statement-breakpoint
CREATE TABLE "task_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"issue_key" text,
	"repo" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"ai_assisted" boolean DEFAULT false NOT NULL,
	"ai_tool" text,
	"event_count" integer DEFAULT 0 NOT NULL,
	"stitch_version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" "user_role" DEFAULT 'dev' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "worklog_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"issue_key" text NOT NULL,
	"date" date NOT NULL,
	"seconds" integer NOT NULL,
	"description" text,
	"session_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "draft_status" DEFAULT 'draft' NOT NULL,
	"approved_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"tempo_worklog_id" text
);
--> statement-breakpoint
ALTER TABLE "agent_tokens" ADD CONSTRAINT "agent_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mirror_links" ADD CONSTRAINT "mirror_links_jira_connection_id_jira_connections_id_fk" FOREIGN KEY ("jira_connection_id") REFERENCES "public"."jira_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_sessions" ADD CONSTRAINT "task_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worklog_drafts" ADD CONSTRAINT "worklog_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "events_event_uuid_key" ON "events" USING btree ("event_uuid");--> statement-breakpoint
CREATE INDEX "events_user_ts_idx" ON "events" USING btree ("user_id","ts");--> statement-breakpoint
CREATE INDEX "events_issue_key_idx" ON "events" USING btree ("issue_key");