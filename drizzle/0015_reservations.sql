CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"source" text,
	"check_in" date NOT NULL,
	"check_out" date NOT NULL,
	"guest_name" text,
	"guest_phone" text,
	"guest_email" text,
	"adults" smallint,
	"children" smallint,
	"total_amount_minor" bigint,
	"deposit_amount_minor" bigint,
	"currency" char(3),
	"balance_amount_minor" bigint GENERATED ALWAYS AS (total_amount_minor - coalesce(deposit_amount_minor, 0)) STORED,
	"note" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservations_kind_check" CHECK ("reservations"."kind" in ('reservation', 'block')),
	CONSTRAINT "reservations_status_check" CHECK ("reservations"."status" in ('pending', 'confirmed', 'cancelled')),
	CONSTRAINT "reservations_source_check" CHECK ("reservations"."source" is null or "reservations"."source" in ('direct', 'phone', 'airbnb', 'booking', 'other')),
	CONSTRAINT "reservations_dates" CHECK ("reservations"."check_out" > "reservations"."check_in" and "reservations"."check_out" - "reservations"."check_in" <= 365),
	CONSTRAINT "reservations_reservation_fields" CHECK ("reservations"."kind" <> 'reservation' or ("reservations"."guest_name" is not null and "reservations"."source" is not null and "reservations"."adults" is not null and "reservations"."children" is not null)),
	CONSTRAINT "reservations_block_fields" CHECK ("reservations"."kind" <> 'block' or ("reservations"."status" <> 'pending' and "reservations"."guest_name" is null and "reservations"."guest_phone" is null and "reservations"."guest_email" is null and "reservations"."source" is null and "reservations"."adults" is null and "reservations"."children" is null and "reservations"."total_amount_minor" is null and "reservations"."deposit_amount_minor" is null and "reservations"."currency" is null)),
	CONSTRAINT "reservations_guest_name_length" CHECK ("reservations"."guest_name" is null or length(btrim("reservations"."guest_name")) between 2 and 120),
	CONSTRAINT "reservations_guest_phone_format" CHECK ("reservations"."guest_phone" is null or "reservations"."guest_phone" ~ '^\+?[0-9][0-9 ()-]{5,18}[0-9]$'),
	CONSTRAINT "reservations_guest_email_format" CHECK ("reservations"."guest_email" is null or (length("reservations"."guest_email") <= 254 and "reservations"."guest_email" ~ '^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$')),
	CONSTRAINT "reservations_guests_range" CHECK (("reservations"."adults" is null or "reservations"."adults" between 1 and 50) and ("reservations"."children" is null or "reservations"."children" between 0 and 50)),
	CONSTRAINT "reservations_amounts" CHECK (("reservations"."total_amount_minor" is null or "reservations"."total_amount_minor" between 0 and 999999999999) and ("reservations"."deposit_amount_minor" is null or ("reservations"."deposit_amount_minor" >= 0 and "reservations"."total_amount_minor" is not null and "reservations"."deposit_amount_minor" <= "reservations"."total_amount_minor")) and (("reservations"."total_amount_minor" is null) = ("reservations"."currency" is null))),
	CONSTRAINT "reservations_currency_check" CHECK ("reservations"."currency" is null or "reservations"."currency" in ('TRY', 'EUR', 'USD', 'GBP')),
	CONSTRAINT "reservations_note_length" CHECK ("reservations"."note" is null or length("reservations"."note") <= 2000),
	CONSTRAINT "reservations_cancellation" CHECK (("reservations"."status" = 'cancelled') = ("reservations"."cancelled_at" is not null) and ("reservations"."status" = 'cancelled' or ("reservations"."cancelled_by" is null and "reservations"."cancel_reason" is null)) and ("reservations"."cancel_reason" is null or length("reservations"."cancel_reason") <= 500))
);
--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_property_fk" FOREIGN KEY ("property_id","workspace_id") REFERENCES "public"."properties"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reservations_workspace_check_in_idx" ON "reservations" USING btree ("workspace_id","check_in");--> statement-breakpoint
CREATE INDEX "reservations_property_check_in_idx" ON "reservations" USING btree ("property_id","check_in");--> statement-breakpoint
CREATE INDEX "reservations_created_by_idx" ON "reservations" USING btree ("created_by");