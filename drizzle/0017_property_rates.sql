CREATE TABLE "property_rates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"nightly_amount_minor" bigint,
	"weekly_amount_minor" bigint,
	"currency" char(3) NOT NULL,
	"min_nights" smallint,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "property_rates_dates" CHECK ("property_rates"."end_date" > "property_rates"."start_date" and "property_rates"."end_date" - "property_rates"."start_date" <= 366),
	CONSTRAINT "property_rates_amounts" CHECK (("property_rates"."nightly_amount_minor" is not null or "property_rates"."weekly_amount_minor" is not null) and ("property_rates"."nightly_amount_minor" is null or "property_rates"."nightly_amount_minor" between 1 and 999999999999) and ("property_rates"."weekly_amount_minor" is null or "property_rates"."weekly_amount_minor" between 1 and 999999999999)),
	CONSTRAINT "property_rates_currency_check" CHECK ("property_rates"."currency" in ('TRY', 'EUR', 'USD', 'GBP')),
	CONSTRAINT "property_rates_min_nights" CHECK ("property_rates"."min_nights" is null or "property_rates"."min_nights" between 1 and 365)
);
--> statement-breakpoint
ALTER TABLE "property_rates" ADD CONSTRAINT "property_rates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_rates" ADD CONSTRAINT "property_rates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_rates" ADD CONSTRAINT "property_rates_property_fk" FOREIGN KEY ("property_id","workspace_id") REFERENCES "public"."properties"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "property_rates_property_start_idx" ON "property_rates" USING btree ("property_id","start_date");--> statement-breakpoint
CREATE INDEX "property_rates_workspace_idx" ON "property_rates" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "property_rates_created_by_idx" ON "property_rates" USING btree ("created_by");