CREATE TABLE "wa_phone_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"code_salt" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_phone_challenges_salt_format" CHECK ("wa_phone_challenges"."code_salt" ~ '^[0-9a-f]{32}$'),
	CONSTRAINT "wa_phone_challenges_hash_format" CHECK ("wa_phone_challenges"."code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "wa_phone_challenges_ttl" CHECK ("wa_phone_challenges"."expires_at" > "wa_phone_challenges"."created_at" and "wa_phone_challenges"."expires_at" <= "wa_phone_challenges"."created_at" + interval '15 minutes')
);
--> statement-breakpoint
CREATE TABLE "wa_verified_phones" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"phone_hash" text NOT NULL,
	"phone_masked" text NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_verified_phones_phone_key" UNIQUE("phone_hash"),
	CONSTRAINT "wa_verified_phones_hash_format" CHECK ("wa_verified_phones"."phone_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "wa_verified_phones_masked_length" CHECK (length("wa_verified_phones"."phone_masked") between 3 and 32)
);
--> statement-breakpoint
ALTER TABLE "wa_connections" ADD COLUMN "account_pn" text;--> statement-breakpoint
ALTER TABLE "wa_groups" ADD COLUMN "property_id" uuid;--> statement-breakpoint
ALTER TABLE "wa_groups" ADD COLUMN "added_by_hash" text;--> statement-breakpoint
ALTER TABLE "wa_groups" ADD COLUMN "owner_hash" text;--> statement-breakpoint
ALTER TABLE "wa_phone_challenges" ADD CONSTRAINT "wa_phone_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_phone_challenges" ADD CONSTRAINT "wa_phone_challenges_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_verified_phones" ADD CONSTRAINT "wa_verified_phones_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wa_phone_challenges_user_idx" ON "wa_phone_challenges" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "wa_phone_challenges_workspace_idx" ON "wa_phone_challenges" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "wa_phone_challenges_active_idx" ON "wa_phone_challenges" USING btree ("expires_at") WHERE "wa_phone_challenges"."used_at" is null;--> statement-breakpoint
ALTER TABLE "wa_groups" ADD CONSTRAINT "wa_groups_property_fk" FOREIGN KEY ("property_id","workspace_id") REFERENCES "public"."properties"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wa_groups_property_idx" ON "wa_groups" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "wa_groups_added_by_idx" ON "wa_groups" USING btree ("added_by_hash") WHERE "wa_groups"."status" = 'discovered';--> statement-breakpoint
CREATE INDEX "wa_groups_owner_hash_idx" ON "wa_groups" USING btree ("owner_hash") WHERE "wa_groups"."status" = 'discovered';--> statement-breakpoint
ALTER TABLE "wa_connections" ADD CONSTRAINT "wa_connections_account_pn_format" CHECK ("wa_connections"."account_pn" is null or "wa_connections"."account_pn" ~ '^[1-9][0-9]{6,19}$');--> statement-breakpoint
ALTER TABLE "wa_groups" ADD CONSTRAINT "wa_groups_phone_hash_format" CHECK (("wa_groups"."added_by_hash" is null or "wa_groups"."added_by_hash" ~ '^[0-9a-f]{64}$')
        and ("wa_groups"."owner_hash" is null or "wa_groups"."owner_hash" ~ '^[0-9a-f]{64}$'));--> statement-breakpoint
ALTER TABLE "wa_groups" ADD CONSTRAINT "wa_groups_property_workspace" CHECK ("wa_groups"."property_id" is null or "wa_groups"."workspace_id" is not null);