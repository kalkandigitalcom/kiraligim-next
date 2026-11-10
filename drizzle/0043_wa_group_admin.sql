ALTER TABLE "wa_groups" ADD COLUMN "linked_by_admin" uuid;--> statement-breakpoint
ALTER TABLE "wa_groups" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wa_groups" ADD COLUMN "archived_by_admin" uuid;--> statement-breakpoint
ALTER TABLE "wa_groups" ADD CONSTRAINT "wa_groups_linked_by_admin_admin_users_id_fk" FOREIGN KEY ("linked_by_admin") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_groups" ADD CONSTRAINT "wa_groups_archived_by_admin_admin_users_id_fk" FOREIGN KEY ("archived_by_admin") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wa_groups_linked_by_admin_idx" ON "wa_groups" USING btree ("linked_by_admin");--> statement-breakpoint
CREATE INDEX "wa_groups_archived_by_admin_idx" ON "wa_groups" USING btree ("archived_by_admin");--> statement-breakpoint
CREATE INDEX "wa_groups_jid_idx" ON "wa_groups" USING btree ("jid");--> statement-breakpoint
ALTER TABLE "wa_groups" ADD CONSTRAINT "wa_groups_archived_discovered" CHECK ("wa_groups"."archived_at" is null or "wa_groups"."workspace_id" is null);