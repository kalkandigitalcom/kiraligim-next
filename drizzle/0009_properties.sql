CREATE TABLE "properties" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"property_type" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"max_guests" smallint NOT NULL,
	"bedrooms" smallint NOT NULL,
	"bathrooms" smallint NOT NULL,
	"beds_double" smallint DEFAULT 0 NOT NULL,
	"beds_single" smallint DEFAULT 0 NOT NULL,
	"beds_sofa" smallint DEFAULT 0 NOT NULL,
	"country_code" char(2) DEFAULT 'TR' NOT NULL,
	"province" text NOT NULL,
	"district" text NOT NULL,
	"neighborhood" text,
	"address_line" text,
	"postal_code" text,
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "properties_id_workspace_key" UNIQUE("id","workspace_id"),
	CONSTRAINT "properties_name_length" CHECK (length(btrim("properties"."name")) between 2 and 120),
	CONSTRAINT "properties_type_check" CHECK ("properties"."property_type" in ('villa', 'apart', 'bungalow', 'ev')),
	CONSTRAINT "properties_status_check" CHECK ("properties"."status" in ('active', 'passive')),
	CONSTRAINT "properties_description_length" CHECK ("properties"."description" is null or length("properties"."description") <= 5000),
	CONSTRAINT "properties_max_guests_range" CHECK ("properties"."max_guests" between 1 and 50),
	CONSTRAINT "properties_rooms_range" CHECK ("properties"."bedrooms" between 0 and 50 and "properties"."bathrooms" between 0 and 50),
	CONSTRAINT "properties_beds_range" CHECK ("properties"."beds_double" between 0 and 50 and "properties"."beds_single" between 0 and 50 and "properties"."beds_sofa" between 0 and 50),
	CONSTRAINT "properties_country_code_format" CHECK ("properties"."country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "properties_place_length" CHECK (length(btrim("properties"."province")) between 2 and 60 and length(btrim("properties"."district")) between 2 and 60),
	CONSTRAINT "properties_address_length" CHECK (("properties"."neighborhood" is null or length("properties"."neighborhood") <= 120) and ("properties"."address_line" is null or length("properties"."address_line") <= 300)),
	CONSTRAINT "properties_postal_code_format" CHECK ("properties"."postal_code" is null or "properties"."postal_code" ~ '^[0-9]{5}$'),
	CONSTRAINT "properties_coordinates" CHECK (("properties"."latitude" is null) = ("properties"."longitude" is null) and ("properties"."latitude" is null or ("properties"."latitude" between -90 and 90 and "properties"."longitude" between -180 and 180)))
);
--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "properties_workspace_status_idx" ON "properties" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "properties_created_by_idx" ON "properties" USING btree ("created_by");