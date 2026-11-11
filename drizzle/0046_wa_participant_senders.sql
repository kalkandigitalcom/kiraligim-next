CREATE TABLE "wa_blocked_senders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"phone_hash" text NOT NULL,
	"phone_hint" text NOT NULL,
	"group_id" uuid,
	"created_by_admin" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_blocked_senders_format" CHECK ("wa_blocked_senders"."phone_hash" ~ '^[0-9a-f]{64}$' and "wa_blocked_senders"."phone_hint" ~ '^[0-9]{2,4}$')
);
--> statement-breakpoint
ALTER TABLE "wa_calendar_proposals" DROP CONSTRAINT "wa_calendar_proposals_sender_role";--> statement-breakpoint
ALTER TABLE "wa_calendar_proposals" DROP CONSTRAINT "wa_calendar_proposals_quick_only_close";--> statement-breakpoint
ALTER TABLE "wa_blocked_senders" ADD CONSTRAINT "wa_blocked_senders_group_id_wa_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."wa_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_blocked_senders" ADD CONSTRAINT "wa_blocked_senders_created_by_admin_admin_users_id_fk" FOREIGN KEY ("created_by_admin") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wa_blocked_senders_global_key" ON "wa_blocked_senders" USING btree ("phone_hash") WHERE "wa_blocked_senders"."group_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "wa_blocked_senders_group_key" ON "wa_blocked_senders" USING btree ("phone_hash","group_id") WHERE "wa_blocked_senders"."group_id" is not null;--> statement-breakpoint
CREATE INDEX "wa_blocked_senders_group_idx" ON "wa_blocked_senders" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "wa_blocked_senders_created_by_admin_idx" ON "wa_blocked_senders" USING btree ("created_by_admin");--> statement-breakpoint
ALTER TABLE "wa_calendar_proposals" ADD CONSTRAINT "wa_calendar_proposals_sender_role" CHECK ("wa_calendar_proposals"."sender_role" in ('owner', 'manager', 'staff', 'participant')
        and "wa_calendar_proposals"."sender_verified" = ("wa_calendar_proposals"."sender_role" in ('owner', 'manager')));--> statement-breakpoint
ALTER TABLE "wa_calendar_proposals" ADD CONSTRAINT "wa_calendar_proposals_quick_only_close" CHECK ("wa_calendar_proposals"."decision_mode" is distinct from 'quick'
        or ("wa_calendar_proposals"."action" = 'close' and cardinality("wa_calendar_proposals"."decision_reasons") = 0
            and "wa_calendar_proposals"."sender_role" in ('owner', 'manager', 'staff', 'participant')));