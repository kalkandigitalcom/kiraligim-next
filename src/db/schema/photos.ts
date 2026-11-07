import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { PHOTO_LIMITS } from "../../lib/photo-meta";
import { users } from "./auth";
import { properties } from "./properties";
import { workspaces } from "./tenancy";

/**
 * Mülk fotoğrafları (Aşama 2.4c). Tenant tablosu: workspace_id + ENABLE/FORCE RLS.
 *
 * - Yalnız işlenmiş WebP varyantlarının (400/1200/2000 px) yeri ve boyutu tutulur; orijinal dosya,
 *   dosya adı ve görsel metadata'sı HİÇBİR yerde saklanmaz.
 * - (property_id, workspace_id) bileşik FK: fotoğraf yalnız aynı işletmenin mülküne bağlanabilir.
 * - Mülk başına 80 sınırı, sıra ve kapak ataması BEFORE INSERT tetikleyicisinde, mülk başına kilitle
 *   (drizzle/0012_property_photos_security.sql).
 */
export const propertyPhotos = pgTable(
  "property_photos",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    propertyId: uuid().notNull(),
    /** R2 nesne öneki: w/{workspace}/p/{property}/{photo} → /{400|1200|2000}.webp */
    storagePrefix: text().notNull(),
    width: integer().notNull(),
    height: integer().notNull(),
    /** Varyantlarda kullanılan en düşük WebP kalitesi (5 MB sınırı için düşürülmüş olabilir). */
    quality: smallint().notNull(),
    bytes400: integer("bytes_400").notNull(),
    bytes1200: integer("bytes_1200").notNull(),
    bytes2000: integer("bytes_2000").notNull(),
    sortOrder: integer().notNull().default(0),
    isCover: boolean().notNull().default(false),
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "property_photos_property_fk",
      columns: [t.propertyId, t.workspaceId],
      foreignColumns: [properties.id, properties.workspaceId],
    }).onDelete("restrict"),
    uniqueIndex("property_photos_storage_prefix_key").on(t.storagePrefix),
    uniqueIndex("property_photos_single_cover_idx")
      .on(t.propertyId)
      .where(sql`${t.isCover}`),
    index("property_photos_property_order_idx").on(t.propertyId, t.sortOrder),
    index("property_photos_workspace_idx").on(t.workspaceId),
    check(
      "property_photos_storage_prefix_format",
      sql`${t.storagePrefix} ~ '^w/[0-9a-f-]{36}/p/[0-9a-f-]{36}/[0-9a-f-]{36}$'`,
    ),
    check(
      "property_photos_dimensions",
      sql`${t.width} between 1 and ${sql.raw(String(PHOTO_LIMITS.maxWidth))} and ${t.height} between 1 and ${sql.raw(String(PHOTO_LIMITS.maxDimension))}`,
    ),
    check("property_photos_quality_range", sql`${t.quality} between 50 and 90`),
    check(
      "property_photos_variant_bytes",
      sql`${t.bytes400} between 1 and ${sql.raw(String(PHOTO_LIMITS.maxVariantBytes))} and ${t.bytes1200} between 1 and ${sql.raw(String(PHOTO_LIMITS.maxVariantBytes))} and ${t.bytes2000} between 1 and ${sql.raw(String(PHOTO_LIMITS.maxVariantBytes))}`,
    ),
    check("property_photos_sort_order_range", sql`${t.sortOrder} >= 0`),
  ],
);
