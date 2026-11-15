CREATE TABLE "option_conflict_alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"option_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" uuid NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by_admin" uuid,
	CONSTRAINT "option_conflict_alerts_source_key" UNIQUE("option_id","source_kind","source_id"),
	CONSTRAINT "option_conflict_alerts_source_check" CHECK ("option_conflict_alerts"."source_kind" in ('reservation', 'external_event')),
	CONSTRAINT "option_conflict_alerts_ack" CHECK ("option_conflict_alerts"."acknowledged_by_admin" is null or "option_conflict_alerts"."acknowledged_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "option_message_scans" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"status" text NOT NULL,
	"attempts" smallint DEFAULT 1 NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone,
	CONSTRAINT "option_message_scans_state" CHECK (("option_message_scans"."status" = 'claimed' and "option_message_scans"."done_at" is null) or ("option_message_scans"."status" = 'done' and "option_message_scans"."done_at" is not null)),
	CONSTRAINT "option_message_scans_attempts" CHECK ("option_message_scans"."attempts" between 1 and 10)
);
--> statement-breakpoint
CREATE TABLE "option_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"group_id" uuid,
	"message_id" uuid,
	"wa_message_id" text,
	"item_no" smallint DEFAULT 0 NOT NULL,
	"property_id" uuid NOT NULL,
	"check_in" date,
	"check_out" date,
	"sent_at" timestamp with time zone,
	"expires_in_minutes" integer,
	"expiry_source" text,
	"end_reason" text,
	"target_option_id" uuid,
	"target_option_version" integer,
	"result_option_id" uuid,
	"result_reservation_id" uuid,
	"reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"fingerprint" text,
	"before_state" jsonb,
	"after_state" jsonb,
	"guest_name" text,
	"adults" smallint,
	"children" smallint,
	"decided_by_admin" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"failure_code" text,
	"lock_token" uuid,
	"locked_until" timestamp with time zone,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	CONSTRAINT "option_operations_kind_check" CHECK ("option_operations"."kind" in ('create', 'cancel', 'convert')),
	CONSTRAINT "option_operations_mode_check" CHECK ("option_operations"."mode" in ('auto', 'needs_approval')),
	CONSTRAINT "option_operations_status_check" CHECK ("option_operations"."status" in ('pending', 'approved', 'applied', 'rejected', 'stale', 'failed')),
	CONSTRAINT "option_operations_source_check" CHECK ("option_operations"."source" in ('whatsapp', 'panel')),
	CONSTRAINT "option_operations_origin" CHECK (("option_operations"."source" = 'whatsapp' and "option_operations"."group_id" is not null and "option_operations"."wa_message_id" is not null)
        or ("option_operations"."source" = 'panel' and "option_operations"."group_id" is null and "option_operations"."message_id" is null and "option_operations"."wa_message_id" is null)),
	CONSTRAINT "option_operations_values" CHECK ("option_operations"."item_no" between 0 and 19 and "option_operations"."version" >= 1 and "option_operations"."attempts" >= 0
        and (("option_operations"."check_in" is null and "option_operations"."check_out" is null) or "option_operations"."check_out" > "option_operations"."check_in")
        and ("option_operations"."expires_in_minutes" is null or "option_operations"."expires_in_minutes" between 60 and 20160)
        and ("option_operations"."expiry_source" is null or "option_operations"."expiry_source" in ('message', 'workspace_default', 'manual'))
        and ("option_operations"."end_reason" is null or "option_operations"."end_reason" in ('payment_received', 'confirmed_in_panel', 'customer_declined', 'owner_cancelled', 'panel_cancel', 'expired'))
        and ("option_operations"."adults" is null or "option_operations"."adults" between 1 and 50)
        and ("option_operations"."children" is null or "option_operations"."children" between 0 and 50)
        and ("option_operations"."guest_name" is null or length(btrim("option_operations"."guest_name")) between 2 and 120)
        and ("option_operations"."decision_note" is null or length("option_operations"."decision_note") <= 500)
        and ("option_operations"."wa_message_id" is null or length("option_operations"."wa_message_id") between 1 and 128)
        and ("option_operations"."fingerprint" is null or "option_operations"."fingerprint" ~ '^[0-9a-f]{32}$')
        and ("option_operations"."failure_code" is null or "option_operations"."failure_code" ~ '^[a-z0-9_]{1,60}$')
        and cardinality("option_operations"."reasons") <= 20 and array_position("option_operations"."reasons", null) is null
        and (cardinality("option_operations"."reasons") = 0
             or array_to_string("option_operations"."reasons", ',') ~ '^[a-z_]{1,40}(,[a-z_]{1,40})*$')
        and ("option_operations"."before_state" is null or (jsonb_typeof("option_operations"."before_state") = 'object' and pg_column_size("option_operations"."before_state") <= 4096))
        and ("option_operations"."after_state" is null or (jsonb_typeof("option_operations"."after_state") = 'object' and pg_column_size("option_operations"."after_state") <= 4096))),
	CONSTRAINT "option_operations_state" CHECK (("option_operations"."status" in ('pending') and "option_operations"."decided_at" is null and "option_operations"."applied_at" is null)
        or ("option_operations"."status" in ('approved', 'rejected') and "option_operations"."mode" = 'needs_approval'
            and "option_operations"."decided_at" is not null and "option_operations"."applied_at" is null)
        or ("option_operations"."status" = 'applied' and "option_operations"."applied_at" is not null
            and ("option_operations"."mode" = 'auto' or "option_operations"."decided_at" is not null))
        or ("option_operations"."status" in ('stale', 'failed') and "option_operations"."applied_at" is null))
);
--> statement-breakpoint
ALTER TABLE "option_conflict_alerts" ADD CONSTRAINT "option_conflict_alerts_acknowledged_by_admin_admin_users_id_fk" FOREIGN KEY ("acknowledged_by_admin") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_conflict_alerts" ADD CONSTRAINT "option_conflict_alerts_option_fk" FOREIGN KEY ("option_id","workspace_id") REFERENCES "public"."reservation_options"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_message_scans" ADD CONSTRAINT "option_message_scans_message_id_wa_inbound_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."wa_inbound_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_operations" ADD CONSTRAINT "option_operations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_operations" ADD CONSTRAINT "option_operations_group_id_wa_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."wa_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_operations" ADD CONSTRAINT "option_operations_message_id_wa_inbound_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."wa_inbound_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_operations" ADD CONSTRAINT "option_operations_target_option_id_reservation_options_id_fk" FOREIGN KEY ("target_option_id") REFERENCES "public"."reservation_options"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_operations" ADD CONSTRAINT "option_operations_result_option_id_reservation_options_id_fk" FOREIGN KEY ("result_option_id") REFERENCES "public"."reservation_options"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_operations" ADD CONSTRAINT "option_operations_result_reservation_id_reservations_id_fk" FOREIGN KEY ("result_reservation_id") REFERENCES "public"."reservations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_operations" ADD CONSTRAINT "option_operations_decided_by_admin_admin_users_id_fk" FOREIGN KEY ("decided_by_admin") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_operations" ADD CONSTRAINT "option_operations_property_fk" FOREIGN KEY ("property_id","workspace_id") REFERENCES "public"."properties"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "option_conflict_alerts_open_idx" ON "option_conflict_alerts" USING btree ("detected_at") WHERE "option_conflict_alerts"."acknowledged_at" is null;--> statement-breakpoint
CREATE INDEX "option_conflict_alerts_workspace_idx" ON "option_conflict_alerts" USING btree ("workspace_id","detected_at");--> statement-breakpoint
CREATE INDEX "option_message_scans_claimed_idx" ON "option_message_scans" USING btree ("claimed_at") WHERE "option_message_scans"."status" = 'claimed';--> statement-breakpoint
CREATE UNIQUE INDEX "option_operations_message_key" ON "option_operations" USING btree ("group_id","wa_message_id","item_no") WHERE "option_operations"."wa_message_id" is not null;--> statement-breakpoint
CREATE INDEX "option_operations_status_idx" ON "option_operations" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "option_operations_workspace_idx" ON "option_operations" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "option_operations_target_idx" ON "option_operations" USING btree ("target_option_id");--> statement-breakpoint
CREATE INDEX "option_operations_result_option_idx" ON "option_operations" USING btree ("result_option_id");