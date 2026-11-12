CREATE TABLE "api_calendar_changes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "api_calendar_changes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"property_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"busy" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_calendar_changes_range_check" CHECK ("api_calendar_changes"."end_date" > "api_calendar_changes"."start_date"),
	CONSTRAINT "api_calendar_changes_busy_array" CHECK (jsonb_typeof("api_calendar_changes"."busy") = 'array')
);
--> statement-breakpoint
CREATE TABLE "api_sync_state" (
	"id" smallint PRIMARY KEY NOT NULL,
	"last_change_id" bigint DEFAULT 0 NOT NULL,
	"pruned_through_id" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_sync_state_singleton" CHECK ("api_sync_state"."id" = 1),
	CONSTRAINT "api_sync_state_ids_check" CHECK ("api_sync_state"."last_change_id" >= 0 and "api_sync_state"."pruned_through_id" >= 0 and "api_sync_state"."pruned_through_id" <= "api_sync_state"."last_change_id")
);
--> statement-breakpoint
ALTER TABLE "api_calendar_connections" ADD COLUMN "cursor_key" text DEFAULT gen_random_uuid()::text NOT NULL;--> statement-breakpoint
CREATE INDEX "api_calendar_changes_property_idx" ON "api_calendar_changes" USING btree ("property_id","id");--> statement-breakpoint
CREATE INDEX "api_calendar_changes_created_idx" ON "api_calendar_changes" USING btree ("created_at");