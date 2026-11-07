import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { workspaces } from "./tenancy";

/**
 * Paketler ve işletme abonelikleri (Aşama 2.4a).
 *
 * - `plans`: genel paket kataloğu (tenant verisi değil). Değerler migration ile tanımlanır;
 *   app_user yalnız okur. Yönetim arayüzü Super Admin aşamasında gelecek.
 * - `workspace_subscriptions`: işletme başına TEK güncel abonelik. Uygulama yazamaz; her yeni
 *   işletme için `workspaces` üzerindeki tetikleyici aynı transaction'da deneme aboneliği açar.
 *
 * RLS, yetkiler, tetikleyici ve başlangıç paketi elle yazılan migration'dadır
 * (drizzle/0008_plans_security.sql).
 */

export const SUBSCRIPTION_STATUSES = ["trialing", "active", "expired", "canceled"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

const timestamps = {
  createdAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
};

export const plans = pgTable(
  "plans",
  {
    id: uuid().primaryKey(),
    code: text().notNull(),
    name: text().notNull(),
    maxProperties: integer().notNull(),
    trialDays: integer().notNull(),
    isActive: boolean().notNull().default(true),
    /** Yeni işletmelere otomatik atanan paket; en fazla bir tane (kısmi unique index). */
    isDefault: boolean().notNull().default(false),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("plans_code_key").on(t.code),
    uniqueIndex("plans_single_default_idx")
      .on(t.isDefault)
      .where(sql`${t.isDefault}`),
    check("plans_code_format", sql`${t.code} ~ '^[a-z][a-z0-9_]{1,31}$'`),
    check("plans_name_length", sql`length(btrim(${t.name})) between 2 and 60`),
    check("plans_max_properties_range", sql`${t.maxProperties} between 0 and 10000`),
    check("plans_trial_days_range", sql`${t.trialDays} between 0 and 90`),
    check("plans_default_is_active", sql`not ${t.isDefault} or ${t.isActive}`),
  ],
);

export const workspaceSubscriptions = pgTable(
  "workspace_subscriptions",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    planId: uuid()
      .notNull()
      .references(() => plans.id, { onDelete: "restrict" }),
    status: text({ enum: SUBSCRIPTION_STATUSES }).notNull(),
    trialEndsAt: timestamp({ withTimezone: true, mode: "date" }),
    currentPeriodEnd: timestamp({ withTimezone: true, mode: "date" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("workspace_subscriptions_workspace_id_key").on(t.workspaceId),
    index("workspace_subscriptions_plan_id_idx").on(t.planId),
    check(
      "workspace_subscriptions_status_check",
      sql`${t.status} in ('trialing', 'active', 'expired', 'canceled')`,
    ),
    check(
      "workspace_subscriptions_trial_end_required",
      sql`${t.status} <> 'trialing' or ${t.trialEndsAt} is not null`,
    ),
  ],
);
