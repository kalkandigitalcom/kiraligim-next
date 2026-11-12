CREATE TABLE "api_calendar_dirty" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "api_calendar_dirty_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"property_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"reason" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_calendar_dirty_range_check" CHECK ("api_calendar_dirty"."end_date" > "api_calendar_dirty"."start_date"),
	CONSTRAINT "api_calendar_dirty_reason_check" CHECK ("api_calendar_dirty"."reason" in ('reservation', 'external_event', 'external_source', 'property_status', 'workspace_status')),
	CONSTRAINT "api_calendar_dirty_attempts_check" CHECK ("api_calendar_dirty"."attempts" >= 0),
	CONSTRAINT "api_calendar_dirty_last_error_format" CHECK ("api_calendar_dirty"."last_error" is null or "api_calendar_dirty"."last_error" ~ '^[a-z0-9_]{1,64}$')
);
--> statement-breakpoint
CREATE INDEX "api_calendar_dirty_property_idx" ON "api_calendar_dirty" USING btree ("property_id","id");