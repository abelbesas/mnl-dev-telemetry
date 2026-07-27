CREATE TYPE "public"."device_auth_status" AS ENUM('pending', 'approved', 'denied', 'expired');--> statement-breakpoint
CREATE TABLE "device_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_code" text NOT NULL,
	"user_code" text NOT NULL,
	"status" "device_auth_status" DEFAULT 'pending' NOT NULL,
	"user_id" uuid,
	"token_plaintext" text,
	"token_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	CONSTRAINT "device_authorizations_device_code_unique" UNIQUE("device_code"),
	CONSTRAINT "device_authorizations_user_code_unique" UNIQUE("user_code")
);
--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD CONSTRAINT "device_authorizations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;