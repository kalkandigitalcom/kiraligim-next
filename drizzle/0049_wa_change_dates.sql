ALTER TABLE "wa_calendar_proposals" DROP CONSTRAINT "wa_calendar_proposals_action_check";--> statement-breakpoint
ALTER TABLE "wa_calendar_proposals" DROP CONSTRAINT "wa_calendar_proposals_quick_only_close";--> statement-breakpoint
ALTER TABLE "wa_calendar_proposals" ADD COLUMN "old_check_in" date;--> statement-breakpoint
ALTER TABLE "wa_calendar_proposals" ADD COLUMN "old_check_out" date;--> statement-breakpoint
ALTER TABLE "wa_calendar_proposals" ADD CONSTRAINT "wa_calendar_proposals_old_dates" CHECK (("wa_calendar_proposals"."old_check_in" is null and "wa_calendar_proposals"."old_check_out" is null)
        or ("wa_calendar_proposals"."action" = 'change' and "wa_calendar_proposals"."old_check_in" is not null and "wa_calendar_proposals"."old_check_out" > "wa_calendar_proposals"."old_check_in"));--> statement-breakpoint
ALTER TABLE "wa_calendar_proposals" ADD CONSTRAINT "wa_calendar_proposals_change_applied" CHECK ("wa_calendar_proposals"."status" <> 'applied' or "wa_calendar_proposals"."action" is distinct from 'change'
        or ("wa_calendar_proposals"."old_check_in" is not null and "wa_calendar_proposals"."old_check_out" is not null));--> statement-breakpoint
ALTER TABLE "wa_calendar_proposals" ADD CONSTRAINT "wa_calendar_proposals_action_check" CHECK ("wa_calendar_proposals"."action" is null or "wa_calendar_proposals"."action" in ('close', 'reserve', 'open', 'cancel', 'change'));--> statement-breakpoint
ALTER TABLE "wa_calendar_proposals" ADD CONSTRAINT "wa_calendar_proposals_quick_only_close" CHECK ("wa_calendar_proposals"."decision_mode" is distinct from 'quick'
        or ("wa_calendar_proposals"."action" in ('close', 'open', 'change') and cardinality("wa_calendar_proposals"."decision_reasons") = 0
            and "wa_calendar_proposals"."sender_role" in ('owner', 'manager', 'staff', 'participant')));