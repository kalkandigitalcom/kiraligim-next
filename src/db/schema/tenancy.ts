import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { WHATSAPP_PATTERN } from "../../lib/public-profile-meta";

import { users } from "./auth";

/**
 * İşletme hesabı (workspace) ve üyelikler.
 *
 * RLS (ENABLE + FORCE), politikalar, yetkiler ve tetikleyiciler elle yazılan migration'dadır
 * (drizzle/0006_tenancy_security.sql). Bu tablolar yalnız src/db/tenant.ts üzerinden
 * (withUser / withTenant / createWorkspace) kullanılır.
 */

export const WORKSPACE_STATUSES = ["active", "suspended"] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

export const MEMBER_ROLES = ["owner", "manager", "staff"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** 3–48 karakter: küçük harf, rakam, tire; tire ile başlamaz/bitmez. */
export const WORKSPACE_SLUG_PATTERN = "^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$";

const timestamps = {
  createdAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
};

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid().primaryKey(),
    name: text().notNull(),
    slug: text().notNull(),
    status: text({ enum: WORKSPACE_STATUSES }).notNull().default("active"),
    /** Müşteriye açık villa sayfalarındaki WhatsApp iletişim numarası (+905321234567); yalnız owner. */
    contactWhatsapp: text(),
    createdBy: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (t) => [
    unique("workspaces_slug_key").on(t.slug),
    check("workspaces_name_length", sql`length(btrim(${t.name})) between 2 and 120`),
    check("workspaces_slug_format", sql`${t.slug} ~ '^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$'`),
    check("workspaces_status_check", sql`${t.status} in ('active', 'suspended')`),
    check(
      "workspaces_contact_whatsapp_format",
      sql`${t.contactWhatsapp} is null or ${t.contactWhatsapp} ~ '${sql.raw(WHATSAPP_PATTERN)}'`,
    ),
  ],
);

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text({ enum: MEMBER_ROLES }).notNull(),
    ...timestamps,
  },
  (t) => [
    unique("workspace_members_workspace_user_key").on(t.workspaceId, t.userId),
    index("workspace_members_user_id_idx").on(t.userId),
    check("workspace_members_role_check", sql`${t.role} in ('owner', 'manager', 'staff')`),
  ],
);
