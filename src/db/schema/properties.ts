import { sql } from "drizzle-orm";
import {
  char,
  check,
  index,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { PROPERTY_LIMITS, PROPERTY_STATUSES, PROPERTY_TYPES } from "../../lib/property-meta";

import { users } from "./auth";
import { workspaces } from "./tenancy";

/**
 * Mülkler (Aşama 2.4b). Tenant tablosu: workspace_id + ENABLE/FORCE RLS.
 *
 * RLS, yetkiler, paket limiti tetikleyicisi ve updated_at tetikleyicisi elle yazılan
 * migration'dadır (drizzle/0010_properties_security.sql). Silme yoktur; yalnız pasife alma.
 * Aktif ve pasif tüm mülkler paket limitine dahildir.
 */

export {
  PROPERTY_LIMITS,
  PROPERTY_STATUSES,
  PROPERTY_TYPES,
  type PropertyStatus,
  type PropertyType,
} from "../../lib/property-meta";

export const properties = pgTable(
  "properties",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    name: text().notNull(),
    propertyType: text({ enum: PROPERTY_TYPES }).notNull(),
    description: text(),
    status: text({ enum: PROPERTY_STATUSES }).notNull().default("active"),
    maxGuests: smallint().notNull(),
    bedrooms: smallint().notNull(),
    bathrooms: smallint().notNull(),
    bedsDouble: smallint().notNull().default(0),
    bedsSingle: smallint().notNull().default(0),
    bedsSofa: smallint().notNull().default(0),
    countryCode: char({ length: 2 }).notNull().default("TR"),
    province: text().notNull(),
    district: text().notNull(),
    neighborhood: text(),
    addressLine: text(),
    postalCode: text(),
    latitude: numeric({ precision: 9, scale: 6 }),
    longitude: numeric({ precision: 9, scale: 6 }),
    // Kullanıcı silinince mülk kalır, oluşturan bilgisi NULL olur (KVKK silme akışını engellemez).
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    // Fotoğraflar (2.4c) gibi alt tablolar bileşik FK ile aynı işletmeye bağlanır.
    unique("properties_id_workspace_key").on(t.id, t.workspaceId),
    index("properties_workspace_status_idx").on(t.workspaceId, t.status),
    index("properties_created_by_idx").on(t.createdBy),
    check(
      "properties_name_length",
      sql`length(btrim(${t.name})) between ${sql.raw(String(PROPERTY_LIMITS.nameMin))} and ${sql.raw(String(PROPERTY_LIMITS.nameMax))}`,
    ),
    check("properties_type_check", sql`${t.propertyType} in ('villa', 'apart', 'bungalow', 'ev')`),
    check("properties_status_check", sql`${t.status} in ('active', 'passive')`),
    check(
      "properties_description_length",
      sql`${t.description} is null or length(${t.description}) <= ${sql.raw(String(PROPERTY_LIMITS.descriptionMax))}`,
    ),
    check("properties_max_guests_range", sql`${t.maxGuests} between 1 and 50`),
    check(
      "properties_rooms_range",
      sql`${t.bedrooms} between 0 and 50 and ${t.bathrooms} between 0 and 50`,
    ),
    check(
      "properties_beds_range",
      sql`${t.bedsDouble} between 0 and 50 and ${t.bedsSingle} between 0 and 50 and ${t.bedsSofa} between 0 and 50`,
    ),
    check("properties_country_code_format", sql`${t.countryCode} ~ '^[A-Z]{2}$'`),
    check(
      "properties_place_length",
      sql`length(btrim(${t.province})) between 2 and 60 and length(btrim(${t.district})) between 2 and 60`,
    ),
    check(
      "properties_address_length",
      sql`(${t.neighborhood} is null or length(${t.neighborhood}) <= 120) and (${t.addressLine} is null or length(${t.addressLine}) <= 300)`,
    ),
    check(
      "properties_postal_code_format",
      sql`${t.postalCode} is null or ${t.postalCode} ~ '^[0-9]{5}$'`,
    ),
    check(
      "properties_coordinates",
      sql`(${t.latitude} is null) = (${t.longitude} is null) and (${t.latitude} is null or (${t.latitude} between -90 and 90 and ${t.longitude} between -180 and 180))`,
    ),
  ],
);
