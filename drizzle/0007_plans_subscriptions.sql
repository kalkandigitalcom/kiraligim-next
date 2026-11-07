CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"max_properties" integer NOT NULL,
	"trial_days" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_code_format" CHECK ("plans"."code" ~ '^[a-z][a-z0-9_]{1,31}$'),
	CONSTRAINT "plans_name_length" CHECK (length(btrim("plans"."name")) between 2 and 60),
	CONSTRAINT "plans_max_properties_range" CHECK ("plans"."max_properties" between 0 and 10000),
	CONSTRAINT "plans_trial_days_range" CHECK ("plans"."trial_days" between 0 and 90),
	CONSTRAINT "plans_default_is_active" CHECK (not "plans"."is_default" or "plans"."is_active")
);
--> statement-breakpoint
CREATE TABLE "workspace_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" text NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_subscriptions_status_check" CHECK ("workspace_subscriptions"."status" in ('trialing', 'active', 'expired', 'canceled')),
	CONSTRAINT "workspace_subscriptions_trial_end_required" CHECK ("workspace_subscriptions"."status" <> 'trialing' or "workspace_subscriptions"."trial_ends_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "workspace_subscriptions" ADD CONSTRAINT "workspace_subscriptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_subscriptions" ADD CONSTRAINT "workspace_subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plans_code_key" ON "plans" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "plans_single_default_idx" ON "plans" USING btree ("is_default") WHERE "plans"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_subscriptions_workspace_id_key" ON "workspace_subscriptions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_subscriptions_plan_id_idx" ON "workspace_subscriptions" USING btree ("plan_id");