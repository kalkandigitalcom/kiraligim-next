CREATE TABLE "wa_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"status" text DEFAULT 'connecting' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_connected_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_connections_label_key" UNIQUE("label"),
	CONSTRAINT "wa_connections_label_format" CHECK ("wa_connections"."label" ~ '^[a-z0-9_-]{1,40}$'),
	CONSTRAINT "wa_connections_status_check" CHECK ("wa_connections"."status" in ('connecting', 'open', 'closed', 'logged_out')),
	CONSTRAINT "wa_connections_error_format" CHECK ("wa_connections"."last_error_code" is null or "wa_connections"."last_error_code" ~ '^[a-z0-9_]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "wa_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"jid" text NOT NULL,
	"subject" text,
	"participant_count" integer DEFAULT 0 NOT NULL,
	"bot_is_admin" boolean DEFAULT false NOT NULL,
	"admins_only" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'discovered' NOT NULL,
	"workspace_id" uuid,
	"linked_at" timestamp with time zone,
	"linked_by" uuid,
	"link_fail_count" integer DEFAULT 0 NOT NULL,
	"link_fail_window_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_groups_connection_jid_key" UNIQUE("connection_id","jid"),
	CONSTRAINT "wa_groups_scope_key" UNIQUE("id","workspace_id"),
	CONSTRAINT "wa_groups_jid_format" CHECK ("wa_groups"."jid" ~ '^[0-9]{6,40}(-[0-9]{6,20})?@g\.us$'),
	CONSTRAINT "wa_groups_status_check" CHECK ("wa_groups"."status" in ('discovered', 'linked', 'suspended', 'left')),
	CONSTRAINT "wa_groups_status_workspace" CHECK (("wa_groups"."status" = 'discovered' and "wa_groups"."workspace_id" is null)
        or ("wa_groups"."status" in ('linked', 'suspended') and "wa_groups"."workspace_id" is not null)
        or "wa_groups"."status" = 'left'),
	CONSTRAINT "wa_groups_subject_length" CHECK ("wa_groups"."subject" is null or length("wa_groups"."subject") <= 200),
	CONSTRAINT "wa_groups_counts" CHECK ("wa_groups"."participant_count" >= 0 and "wa_groups"."link_fail_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "wa_inbound_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"wa_message_id" text NOT NULL,
	"sender_jid" text NOT NULL,
	"sender_pn" text,
	"sender_lid" text,
	"body" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"lock_token" uuid,
	CONSTRAINT "wa_inbound_messages_dedupe_key" UNIQUE("group_id","wa_message_id"),
	CONSTRAINT "wa_inbound_messages_kind_check" CHECK ("wa_inbound_messages"."kind" in ('live', 'backlog')),
	CONSTRAINT "wa_inbound_messages_status_check" CHECK ("wa_inbound_messages"."status" in ('received')),
	CONSTRAINT "wa_inbound_messages_lengths" CHECK (length("wa_inbound_messages"."body") between 1 and 4000 and length("wa_inbound_messages"."wa_message_id") between 1 and 128
        and length("wa_inbound_messages"."sender_jid") between 3 and 128),
	CONSTRAINT "wa_inbound_messages_sender_pn_format" CHECK ("wa_inbound_messages"."sender_pn" is null or "wa_inbound_messages"."sender_pn" ~ '^[1-9][0-9]{6,19}$')
);
--> statement-breakpoint
CREATE TABLE "wa_link_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"code_salt" text NOT NULL,
	"code_hash" text NOT NULL,
	"phone_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_group_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_link_codes_salt_format" CHECK ("wa_link_codes"."code_salt" ~ '^[0-9a-f]{32}$'),
	CONSTRAINT "wa_link_codes_hash_format" CHECK ("wa_link_codes"."code_hash" ~ '^[0-9a-f]{64}$' and "wa_link_codes"."phone_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "wa_link_codes_ttl" CHECK ("wa_link_codes"."expires_at" > "wa_link_codes"."created_at" and "wa_link_codes"."expires_at" <= "wa_link_codes"."created_at" + interval '15 minutes')
);
--> statement-breakpoint
CREATE TABLE "wa_link_managers" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_link_managers_pkey" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "wa_groups" ADD CONSTRAINT "wa_groups_connection_id_wa_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."wa_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_groups" ADD CONSTRAINT "wa_groups_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_groups" ADD CONSTRAINT "wa_groups_linked_by_users_id_fk" FOREIGN KEY ("linked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_inbound_messages" ADD CONSTRAINT "wa_inbound_messages_connection_id_wa_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."wa_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_inbound_messages" ADD CONSTRAINT "wa_inbound_messages_group_fk" FOREIGN KEY ("group_id","workspace_id") REFERENCES "public"."wa_groups"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_link_codes" ADD CONSTRAINT "wa_link_codes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_link_codes" ADD CONSTRAINT "wa_link_codes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_link_codes" ADD CONSTRAINT "wa_link_codes_used_group_id_wa_groups_id_fk" FOREIGN KEY ("used_group_id") REFERENCES "public"."wa_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_link_managers" ADD CONSTRAINT "wa_link_managers_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_link_managers" ADD CONSTRAINT "wa_link_managers_member_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."workspace_members"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wa_groups_workspace_idx" ON "wa_groups" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "wa_groups_linked_by_idx" ON "wa_groups" USING btree ("linked_by");--> statement-breakpoint
CREATE INDEX "wa_inbound_messages_queue_idx" ON "wa_inbound_messages" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "wa_inbound_messages_workspace_idx" ON "wa_inbound_messages" USING btree ("workspace_id","received_at");--> statement-breakpoint
CREATE INDEX "wa_inbound_messages_connection_idx" ON "wa_inbound_messages" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "wa_inbound_messages_received_idx" ON "wa_inbound_messages" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "wa_link_codes_workspace_idx" ON "wa_link_codes" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "wa_link_codes_created_by_idx" ON "wa_link_codes" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "wa_link_codes_used_group_idx" ON "wa_link_codes" USING btree ("used_group_id");--> statement-breakpoint
CREATE INDEX "wa_link_codes_active_idx" ON "wa_link_codes" USING btree ("expires_at") WHERE "wa_link_codes"."used_at" is null;--> statement-breakpoint
CREATE INDEX "wa_link_managers_user_idx" ON "wa_link_managers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "wa_link_managers_granted_by_idx" ON "wa_link_managers" USING btree ("granted_by");