import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { API_LIMITS } from "../../lib/api-meta";
import { adminUsers } from "./admin";
import { users } from "./auth";
import { properties } from "./properties";
import { workspaces } from "./tenancy";

/**
 * Acente okuma API'si — 1. aşama (drizzle/0051 tablolar, 0052 güvenlik ve fonksiyonlar).
 *
 * Mevcut villa, rezervasyon ve takvim tablolarına YAZILMAZ ve bu tablolar dışarı açılmaz. API
 * yalnız SECURITY DEFINER fonksiyonlarla (app_api_*) çalışır; hiçbir uygulama rolü bu tablolara
 * doğrudan erişemez. Fonksiyonlar her istekte anahtarı, hesabın durumunu ve villa iznini yeniden
 * denetler; yalnız izin verilen alanları (villa kimliği, adı, dolu aralıklar) döndürür.
 *
 *  - api_clients: acente hesabı (Super Admin oluşturur). Erişim kodu yalnız özetiyle saklanır.
 *  - api_keys: API anahtarları; yalnız SHA-256 özeti ve açık önek. Geri alınabilir.
 *  - api_access_grants: villa başına izin. Ev sahibi (kodla, onaylayarak) veya Super Admin verir;
 *    geri alınınca bir sonraki istekte etkisizdir. Aynı acente + villa için tek etkin izin.
 *  - api_rate_windows: anahtar başına dakikalık sayaç (birden çok uygulama örneği arasında ortak).
 *  - api_usage_daily: hesap başına günlük kullanım özeti (istek, sınır aşımı, hata). İstek
 *    içeriği, IP veya anahtar saklanmaz.
 */
const ts = () => timestamp({ withTimezone: true, mode: "date" });

export const apiClients = pgTable(
  "api_clients",
  {
    id: uuid().primaryKey(),
    name: text().notNull(),
    status: text({ enum: ["active", "disabled"] })
      .notNull()
      .default("active"),
    /** Dakikalık istek sınırı (anahtar başına). */
    rateLimitPerMinute: integer().notNull().default(API_LIMITS.ratePerMinute),
    /** Erişim kodunun SHA-256 özeti ("api-access-code:" + kod); kodun kendisi saklanmaz. */
    accessCodeHash: text(),
    /** Kodun son 4 karakteri (yalnız Super Admin ekranında tanıma için). */
    accessCodeHint: text(),
    accessCodeCreatedAt: ts(),
    createdByAdmin: uuid().references(() => adminUsers.id, { onDelete: "set null" }),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts().notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("api_clients_access_code_hash_key")
      .on(t.accessCodeHash)
      .where(sql`${t.accessCodeHash} is not null`),
    index("api_clients_created_by_admin_idx").on(t.createdByAdmin),
    check("api_clients_status_check", sql`${t.status} in ('active', 'disabled')`),
    check(
      "api_clients_name_length",
      sql`length(btrim(${t.name})) between 1 and ${sql.raw(String(API_LIMITS.clientNameMax))}`,
    ),
    check("api_clients_rate_limit_range", sql`${t.rateLimitPerMinute} between 1 and 10000`),
    check(
      "api_clients_access_code_format",
      sql`(${t.accessCodeHash} is null and ${t.accessCodeHint} is null and ${t.accessCodeCreatedAt} is null) or (${t.accessCodeHash} ~ '^[0-9a-f]{64}$' and ${t.accessCodeHint} ~ '^[A-Z2-9]{4}$' and ${t.accessCodeCreatedAt} is not null)`,
    ),
  ],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid().primaryKey(),
    clientId: uuid()
      .notNull()
      .references(() => apiClients.id, { onDelete: "cascade" }),
    /** Anahtarın açık öneki (kg_live_<önek>_…): listede tanıma için; gizli değildir. */
    prefix: text().notNull(),
    /** Tam anahtarın SHA-256 özeti (küçük harf hex). */
    secretHash: text().notNull(),
    label: text(),
    status: text({ enum: ["active", "revoked"] })
      .notNull()
      .default("active"),
    lastUsedAt: ts(),
    createdByAdmin: uuid().references(() => adminUsers.id, { onDelete: "set null" }),
    revokedByAdmin: uuid().references(() => adminUsers.id, { onDelete: "set null" }),
    createdAt: ts().notNull().defaultNow(),
    revokedAt: ts(),
  },
  (t) => [
    uniqueIndex("api_keys_secret_hash_key").on(t.secretHash),
    uniqueIndex("api_keys_prefix_key").on(t.prefix),
    index("api_keys_client_idx").on(t.clientId, t.status),
    index("api_keys_created_by_admin_idx").on(t.createdByAdmin),
    index("api_keys_revoked_by_admin_idx").on(t.revokedByAdmin),
    check("api_keys_status_check", sql`${t.status} in ('active', 'revoked')`),
    check(
      "api_keys_format",
      sql`${t.prefix} ~ '^[a-z2-7]{8}$' and ${t.secretHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "api_keys_label_length",
      sql`${t.label} is null or length(btrim(${t.label})) between 1 and ${sql.raw(String(API_LIMITS.keyLabelMax))}`,
    ),
    check(
      "api_keys_revoked_consistent",
      sql`(${t.status} = 'revoked') = (${t.revokedAt} is not null)`,
    ),
  ],
);

export const apiAccessGrants = pgTable(
  "api_access_grants",
  {
    id: uuid().primaryKey(),
    clientId: uuid()
      .notNull()
      .references(() => apiClients.id, { onDelete: "cascade" }),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    propertyId: uuid().notNull(),
    status: text({ enum: ["active", "revoked"] })
      .notNull()
      .default("active"),
    /** İzni veren: işletme kullanıcısı (kodla onay) ya da Super Admin — tam olarak biri. */
    grantedByUser: uuid().references(() => users.id, { onDelete: "set null" }),
    grantedByAdmin: uuid().references(() => adminUsers.id, { onDelete: "set null" }),
    grantedVia: text({ enum: ["owner", "admin"] }).notNull(),
    revokedByUser: uuid().references(() => users.id, { onDelete: "set null" }),
    revokedByAdmin: uuid().references(() => adminUsers.id, { onDelete: "set null" }),
    createdAt: ts().notNull().defaultNow(),
    revokedAt: ts(),
  },
  (t) => [
    foreignKey({
      name: "api_access_grants_property_fk",
      columns: [t.propertyId, t.workspaceId],
      foreignColumns: [properties.id, properties.workspaceId],
    }).onDelete("restrict"),
    uniqueIndex("api_access_grants_active_key")
      .on(t.clientId, t.propertyId)
      .where(sql`${t.status} = 'active'`),
    index("api_access_grants_client_idx").on(t.clientId, t.status, t.propertyId),
    index("api_access_grants_property_idx").on(t.propertyId, t.status),
    index("api_access_grants_workspace_idx").on(t.workspaceId),
    index("api_access_grants_granted_by_user_idx").on(t.grantedByUser),
    index("api_access_grants_granted_by_admin_idx").on(t.grantedByAdmin),
    index("api_access_grants_revoked_by_user_idx").on(t.revokedByUser),
    index("api_access_grants_revoked_by_admin_idx").on(t.revokedByAdmin),
    check("api_access_grants_status_check", sql`${t.status} in ('active', 'revoked')`),
    check("api_access_grants_via_check", sql`${t.grantedVia} in ('owner', 'admin')`),
    check(
      "api_access_grants_revoked_consistent",
      sql`(${t.status} = 'revoked') = (${t.revokedAt} is not null)`,
    ),
  ],
);

export const apiRateWindows = pgTable(
  "api_rate_windows",
  {
    keyId: uuid()
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    /** Dakikanın başlangıcı (UTC, saniyesiz). */
    windowStart: ts().notNull(),
    count: integer().notNull().default(0),
  },
  (t) => [
    primaryKey({ name: "api_rate_windows_pkey", columns: [t.keyId, t.windowStart] }),
    check("api_rate_windows_count_check", sql`${t.count} >= 0`),
  ],
);

export const apiUsageDaily = pgTable(
  "api_usage_daily",
  {
    clientId: uuid()
      .notNull()
      .references(() => apiClients.id, { onDelete: "cascade" }),
    /** Gün (Europe/Istanbul). */
    day: date({ mode: "string" }).notNull(),
    requests: integer().notNull().default(0),
    rateLimited: integer().notNull().default(0),
    errors: integer().notNull().default(0),
  },
  (t) => [
    primaryKey({ name: "api_usage_daily_pkey", columns: [t.clientId, t.day] }),
    check(
      "api_usage_daily_counts_check",
      sql`${t.requests} >= 0 and ${t.rateLimited} >= 0 and ${t.errors} >= 0`,
    ),
  ],
);
