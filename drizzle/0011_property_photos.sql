CREATE TABLE "property_photos" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"storage_prefix" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"quality" smallint NOT NULL,
	"bytes_400" integer NOT NULL,
	"bytes_1200" integer NOT NULL,
	"bytes_2000" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_cover" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "property_photos_storage_prefix_format" CHECK ("property_photos"."storage_prefix" ~ '^w/[0-9a-f-]{36}/p/[0-9a-f-]{36}/[0-9a-f-]{36}$'),
	CONSTRAINT "property_photos_dimensions" CHECK ("property_photos"."width" between 1 and 2000 and "property_photos"."height" between 1 and 16383),
	CONSTRAINT "property_photos_quality_range" CHECK ("property_photos"."quality" between 50 and 90),
	CONSTRAINT "property_photos_variant_bytes" CHECK ("property_photos"."bytes_400" between 1 and 5242880 and "property_photos"."bytes_1200" between 1 and 5242880 and "property_photos"."bytes_2000" between 1 and 5242880),
	CONSTRAINT "property_photos_sort_order_range" CHECK ("property_photos"."sort_order" >= 0)
);
--> statement-breakpoint
ALTER TABLE "property_photos" ADD CONSTRAINT "property_photos_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_photos" ADD CONSTRAINT "property_photos_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_photos" ADD CONSTRAINT "property_photos_property_fk" FOREIGN KEY ("property_id","workspace_id") REFERENCES "public"."properties"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "property_photos_storage_prefix_key" ON "property_photos" USING btree ("storage_prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "property_photos_single_cover_idx" ON "property_photos" USING btree ("property_id") WHERE "property_photos"."is_cover";--> statement-breakpoint
CREATE INDEX "property_photos_property_order_idx" ON "property_photos" USING btree ("property_id","sort_order");--> statement-breakpoint
CREATE INDEX "property_photos_workspace_idx" ON "property_photos" USING btree ("workspace_id");