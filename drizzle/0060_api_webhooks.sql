CREATE TABLE "api_webhook_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"change_id" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"last_status" integer,
	"last_error" text,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "api_webhook_deliveries_status_check" CHECK ("api_webhook_deliveries"."status" in ('pending', 'delivered', 'failed', 'cancelled')),
	CONSTRAINT "api_webhook_deliveries_finished_consistent" CHECK (("api_webhook_deliveries"."status" = 'pending') = ("api_webhook_deliveries"."finished_at" is null)),
	CONSTRAINT "api_webhook_deliveries_codes_format" CHECK (("api_webhook_deliveries"."last_error" is null or "api_webhook_deliveries"."last_error" ~ '^[a-z0-9_]{1,64}$') and ("api_webhook_deliveries"."cancel_reason" is null or "api_webhook_deliveries"."cancel_reason" ~ '^[a-z0-9_]{1,64}$')),
	CONSTRAINT "api_webhook_deliveries_attempts_check" CHECK ("api_webhook_deliveries"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "api_webhook_endpoints" (
	"client_id" uuid PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"secret_enc" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"secret_rotated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_webhook_endpoints_url_format" CHECK ("api_webhook_endpoints"."url" ~ '^https://[^/@[:space:]]+(/[^[:space:]]*)?$' and length("api_webhook_endpoints"."url") <= 2048),
	CONSTRAINT "api_webhook_endpoints_secret_format" CHECK ("api_webhook_endpoints"."secret_enc" ~ '^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$')
);
--> statement-breakpoint
ALTER TABLE "api_calendar_connections" ADD COLUMN "snapshot_change_id" bigint;--> statement-breakpoint
ALTER TABLE "api_clients" ADD COLUMN "cursor_key" text DEFAULT gen_random_uuid()::text NOT NULL;--> statement-breakpoint
ALTER TABLE "api_webhook_deliveries" ADD CONSTRAINT "api_webhook_deliveries_client_id_api_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."api_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_webhook_deliveries" ADD CONSTRAINT "api_webhook_deliveries_connection_id_api_calendar_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."api_calendar_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_webhook_endpoints" ADD CONSTRAINT "api_webhook_endpoints_client_id_api_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."api_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_webhook_deliveries_connection_change_key" ON "api_webhook_deliveries" USING btree ("connection_id","change_id");--> statement-breakpoint
CREATE INDEX "api_webhook_deliveries_pending_idx" ON "api_webhook_deliveries" USING btree ("connection_id","change_id") WHERE "api_webhook_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "api_webhook_deliveries_client_idx" ON "api_webhook_deliveries" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX "api_webhook_deliveries_created_idx" ON "api_webhook_deliveries" USING btree ("created_at");