CREATE TABLE "wa_calendar_proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"message_id" uuid,
	"group_id" uuid NOT NULL,
	"item_no" smallint NOT NULL,
	"parser_version" smallint NOT NULL,
	"message_excerpt" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"sender_hash" text NOT NULL,
	"sender_role" text NOT NULL,
	"sender_verified" boolean NOT NULL,
	"action" text,
	"villa_name_raw" text,
	"property_id" uuid,
	"villa_resolution" text NOT NULL,
	"candidate_property_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"check_in" date,
	"check_out" date,
	"reservation_status" text,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"conflicts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"score" smallint NOT NULL,
	"band" text NOT NULL,
	"review_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"target_reservation_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"edited" boolean DEFAULT false NOT NULL,
	"applied_reservation_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"superseded_by" uuid,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"decision_mode" text,
	"decision_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_calendar_proposals_message_item_key" UNIQUE("message_id","item_no"),
	CONSTRAINT "wa_calendar_proposals_scope_key" UNIQUE("id","workspace_id"),
	CONSTRAINT "wa_calendar_proposals_action_check" CHECK ("wa_calendar_proposals"."action" is null or "wa_calendar_proposals"."action" in ('close', 'reserve', 'open', 'cancel')),
	CONSTRAINT "wa_calendar_proposals_status_check" CHECK ("wa_calendar_proposals"."status" in ('pending', 'applied', 'rejected', 'superseded', 'expired', 'noop')),
	CONSTRAINT "wa_calendar_proposals_villa_resolution_check" CHECK ("wa_calendar_proposals"."villa_resolution" in ('named', 'single', 'ambiguous', 'none')),
	CONSTRAINT "wa_calendar_proposals_band_check" CHECK ("wa_calendar_proposals"."band" in ('high', 'medium', 'low')),
	CONSTRAINT "wa_calendar_proposals_decision_mode_check" CHECK ("wa_calendar_proposals"."decision_mode" is null or "wa_calendar_proposals"."decision_mode" in ('quick', 'reviewed')),
	CONSTRAINT "wa_calendar_proposals_reservation_status" CHECK (("wa_calendar_proposals"."action" = 'reserve') = ("wa_calendar_proposals"."reservation_status" is not null)
        and ("wa_calendar_proposals"."reservation_status" is null or "wa_calendar_proposals"."reservation_status" in ('confirmed', 'pending'))),
	CONSTRAINT "wa_calendar_proposals_dates" CHECK ("wa_calendar_proposals"."check_out" is null or ("wa_calendar_proposals"."check_in" is not null and "wa_calendar_proposals"."check_out" > "wa_calendar_proposals"."check_in")),
	CONSTRAINT "wa_calendar_proposals_numbers" CHECK ("wa_calendar_proposals"."item_no" between 0 and 9
        and "wa_calendar_proposals"."parser_version" >= 1 and "wa_calendar_proposals"."score" between 0 and 100 and "wa_calendar_proposals"."version" >= 1),
	CONSTRAINT "wa_calendar_proposals_lengths" CHECK (length("wa_calendar_proposals"."message_excerpt") between 1 and 500
        and ("wa_calendar_proposals"."villa_name_raw" is null or length("wa_calendar_proposals"."villa_name_raw") between 1 and 120)
        and ("wa_calendar_proposals"."decision_note" is null or length("wa_calendar_proposals"."decision_note") <= 500)),
	CONSTRAINT "wa_calendar_proposals_sender_hash_format" CHECK ("wa_calendar_proposals"."sender_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "wa_calendar_proposals_sender_role" CHECK ("wa_calendar_proposals"."sender_role" in ('owner', 'manager', 'staff')
        and "wa_calendar_proposals"."sender_verified" = ("wa_calendar_proposals"."sender_role" in ('owner', 'manager'))
        and ("wa_calendar_proposals"."sender_role" <> 'staff' or 'staff_review_required' = any("wa_calendar_proposals"."review_reasons"))),
	CONSTRAINT "wa_calendar_proposals_flags" CHECK (cardinality("wa_calendar_proposals"."flags") <= 20 and array_position("wa_calendar_proposals"."flags", null) is null
    and (cardinality("wa_calendar_proposals"."flags") = 0 or array_to_string("wa_calendar_proposals"."flags", ',') ~ '^[a-z_]{1,40}(,[a-z_]{1,40})*$')),
	CONSTRAINT "wa_calendar_proposals_review_reasons" CHECK (cardinality("wa_calendar_proposals"."review_reasons") <= 20 and array_position("wa_calendar_proposals"."review_reasons", null) is null
    and (cardinality("wa_calendar_proposals"."review_reasons") = 0 or array_to_string("wa_calendar_proposals"."review_reasons", ',') ~ '^[a-z_]{1,40}(,[a-z_]{1,40})*$')),
	CONSTRAINT "wa_calendar_proposals_decision_reasons" CHECK (cardinality("wa_calendar_proposals"."decision_reasons") <= 20 and array_position("wa_calendar_proposals"."decision_reasons", null) is null
    and (cardinality("wa_calendar_proposals"."decision_reasons") = 0 or array_to_string("wa_calendar_proposals"."decision_reasons", ',') ~ '^[a-z_]{1,40}(,[a-z_]{1,40})*$')),
	CONSTRAINT "wa_calendar_proposals_id_arrays" CHECK (cardinality("wa_calendar_proposals"."candidate_property_ids") <= 20
        and cardinality("wa_calendar_proposals"."target_reservation_ids") <= 20
        and cardinality("wa_calendar_proposals"."applied_reservation_ids") <= 20),
	CONSTRAINT "wa_calendar_proposals_conflicts" CHECK (jsonb_typeof("wa_calendar_proposals"."conflicts") = 'array' and jsonb_array_length("wa_calendar_proposals"."conflicts") <= 20),
	CONSTRAINT "wa_calendar_proposals_decision" CHECK (("wa_calendar_proposals"."status" in ('applied', 'rejected')) = ("wa_calendar_proposals"."decided_at" is not null)
        and ("wa_calendar_proposals"."status" = 'applied') = ("wa_calendar_proposals"."decision_mode" is not null)
        and ("wa_calendar_proposals"."status" <> 'applied' or ("wa_calendar_proposals"."action" is not null and "wa_calendar_proposals"."property_id" is not null
             and "wa_calendar_proposals"."check_in" is not null and "wa_calendar_proposals"."check_out" is not null))),
	CONSTRAINT "wa_calendar_proposals_quick_only_close" CHECK ("wa_calendar_proposals"."decision_mode" is distinct from 'quick'
        or ("wa_calendar_proposals"."action" = 'close' and cardinality("wa_calendar_proposals"."decision_reasons") = 0
            and "wa_calendar_proposals"."sender_role" in ('owner', 'manager'))),
	CONSTRAINT "wa_calendar_proposals_superseded" CHECK (("wa_calendar_proposals"."status" = 'superseded') = ("wa_calendar_proposals"."superseded_by" is not null) and "wa_calendar_proposals"."superseded_by" is distinct from "wa_calendar_proposals"."id")
);
--> statement-breakpoint
ALTER TABLE "reservations" DROP CONSTRAINT "reservations_source_check";--> statement-breakpoint
ALTER TABLE "wa_inbound_messages" DROP CONSTRAINT "wa_inbound_messages_status_check";--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "origin_proposal_id" uuid;--> statement-breakpoint
ALTER TABLE "wa_inbound_messages" ADD COLUMN "processed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wa_inbound_messages" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "wa_calendar_proposals" ADD CONSTRAINT "wa_calendar_proposals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_calendar_proposals" ADD CONSTRAINT "wa_calendar_proposals_message_id_wa_inbound_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."wa_inbound_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_calendar_proposals" ADD CONSTRAINT "wa_calendar_proposals_group_id_wa_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."wa_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_calendar_proposals" ADD CONSTRAINT "wa_calendar_proposals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_calendar_proposals" ADD CONSTRAINT "wa_calendar_proposals_property_fk" FOREIGN KEY ("property_id","workspace_id") REFERENCES "public"."properties"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_calendar_proposals" ADD CONSTRAINT "wa_calendar_proposals_superseded_by_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."wa_calendar_proposals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wa_calendar_proposals_pending_idx" ON "wa_calendar_proposals" USING btree ("workspace_id","created_at") WHERE "wa_calendar_proposals"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "wa_calendar_proposals_property_pending_idx" ON "wa_calendar_proposals" USING btree ("property_id","check_in") WHERE "wa_calendar_proposals"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "wa_calendar_proposals_workspace_idx" ON "wa_calendar_proposals" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "wa_calendar_proposals_group_idx" ON "wa_calendar_proposals" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "wa_calendar_proposals_property_idx" ON "wa_calendar_proposals" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "wa_calendar_proposals_decided_by_idx" ON "wa_calendar_proposals" USING btree ("decided_by");--> statement-breakpoint
CREATE INDEX "wa_calendar_proposals_superseded_by_idx" ON "wa_calendar_proposals" USING btree ("superseded_by");--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_origin_proposal_fk" FOREIGN KEY ("origin_proposal_id","workspace_id") REFERENCES "public"."wa_calendar_proposals"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reservations_origin_proposal_idx" ON "reservations" USING btree ("origin_proposal_id");--> statement-breakpoint
CREATE INDEX "wa_inbound_messages_pending_idx" ON "wa_inbound_messages" USING btree ("received_at") WHERE "wa_inbound_messages"."status" in ('received', 'processing');--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_source_check" CHECK ("reservations"."source" is null or "reservations"."source" in ('direct', 'phone', 'airbnb', 'booking', 'other', 'web', 'whatsapp'));--> statement-breakpoint
ALTER TABLE "wa_inbound_messages" ADD CONSTRAINT "wa_inbound_messages_last_error_format" CHECK ("wa_inbound_messages"."last_error" is null or "wa_inbound_messages"."last_error" ~ '^[a-z0-9_]{1,60}$');--> statement-breakpoint
ALTER TABLE "wa_inbound_messages" ADD CONSTRAINT "wa_inbound_messages_attempts" CHECK ("wa_inbound_messages"."attempts" >= 0);--> statement-breakpoint
ALTER TABLE "wa_inbound_messages" ADD CONSTRAINT "wa_inbound_messages_status_check" CHECK ("wa_inbound_messages"."status" in ('received', 'processing', 'processed', 'ignored', 'failed'));