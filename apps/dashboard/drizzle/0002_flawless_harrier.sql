CREATE TABLE "task_estimates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_key" text NOT NULL,
	"estimate_seconds" integer NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_estimates_issue_key_unique" UNIQUE("issue_key")
);
--> statement-breakpoint
ALTER TABLE "task_sessions" ADD COLUMN "reported_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tz" text DEFAULT 'Asia/Manila' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "workday_start" text DEFAULT '09:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "workday_end" text DEFAULT '18:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "task_estimates" ADD CONSTRAINT "task_estimates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;