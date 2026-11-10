CREATE TABLE "wa_message_reactions" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"emoji" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"lock_token" uuid,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "wa_message_reactions_kind_check" CHECK ("wa_message_reactions"."kind" in ('done', 'submitted', 'warning')),
	CONSTRAINT "wa_message_reactions_emoji_check" CHECK (("wa_message_reactions"."kind" = 'done' and "wa_message_reactions"."emoji" = U&'\2705')
        or ("wa_message_reactions"."kind" = 'submitted' and "wa_message_reactions"."emoji" = U&'\2611\FE0F')
        or ("wa_message_reactions"."kind" = 'warning' and "wa_message_reactions"."emoji" = U&'\26A0\FE0F')),
	CONSTRAINT "wa_message_reactions_status_check" CHECK ("wa_message_reactions"."status" in ('pending', 'sending', 'sent', 'failed', 'expired')),
	CONSTRAINT "wa_message_reactions_state" CHECK ("wa_message_reactions"."attempts" >= 0 and ("wa_message_reactions"."status" = 'sent') = ("wa_message_reactions"."sent_at" is not null)
        and ("wa_message_reactions"."status" = 'sending') = ("wa_message_reactions"."lock_token" is not null and "wa_message_reactions"."locked_until" is not null)),
	CONSTRAINT "wa_message_reactions_last_error_format" CHECK ("wa_message_reactions"."last_error" is null or "wa_message_reactions"."last_error" ~ '^[a-z0-9_]{1,60}$')
);
--> statement-breakpoint
ALTER TABLE "wa_message_reactions" ADD CONSTRAINT "wa_message_reactions_message_id_wa_inbound_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."wa_inbound_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wa_message_reactions_queue_idx" ON "wa_message_reactions" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "wa_message_reactions_workspace_idx" ON "wa_message_reactions" USING btree ("workspace_id");