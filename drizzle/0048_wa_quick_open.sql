ALTER TABLE "wa_calendar_proposals" DROP CONSTRAINT "wa_calendar_proposals_quick_only_close";--> statement-breakpoint
ALTER TABLE "wa_calendar_proposals" ADD CONSTRAINT "wa_calendar_proposals_quick_only_close" CHECK ("wa_calendar_proposals"."decision_mode" is distinct from 'quick'
        or ("wa_calendar_proposals"."action" in ('close', 'open') and cardinality("wa_calendar_proposals"."decision_reasons") = 0
            and "wa_calendar_proposals"."sender_role" in ('owner', 'manager', 'staff', 'participant')));