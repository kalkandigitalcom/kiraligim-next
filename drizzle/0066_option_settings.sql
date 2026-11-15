CREATE TABLE "option_automation_global" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_admin" uuid,
	CONSTRAINT "option_automation_global_singleton" CHECK ("option_automation_global"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "wa_group_option_settings" (
	"group_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_admin" uuid
);
--> statement-breakpoint
CREATE TABLE "workspace_option_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"automation_enabled" boolean DEFAULT false NOT NULL,
	"default_duration_minutes" integer,
	"duration_choices" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_admin" uuid,
	CONSTRAINT "workspace_option_settings_values" CHECK (("workspace_option_settings"."default_duration_minutes" is null or "workspace_option_settings"."default_duration_minutes" between 60 and 20160)
        and cardinality("workspace_option_settings"."duration_choices") <= 12
        and array_position("workspace_option_settings"."duration_choices", null) is null
        and 60 <= all("workspace_option_settings"."duration_choices")
        and 20160 >= all("workspace_option_settings"."duration_choices"))
);
--> statement-breakpoint
ALTER TABLE "reservation_options" DROP CONSTRAINT "reservation_options_end_state";--> statement-breakpoint
ALTER TABLE "reservation_option_events" ADD COLUMN "actor_admin_id" uuid;--> statement-breakpoint
ALTER TABLE "reservation_options" ADD COLUMN "adults" smallint;--> statement-breakpoint
ALTER TABLE "reservation_options" ADD COLUMN "children" smallint;--> statement-breakpoint
ALTER TABLE "option_automation_global" ADD CONSTRAINT "option_automation_global_updated_by_admin_admin_users_id_fk" FOREIGN KEY ("updated_by_admin") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_group_option_settings" ADD CONSTRAINT "wa_group_option_settings_group_id_wa_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."wa_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_group_option_settings" ADD CONSTRAINT "wa_group_option_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_group_option_settings" ADD CONSTRAINT "wa_group_option_settings_updated_by_admin_admin_users_id_fk" FOREIGN KEY ("updated_by_admin") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_option_settings" ADD CONSTRAINT "workspace_option_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_option_settings" ADD CONSTRAINT "workspace_option_settings_updated_by_admin_admin_users_id_fk" FOREIGN KEY ("updated_by_admin") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wa_group_option_settings_workspace_idx" ON "wa_group_option_settings" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "reservation_option_events" ADD CONSTRAINT "reservation_option_events_actor_admin_id_admin_users_id_fk" FOREIGN KEY ("actor_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_options" ADD CONSTRAINT "reservation_options_guests" CHECK (("reservation_options"."adults" is null or "reservation_options"."adults" between 1 and 50)
        and ("reservation_options"."children" is null or "reservation_options"."children" between 0 and 50));--> statement-breakpoint
ALTER TABLE "reservation_options" ADD CONSTRAINT "reservation_options_end_state" CHECK (("reservation_options"."status" = 'open' and "reservation_options"."ended_at" is null and "reservation_options"."end_reason" is null
            and "reservation_options"."converted_reservation_id" is null and "reservation_options"."ended_by_message_id" is null
            and "reservation_options"."ended_by_user_id" is null)
        or ("reservation_options"."status" = 'converted' and "reservation_options"."ended_at" is not null and "reservation_options"."converted_reservation_id" is not null
            and "reservation_options"."end_reason" in ('payment_received', 'confirmed_in_panel'))
        or ("reservation_options"."status" = 'cancelled' and "reservation_options"."ended_at" is not null and "reservation_options"."converted_reservation_id" is null
            and "reservation_options"."end_reason" in ('customer_declined', 'owner_cancelled', 'panel_cancel'))
        or ("reservation_options"."status" = 'expired' and "reservation_options"."ended_at" is not null and "reservation_options"."converted_reservation_id" is null
            and "reservation_options"."expires_at" is not null and "reservation_options"."end_reason" in ('expired')));