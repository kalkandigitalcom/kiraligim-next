ALTER TABLE "properties" ADD COLUMN "description_html" text;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "tourism_license_no" text;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "youtube_video_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "pool_swimming" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "pool_swimming_depth" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "pool_swimming_width" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "pool_swimming_length" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "pool_swimming_protected" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "pool_indoor" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "pool_indoor_depth" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "pool_indoor_width" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "pool_indoor_length" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "pool_kids" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "pool_kids_depth" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "pool_kids_width" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "pool_kids_length" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_description_html_length" CHECK ("properties"."description_html" is null or length("properties"."description_html") <= 20000);--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_tourism_license_format" CHECK ("properties"."tourism_license_no" is null or (length("properties"."tourism_license_no") between 1 and 40 and "properties"."tourism_license_no" !~ '[[:cntrl:]<>]'));--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_youtube_video_ids" CHECK (cardinality("properties"."youtube_video_ids") <= 10 and array_position("properties"."youtube_video_ids", null) is null and (cardinality("properties"."youtube_video_ids") = 0 or array_to_string("properties"."youtube_video_ids", ',') ~ '^[A-Za-z0-9_-]{11}(,[A-Za-z0-9_-]{11})*$'));--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_pool_swimming" CHECK (case when "properties"."pool_swimming" then "properties"."pool_swimming_depth" is not null and "properties"."pool_swimming_width" is not null and "properties"."pool_swimming_length" is not null and "properties"."pool_swimming_depth" between 0.1 and 10 and "properties"."pool_swimming_width" between 0.5 and 100 and "properties"."pool_swimming_length" between 0.5 and 100 else "properties"."pool_swimming_depth" is null and "properties"."pool_swimming_width" is null and "properties"."pool_swimming_length" is null end);--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_pool_indoor" CHECK (case when "properties"."pool_indoor" then "properties"."pool_indoor_depth" is not null and "properties"."pool_indoor_width" is not null and "properties"."pool_indoor_length" is not null and "properties"."pool_indoor_depth" between 0.1 and 10 and "properties"."pool_indoor_width" between 0.5 and 100 and "properties"."pool_indoor_length" between 0.5 and 100 else "properties"."pool_indoor_depth" is null and "properties"."pool_indoor_width" is null and "properties"."pool_indoor_length" is null end);--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_pool_kids" CHECK (case when "properties"."pool_kids" then "properties"."pool_kids_depth" is not null and "properties"."pool_kids_width" is not null and "properties"."pool_kids_length" is not null and "properties"."pool_kids_depth" between 0.1 and 10 and "properties"."pool_kids_width" between 0.5 and 100 and "properties"."pool_kids_length" between 0.5 and 100 else "properties"."pool_kids_depth" is null and "properties"."pool_kids_width" is null and "properties"."pool_kids_length" is null end);--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_pool_swimming_protected" CHECK ("properties"."pool_swimming" or not "properties"."pool_swimming_protected");