import { type AnyColumn, sql } from "drizzle-orm";
import {
  boolean,
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

/** Havuz yoksa ölçüler NULL; varsa üç ölçü dolu ve aralıkta (property-meta PROPERTY_LIMITS). */
const poolCheck = (has: AnyColumn, depth: AnyColumn, width: AnyColumn, length: AnyColumn) => {
  const L = PROPERTY_LIMITS;
  const n = (v: number) => sql.raw(String(v));
  return sql`case when ${has} then ${depth} is not null and ${width} is not null and ${length} is not null and ${depth} between ${n(L.poolDepthMin)} and ${n(L.poolDepthMax)} and ${width} between ${n(L.poolSideMin)} and ${n(L.poolSideMax)} and ${length} between ${n(L.poolSideMin)} and ${n(L.poolSideMax)} else ${depth} is null and ${width} is null and ${length} is null end`;
};

export const properties = pgTable(
  "properties",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    name: text().notNull(),
    propertyType: text({ enum: PROPERTY_TYPES }).notNull(),
    /** Düz metin açıklama (arama, liste ve eski kayıtlar için). */
    description: text(),
    /** Biçimlendirilmiş açıklama: sunucuda temizlenmiş HTML (p, br, strong, em, u, a). NULL ise
     *  eski kayıt: gösterimde düz metin açıklamadan üretilir. */
    descriptionHtml: text(),
    /** T.C. Kültür ve Turizm Bakanlığı belge numarası (isteğe bağlı). */
    tourismLicenseNo: text(),
    /** YouTube video kimlikleri (11 karakter), sırayla. */
    youtubeVideoIds: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
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
    // Havuzlar: var/yok + ölçüler (metre). Yoksa ölçüler NULL; varsa üçü de dolu.
    poolSwimming: boolean().notNull().default(false),
    poolSwimmingDepth: numeric({ precision: 5, scale: 2 }),
    poolSwimmingWidth: numeric({ precision: 5, scale: 2 }),
    poolSwimmingLength: numeric({ precision: 5, scale: 2 }),
    /** Korunaklı (çitli / güvenlikli) havuz — yalnız yüzme havuzu için. */
    poolSwimmingProtected: boolean().notNull().default(false),
    poolIndoor: boolean().notNull().default(false),
    poolIndoorDepth: numeric({ precision: 5, scale: 2 }),
    poolIndoorWidth: numeric({ precision: 5, scale: 2 }),
    poolIndoorLength: numeric({ precision: 5, scale: 2 }),
    poolKids: boolean().notNull().default(false),
    poolKidsDepth: numeric({ precision: 5, scale: 2 }),
    poolKidsWidth: numeric({ precision: 5, scale: 2 }),
    poolKidsLength: numeric({ precision: 5, scale: 2 }),
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
      "properties_description_html_length",
      sql`${t.descriptionHtml} is null or length(${t.descriptionHtml}) <= ${sql.raw(String(PROPERTY_LIMITS.descriptionHtmlMax))}`,
    ),
    check(
      "properties_tourism_license_format",
      sql`${t.tourismLicenseNo} is null or (length(${t.tourismLicenseNo}) between 1 and ${sql.raw(String(PROPERTY_LIMITS.licenseMax))} and ${t.tourismLicenseNo} !~ '[[:cntrl:]<>]')`,
    ),
    check(
      "properties_youtube_video_ids",
      sql`cardinality(${t.youtubeVideoIds}) <= ${sql.raw(String(PROPERTY_LIMITS.youtubeMax))} and array_position(${t.youtubeVideoIds}, null) is null and (cardinality(${t.youtubeVideoIds}) = 0 or array_to_string(${t.youtubeVideoIds}, ',') ~ '^[A-Za-z0-9_-]{11}(,[A-Za-z0-9_-]{11})*$')`,
    ),
    check(
      "properties_pool_swimming",
      poolCheck(t.poolSwimming, t.poolSwimmingDepth, t.poolSwimmingWidth, t.poolSwimmingLength),
    ),
    check(
      "properties_pool_indoor",
      poolCheck(t.poolIndoor, t.poolIndoorDepth, t.poolIndoorWidth, t.poolIndoorLength),
    ),
    check(
      "properties_pool_kids",
      poolCheck(t.poolKids, t.poolKidsDepth, t.poolKidsWidth, t.poolKidsLength),
    ),
    check(
      "properties_pool_swimming_protected",
      sql`${t.poolSwimming} or not ${t.poolSwimmingProtected}`,
    ),
    check(
      "properties_coordinates",
      sql`(${t.latitude} is null) = (${t.longitude} is null) and (${t.latitude} is null or (${t.latitude} between -90 and 90 and ${t.longitude} between -180 and 180))`,
    ),
  ],
);
