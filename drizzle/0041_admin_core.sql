CREATE TABLE "admin_audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"admin_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "admin_audit_log_action_format" CHECK ("admin_audit_log"."action" ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
	CONSTRAINT "admin_audit_log_metadata_object" CHECK (jsonb_typeof("admin_audit_log"."metadata") = 'object' and pg_column_size("admin_audit_log"."metadata") <= 4096)
);
--> statement-breakpoint
CREATE TABLE "admin_login_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"admin_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_login_challenges_token_format" CHECK ("admin_login_challenges"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "admin_login_challenges_attempts" CHECK ("admin_login_challenges"."attempts" between 0 and 10)
);
--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"admin_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "admin_sessions_token_format" CHECK ("admin_sessions"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"totp_secret_enc" text NOT NULL,
	"totp_last_step" bigint,
	"status" text DEFAULT 'active' NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_users_status_check" CHECK ("admin_users"."status" in ('active', 'disabled')),
	CONSTRAINT "admin_users_email_format" CHECK ("admin_users"."email" = lower(btrim("admin_users"."email")) and length("admin_users"."email") between 3 and 254 and "admin_users"."email" like '%_@_%'),
	CONSTRAINT "admin_users_name_length" CHECK (length(btrim("admin_users"."name")) between 1 and 100),
	CONSTRAINT "admin_users_password_format" CHECK ("admin_users"."password_hash" ~ '^scrypt\$'),
	CONSTRAINT "admin_users_totp_format" CHECK ("admin_users"."totp_secret_enc" ~ '^v1:'),
	CONSTRAINT "admin_users_failed_count" CHECK ("admin_users"."failed_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_admin_id_admin_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_login_challenges" ADD CONSTRAINT "admin_login_challenges_admin_id_admin_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_id_admin_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_audit_log_occurred_idx" ON "admin_audit_log" USING btree ("occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "admin_audit_log_admin_idx" ON "admin_audit_log" USING btree ("admin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_login_challenges_token_key" ON "admin_login_challenges" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "admin_login_challenges_admin_idx" ON "admin_login_challenges" USING btree ("admin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_sessions_token_key" ON "admin_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "admin_sessions_admin_idx" ON "admin_sessions" USING btree ("admin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users" USING btree ("email");