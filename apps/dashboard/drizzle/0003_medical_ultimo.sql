CREATE TYPE "public"."estimate_source" AS ENUM('manual', 'jira');--> statement-breakpoint
CREATE TYPE "public"."jira_connection_status" AS ENUM('active', 'broken');--> statement-breakpoint
ALTER TABLE "jira_connections" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "jira_connections" ADD COLUMN "tempo_auth" jsonb;--> statement-breakpoint
ALTER TABLE "jira_connections" ADD COLUMN "cloud_id" text;--> statement-breakpoint
ALTER TABLE "jira_connections" ADD COLUMN "account_id" text;--> statement-breakpoint
ALTER TABLE "jira_connections" ADD COLUMN "site_url" text;--> statement-breakpoint
ALTER TABLE "jira_connections" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jira_connections" ADD COLUMN "status" "jira_connection_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "jira_connections" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "jira_connections" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "jira_connections" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "mirror_links" ADD COLUMN "internal_issue_id" text;--> statement-breakpoint
ALTER TABLE "mirror_links" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "task_estimates" ADD COLUMN "source" "estimate_source" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "task_estimates" ADD COLUMN "synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "worklog_drafts" ADD COLUMN "sync_error" text;--> statement-breakpoint
ALTER TABLE "worklog_drafts" ADD COLUMN "sync_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "worklog_drafts" ADD COLUMN "synced_issue_key" text;--> statement-breakpoint
ALTER TABLE "jira_connections" ADD CONSTRAINT "jira_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "jira_connections_user_id_key" ON "jira_connections" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mirror_links_external_issue_key_key" ON "mirror_links" USING btree ("external_issue_key");--> statement-breakpoint
CREATE UNIQUE INDEX "worklog_drafts_user_issue_date_key" ON "worklog_drafts" USING btree ("user_id","issue_key","date");--> statement-breakpoint
CREATE INDEX "worklog_drafts_user_status_idx" ON "worklog_drafts" USING btree ("user_id","status");