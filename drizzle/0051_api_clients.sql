CREATE TABLE "api_access_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"granted_by_user" uuid,
	"granted_by_admin" uuid,
	"granted_via" text NOT NULL,
	"revoked_by_user" uuid,
	"revoked_by_admin" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_access_grants_status_check" CHECK ("api_access_grants"."status" in ('active', 'revoked')),
	CONSTRAINT "api_access_grants_via_check" CHECK ("api_access_grants"."granted_via" in ('owner', 'admin')),
	CONSTRAINT "api_access_grants_revoked_consistent" CHECK (("api_access_grants"."status" = 'revoked') = ("api_access_grants"."revoked_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "api_clients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"rate_limit_per_minute" integer DEFAULT 120 NOT NULL,
	"access_code_hash" text,
	"access_code_hint" text,
	"access_code_created_at" timestamp with time zone,
	"created_by_admin" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_clients_status_check" CHECK ("api_clients"."status" in ('active', 'disabled')),
	CONSTRAINT "api_clients_name_length" CHECK (length(btrim("api_clients"."name")) between 1 and 100),
	CONSTRAINT "api_clients_rate_limit_range" CHECK ("api_clients"."rate_limit_per_minute" between 1 and 10000),
	CONSTRAINT "api_clients_access_code_format" CHECK (("api_clients"."access_code_hash" is null and "api_clients"."access_code_hint" is null and "api_clients"."access_code_created_at" is null) or ("api_clients"."access_code_hash" ~ '^[0-9a-f]{64}$' and "api_clients"."access_code_hint" ~ '^[A-Z2-9]{4}$' and "api_clients"."access_code_created_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"prefix" text NOT NULL,
	"secret_hash" text NOT NULL,
	"label" text,
	"status" text DEFAULT 'active' NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_by_admin" uuid,
	"revoked_by_admin" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_status_check" CHECK ("api_keys"."status" in ('active', 'revoked')),
	CONSTRAINT "api_keys_format" CHECK ("api_keys"."prefix" ~ '^[a-z2-7]{8}$' and "api_keys"."secret_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "api_keys_label_length" CHECK ("api_keys"."label" is null or length(btrim("api_keys"."label")) between 1 and 60),
	CONSTRAINT "api_keys_revoked_consistent" CHECK (("api_keys"."status" = 'revoked') = ("api_keys"."revoked_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "api_rate_windows" (
	"key_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "api_rate_windows_pkey" PRIMARY KEY("key_id","window_start"),
	CONSTRAINT "api_rate_windows_count_check" CHECK ("api_rate_windows"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "api_usage_daily" (
	"client_id" uuid NOT NULL,
	"day" date NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"rate_limited" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "api_usage_daily_pkey" PRIMARY KEY("client_id","day"),
	CONSTRAINT "api_usage_daily_counts_check" CHECK ("api_usage_daily"."requests" >= 0 and "api_usage_daily"."rate_limited" >= 0 and "api_usage_daily"."errors" >= 0)
);
--> statement-breakpoint
ALTER TABLE "api_access_grants" ADD CONSTRAINT "api_access_grants_client_id_api_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."api_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_access_grants" ADD CONSTRAINT "api_access_grants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_access_grants" ADD CONSTRAINT "api_access_grants_granted_by_user_users_id_fk" FOREIGN KEY ("granted_by_user") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_access_grants" ADD CONSTRAINT "api_access_grants_granted_by_admin_admin_users_id_fk" FOREIGN KEY ("granted_by_admin") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_access_grants" ADD CONSTRAINT "api_access_grants_revoked_by_user_users_id_fk" FOREIGN KEY ("revoked_by_user") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_access_grants" ADD CONSTRAINT "api_access_grants_revoked_by_admin_admin_users_id_fk" FOREIGN KEY ("revoked_by_admin") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_access_grants" ADD CONSTRAINT "api_access_grants_property_fk" FOREIGN KEY ("property_id","workspace_id") REFERENCES "public"."properties"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_clients" ADD CONSTRAINT "api_clients_created_by_admin_admin_users_id_fk" FOREIGN KEY ("created_by_admin") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_client_id_api_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."api_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_admin_admin_users_id_fk" FOREIGN KEY ("created_by_admin") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_revoked_by_admin_admin_users_id_fk" FOREIGN KEY ("revoked_by_admin") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_rate_windows" ADD CONSTRAINT "api_rate_windows_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_usage_daily" ADD CONSTRAINT "api_usage_daily_client_id_api_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."api_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_access_grants_active_key" ON "api_access_grants" USING btree ("client_id","property_id") WHERE "api_access_grants"."status" = 'active';--> statement-breakpoint
CREATE INDEX "api_access_grants_client_idx" ON "api_access_grants" USING btree ("client_id","status","property_id");--> statement-breakpoint
CREATE INDEX "api_access_grants_property_idx" ON "api_access_grants" USING btree ("property_id","status");--> statement-breakpoint
CREATE INDEX "api_access_grants_workspace_idx" ON "api_access_grants" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "api_access_grants_granted_by_user_idx" ON "api_access_grants" USING btree ("granted_by_user");--> statement-breakpoint
CREATE INDEX "api_access_grants_granted_by_admin_idx" ON "api_access_grants" USING btree ("granted_by_admin");--> statement-breakpoint
CREATE INDEX "api_access_grants_revoked_by_user_idx" ON "api_access_grants" USING btree ("revoked_by_user");--> statement-breakpoint
CREATE INDEX "api_access_grants_revoked_by_admin_idx" ON "api_access_grants" USING btree ("revoked_by_admin");--> statement-breakpoint
CREATE UNIQUE INDEX "api_clients_access_code_hash_key" ON "api_clients" USING btree ("access_code_hash") WHERE "api_clients"."access_code_hash" is not null;--> statement-breakpoint
CREATE INDEX "api_clients_created_by_admin_idx" ON "api_clients" USING btree ("created_by_admin");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_secret_hash_key" ON "api_keys" USING btree ("secret_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_prefix_key" ON "api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "api_keys_client_idx" ON "api_keys" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX "api_keys_created_by_admin_idx" ON "api_keys" USING btree ("created_by_admin");--> statement-breakpoint
CREATE INDEX "api_keys_revoked_by_admin_idx" ON "api_keys" USING btree ("revoked_by_admin");