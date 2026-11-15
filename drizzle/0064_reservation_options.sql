CREATE TABLE "reservation_option_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"option_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"event" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"reason" text,
	"actor_user_id" uuid,
	"message_id" uuid,
	"converted_reservation_id" uuid,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservation_option_events_event_check" CHECK ("reservation_option_events"."event" in ('created', 'updated', 'converted', 'cancelled', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "reservation_options" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"source" text NOT NULL,
	"group_id" uuid,
	"origin_message_id" uuid,
	"origin_wa_message_id" text,
	"check_in" date NOT NULL,
	"check_out" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"expires_at" timestamp with time zone,
	"expiry_source" text,
	"guest_name" text,
	"note" text,
	"converted_reservation_id" uuid,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"ended_by_message_id" uuid,
	"ended_by_user_id" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "reservation_options_scope_key" UNIQUE("id","workspace_id"),
	CONSTRAINT "reservation_options_converted_key" UNIQUE("converted_reservation_id"),
	CONSTRAINT "reservation_options_status_check" CHECK ("reservation_options"."status" in ('open', 'converted', 'cancelled', 'expired')),
	CONSTRAINT "reservation_options_source_check" CHECK ("reservation_options"."source" in ('whatsapp', 'panel')),
	CONSTRAINT "reservation_options_dates" CHECK ("reservation_options"."check_out" > "reservation_options"."check_in" and "reservation_options"."check_out" - "reservation_options"."check_in" <= 365),
	CONSTRAINT "reservation_options_origin" CHECK (("reservation_options"."source" = 'whatsapp' and "reservation_options"."group_id" is not null and "reservation_options"."origin_wa_message_id" is not null)
        or ("reservation_options"."source" = 'panel' and "reservation_options"."group_id" is null and "reservation_options"."origin_message_id" is null
            and "reservation_options"."origin_wa_message_id" is null)),
	CONSTRAINT "reservation_options_expiry" CHECK (("reservation_options"."expires_at" is null) = ("reservation_options"."expiry_source" is null)
        and ("reservation_options"."expiry_source" is null or "reservation_options"."expiry_source" in ('message', 'workspace_default', 'manual'))),
	CONSTRAINT "reservation_options_end_state" CHECK (("reservation_options"."status" = 'open' and "reservation_options"."ended_at" is null and "reservation_options"."end_reason" is null
            and "reservation_options"."converted_reservation_id" is null and "reservation_options"."ended_by_message_id" is null
            and "reservation_options"."ended_by_user_id" is null)
        or ("reservation_options"."status" = 'converted' and "reservation_options"."ended_at" is not null and "reservation_options"."converted_reservation_id" is not null
            and "reservation_options"."end_reason" in ('payment_received', 'confirmed_in_panel'))
        or ("reservation_options"."status" = 'cancelled' and "reservation_options"."ended_at" is not null and "reservation_options"."converted_reservation_id" is null
            and "reservation_options"."end_reason" in ('customer_withdrew', 'cancelled_by_owner', 'cancelled_in_panel'))
        or ("reservation_options"."status" = 'expired' and "reservation_options"."ended_at" is not null and "reservation_options"."converted_reservation_id" is null
            and "reservation_options"."expires_at" is not null and "reservation_options"."end_reason" in ('expired'))),
	CONSTRAINT "reservation_options_lengths" CHECK (("reservation_options"."guest_name" is null or length(btrim("reservation_options"."guest_name")) between 1 and 120)
        and ("reservation_options"."note" is null or length("reservation_options"."note") <= 500)
        and ("reservation_options"."origin_wa_message_id" is null or length("reservation_options"."origin_wa_message_id") between 1 and 128)
        and "reservation_options"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "wa_option_shadow_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"item_no" smallint NOT NULL,
	"parser_version" smallint NOT NULL,
	"intent" text NOT NULL,
	"decision" text NOT NULL,
	"reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"property_id" uuid,
	"check_in" date,
	"check_out" date,
	"expires_in_minutes" integer,
	"target_option_id" uuid,
	"conflict_count" smallint DEFAULT 0 NOT NULL,
	"open_option_count" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_option_shadow_decisions_message_item_key" UNIQUE("message_id","item_no"),
	CONSTRAINT "wa_option_shadow_decisions_intent_check" CHECK ("wa_option_shadow_decisions"."intent" in ('create', 'convert', 'cancel', 'unknown')),
	CONSTRAINT "wa_option_shadow_decisions_decision_check" CHECK ("wa_option_shadow_decisions"."decision" in ('apply', 'ask', 'ignore')),
	CONSTRAINT "wa_option_shadow_decisions_values" CHECK ("wa_option_shadow_decisions"."item_no" between 0 and 19 and "wa_option_shadow_decisions"."parser_version" >= 1
        and "wa_option_shadow_decisions"."conflict_count" >= 0 and "wa_option_shadow_decisions"."open_option_count" >= 0
        and ("wa_option_shadow_decisions"."expires_in_minutes" is null or "wa_option_shadow_decisions"."expires_in_minutes" > 0)
        and (("wa_option_shadow_decisions"."check_in" is null and "wa_option_shadow_decisions"."check_out" is null) or "wa_option_shadow_decisions"."check_out" > "wa_option_shadow_decisions"."check_in")
        and cardinality("wa_option_shadow_decisions"."reasons") <= 20 and array_position("wa_option_shadow_decisions"."reasons", null) is null
        and (cardinality("wa_option_shadow_decisions"."reasons") = 0
             or array_to_string("wa_option_shadow_decisions"."reasons", ',') ~ '^[a-z_]{1,40}(,[a-z_]{1,40})*$'))
);
--> statement-breakpoint
ALTER TABLE "reservation_option_events" ADD CONSTRAINT "reservation_option_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_option_events" ADD CONSTRAINT "reservation_option_events_message_id_wa_inbound_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."wa_inbound_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_option_events" ADD CONSTRAINT "reservation_option_events_option_fk" FOREIGN KEY ("option_id","workspace_id") REFERENCES "public"."reservation_options"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_options" ADD CONSTRAINT "reservation_options_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_options" ADD CONSTRAINT "reservation_options_origin_message_id_wa_inbound_messages_id_fk" FOREIGN KEY ("origin_message_id") REFERENCES "public"."wa_inbound_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_options" ADD CONSTRAINT "reservation_options_converted_reservation_id_reservations_id_fk" FOREIGN KEY ("converted_reservation_id") REFERENCES "public"."reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_options" ADD CONSTRAINT "reservation_options_ended_by_message_id_wa_inbound_messages_id_fk" FOREIGN KEY ("ended_by_message_id") REFERENCES "public"."wa_inbound_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_options" ADD CONSTRAINT "reservation_options_ended_by_user_id_users_id_fk" FOREIGN KEY ("ended_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_options" ADD CONSTRAINT "reservation_options_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_options" ADD CONSTRAINT "reservation_options_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_options" ADD CONSTRAINT "reservation_options_property_fk" FOREIGN KEY ("property_id","workspace_id") REFERENCES "public"."properties"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_options" ADD CONSTRAINT "reservation_options_group_fk" FOREIGN KEY ("group_id","workspace_id") REFERENCES "public"."wa_groups"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_option_shadow_decisions" ADD CONSTRAINT "wa_option_shadow_decisions_message_id_wa_inbound_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."wa_inbound_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_option_shadow_decisions" ADD CONSTRAINT "wa_option_shadow_decisions_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_option_shadow_decisions" ADD CONSTRAINT "wa_option_shadow_decisions_target_option_id_reservation_options_id_fk" FOREIGN KEY ("target_option_id") REFERENCES "public"."reservation_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_option_shadow_decisions" ADD CONSTRAINT "wa_option_shadow_decisions_group_fk" FOREIGN KEY ("group_id","workspace_id") REFERENCES "public"."wa_groups"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reservation_option_events_option_idx" ON "reservation_option_events" USING btree ("option_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reservation_options_origin_key" ON "reservation_options" USING btree ("group_id","origin_wa_message_id") WHERE "reservation_options"."origin_wa_message_id" is not null;--> statement-breakpoint
CREATE INDEX "reservation_options_workspace_check_in_idx" ON "reservation_options" USING btree ("workspace_id","check_in");--> statement-breakpoint
CREATE INDEX "reservation_options_open_property_idx" ON "reservation_options" USING btree ("property_id","check_in") WHERE "reservation_options"."status" = 'open';--> statement-breakpoint
CREATE INDEX "reservation_options_open_expiry_idx" ON "reservation_options" USING btree ("expires_at") WHERE "reservation_options"."status" = 'open' and "reservation_options"."expires_at" is not null;--> statement-breakpoint
CREATE INDEX "wa_option_shadow_decisions_workspace_idx" ON "wa_option_shadow_decisions" USING btree ("workspace_id","created_at");