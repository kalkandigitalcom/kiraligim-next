CREATE TABLE "api_calendar_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"external_property_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"end_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	CONSTRAINT "api_calendar_connections_status_check" CHECK ("api_calendar_connections"."status" in ('active', 'disconnected', 'revoked')),
	CONSTRAINT "api_calendar_connections_external_id_format" CHECK ("api_calendar_connections"."external_property_id" ~ '^[!-~]([ -~]{0,98}[!-~])?$'),
	CONSTRAINT "api_calendar_connections_end_consistent" CHECK (("api_calendar_connections"."status" = 'active' and "api_calendar_connections"."ended_at" is null and "api_calendar_connections"."end_reason" is null) or ("api_calendar_connections"."status" = 'disconnected' and "api_calendar_connections"."ended_at" is not null and "api_calendar_connections"."end_reason" = 'agency') or ("api_calendar_connections"."status" = 'revoked' and "api_calendar_connections"."ended_at" is not null and "api_calendar_connections"."end_reason" = 'grant_revoked'))
);
--> statement-breakpoint
ALTER TABLE "api_calendar_connections" ADD CONSTRAINT "api_calendar_connections_client_id_api_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."api_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_calendar_connections" ADD CONSTRAINT "api_calendar_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_calendar_connections" ADD CONSTRAINT "api_calendar_connections_grant_id_api_access_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."api_access_grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_calendar_connections" ADD CONSTRAINT "api_calendar_connections_property_fk" FOREIGN KEY ("property_id","workspace_id") REFERENCES "public"."properties"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_calendar_connections_active_property_key" ON "api_calendar_connections" USING btree ("client_id","property_id") WHERE "api_calendar_connections"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "api_calendar_connections_active_external_key" ON "api_calendar_connections" USING btree ("client_id","external_property_id") WHERE "api_calendar_connections"."status" = 'active';--> statement-breakpoint
CREATE INDEX "api_calendar_connections_client_idx" ON "api_calendar_connections" USING btree ("client_id","id");--> statement-breakpoint
CREATE INDEX "api_calendar_connections_property_idx" ON "api_calendar_connections" USING btree ("property_id","status");--> statement-breakpoint
CREATE INDEX "api_calendar_connections_grant_idx" ON "api_calendar_connections" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "api_calendar_connections_workspace_idx" ON "api_calendar_connections" USING btree ("workspace_id");