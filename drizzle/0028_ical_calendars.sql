CREATE TABLE "external_calendar_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"uid" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_calendar_events_source_uid_key" UNIQUE("source_id","uid"),
	CONSTRAINT "external_calendar_events_dates" CHECK ("external_calendar_events"."end_date" > "external_calendar_events"."start_date"),
	CONSTRAINT "external_calendar_events_uid_length" CHECK (length("external_calendar_events"."uid") between 1 and 255)
);
--> statement-breakpoint
CREATE TABLE "external_calendar_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error_code" text,
	"event_count" integer DEFAULT 0 NOT NULL,
	"conflict_count" integer DEFAULT 0 NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"lock_token" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_calendar_sources_scope_key" UNIQUE("id","workspace_id","property_id"),
	CONSTRAINT "external_calendar_sources_name_length" CHECK (length(btrim("external_calendar_sources"."name")) between 1 and 60),
	CONSTRAINT "external_calendar_sources_url_format" CHECK (length("external_calendar_sources"."url") <= 2048 and "external_calendar_sources"."url" ~ '^https?://[^\s]+$'),
	CONSTRAINT "external_calendar_sources_status_check" CHECK ("external_calendar_sources"."status" in ('pending', 'ok', 'error')),
	CONSTRAINT "external_calendar_sources_error_code_format" CHECK ("external_calendar_sources"."last_error_code" is null or "external_calendar_sources"."last_error_code" ~ '^[a-z_]{1,40}$'),
	CONSTRAINT "external_calendar_sources_counts" CHECK ("external_calendar_sources"."event_count" >= 0 and "external_calendar_sources"."conflict_count" >= 0 and "external_calendar_sources"."consecutive_failures" >= 0)
);
--> statement-breakpoint
CREATE TABLE "external_calendar_sync_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text NOT NULL,
	"error_code" text,
	"events_total" integer DEFAULT 0 NOT NULL,
	"events_added" integer DEFAULT 0 NOT NULL,
	"events_updated" integer DEFAULT 0 NOT NULL,
	"events_deactivated" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "external_calendar_sync_runs_trigger_check" CHECK ("external_calendar_sync_runs"."trigger" in ('cron', 'manual')),
	CONSTRAINT "external_calendar_sync_runs_outcome_check" CHECK ("external_calendar_sync_runs"."outcome" in ('ok', 'error')),
	CONSTRAINT "external_calendar_sync_runs_error_code_format" CHECK ("external_calendar_sync_runs"."error_code" is null or "external_calendar_sync_runs"."error_code" ~ '^[a-z_]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "property_ical_exports" (
	"property_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"token" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	"last_fetched_at" timestamp with time zone,
	CONSTRAINT "property_ical_exports_pkey" PRIMARY KEY("property_id"),
	CONSTRAINT "property_ical_exports_token_format" CHECK ("property_ical_exports"."token" ~ '^[A-Za-z0-9_-]{43}$')
);
--> statement-breakpoint
ALTER TABLE "external_calendar_events" ADD CONSTRAINT "external_calendar_events_source_fk" FOREIGN KEY ("source_id","workspace_id","property_id") REFERENCES "public"."external_calendar_sources"("id","workspace_id","property_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_calendar_sources" ADD CONSTRAINT "external_calendar_sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_calendar_sources" ADD CONSTRAINT "external_calendar_sources_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_calendar_sources" ADD CONSTRAINT "external_calendar_sources_property_fk" FOREIGN KEY ("property_id","workspace_id") REFERENCES "public"."properties"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_calendar_sync_runs" ADD CONSTRAINT "external_calendar_sync_runs_source_fk" FOREIGN KEY ("source_id") REFERENCES "public"."external_calendar_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_ical_exports" ADD CONSTRAINT "property_ical_exports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_ical_exports" ADD CONSTRAINT "property_ical_exports_property_fk" FOREIGN KEY ("property_id","workspace_id") REFERENCES "public"."properties"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "external_calendar_events_property_idx" ON "external_calendar_events" USING btree ("property_id","start_date") WHERE "external_calendar_events"."is_active";--> statement-breakpoint
CREATE INDEX "external_calendar_events_workspace_idx" ON "external_calendar_events" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_calendar_sources_property_name_key" ON "external_calendar_sources" USING btree ("property_id",lower("name"));--> statement-breakpoint
CREATE INDEX "external_calendar_sources_workspace_idx" ON "external_calendar_sources" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "external_calendar_sources_due_idx" ON "external_calendar_sources" USING btree ("is_active","last_synced_at");--> statement-breakpoint
CREATE INDEX "external_calendar_sources_created_by_idx" ON "external_calendar_sources" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "external_calendar_sync_runs_source_idx" ON "external_calendar_sync_runs" USING btree ("source_id","finished_at");--> statement-breakpoint
CREATE INDEX "external_calendar_sync_runs_workspace_idx" ON "external_calendar_sync_runs" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "property_ical_exports_token_key" ON "property_ical_exports" USING btree ("token");--> statement-breakpoint
CREATE INDEX "property_ical_exports_workspace_idx" ON "property_ical_exports" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "property_ical_exports_created_by_idx" ON "property_ical_exports" USING btree ("created_by");