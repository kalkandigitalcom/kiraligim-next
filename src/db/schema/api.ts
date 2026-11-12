import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  jsonb,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
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
    /**
     * 5. adım: hesap geneli değişiklik akışının cursor anahtarı (rastgele). Hesap cursor'ı bununla
     * HMAC-SHA256 ile imzalanır; başka hesapta geçersizdir. Hiçbir yanıtta dönmez.
     */
    cursorKey: text()
      .notNull()
      .default(sql`gen_random_uuid()::text`),
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

/**
 * 2. aşama, 1. adım — takvim değişikliği yakalama (drizzle/0053, 0054).
 *
 * Takvimi etkileyen her yazma (rezervasyon/blok, harici takvim olayı ve kaynağı, villa ve işletme
 * durumu) AYNI transaction içinde buraya "bu villanın bu aralığı değişti" satırı bırakır. Satırı
 * yalnız tetikleyiciler yazar (SECURITY DEFINER, yalnız INSERT; hesaplama ve kilit yok). Geri alınan
 * yazmanın satırı da geri alınır. Satırda kişisel veri, kaynak adı, tutar veya kayıt kimliği yoktur.
 *
 * Sonraki adımdaki tek işlemci satırları villa başına birleştirip güncel doluluğu hesaplar ve
 * siler; işlenemezse attempts / next_attempt_at / last_error ile yeniden dener.
 */
export const API_CALENDAR_DIRTY_REASONS = [
  "reservation",
  "external_event",
  "external_source",
  "property_status",
  "workspace_status",
] as const;

export const apiCalendarDirty = pgTable(
  "api_calendar_dirty",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    /** Yabancı anahtar YOK: tetikleyici üst satırda kilit almaz; işlemci olmayan villayı atlar. */
    propertyId: uuid().notNull(),
    /** Değişen aralık [startDate, endDate) — rezervasyonlarla aynı kural (çıkış günü hariç). */
    startDate: date({ mode: "string" }).notNull(),
    endDate: date({ mode: "string" }).notNull(),
    reason: text({ enum: API_CALENDAR_DIRTY_REASONS }).notNull(),
    attempts: integer().notNull().default(0),
    nextAttemptAt: ts(),
    lastError: text(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [
    index("api_calendar_dirty_property_idx").on(t.propertyId, t.id),
    check("api_calendar_dirty_range_check", sql`${t.endDate} > ${t.startDate}`),
    check(
      "api_calendar_dirty_reason_check",
      sql`${t.reason} in ('reservation', 'external_event', 'external_source', 'property_status', 'workspace_status')`,
    ),
    check("api_calendar_dirty_attempts_check", sql`${t.attempts} >= 0`),
    check(
      "api_calendar_dirty_last_error_format",
      sql`${t.lastError} is null or ${t.lastError} ~ '^[a-z0-9_]{1,64}$'`,
    ),
  ],
);

/**
 * 2. aşama, 2. adım — takvim bağlantıları (drizzle/0055, 0056).
 *
 * Acente, API erişim izni olan villayı kendi yazılımındaki villa kimliğiyle (external_property_id)
 * bağlar. İzin etkinse bağlantı doğrudan "active" olur (ikinci sahip onayı yok). Bağlantı yalnız
 * app_api_* fonksiyonlarıyla okunur/yazılır; uygulama rollerinin doğrudan erişimi yoktur.
 *
 *  - Aynı acentede aynı villanın ve aynı external_property_id'nin tek ETKİN bağlantısı olur.
 *  - Saklanan durum yalnız active / disconnected (acente kesti) / revoked (izin kaldırıldı).
 *    "paused" SAKLANMAZ: villa veya işletme etkin değilken etkin bağlantı API'de paused görünür.
 *  - Yeniden bağlanma her zaman yeni satırdır; bitmiş bağlantılar geçmiş olarak kalır.
 *  - last_synced_at sonraki adımlarda (snapshot / değişiklikler / webhook) güncellenir.
 */
export const API_CONNECTION_STATUSES = ["active", "disconnected", "revoked"] as const;

export const apiCalendarConnections = pgTable(
  "api_calendar_connections",
  {
    id: uuid().primaryKey(),
    clientId: uuid()
      .notNull()
      .references(() => apiClients.id, { onDelete: "cascade" }),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    propertyId: uuid().notNull(),
    /** Bağlantı kurulurken kullanılan izin. İzin kaldırılınca bağlantı "revoked" olur. */
    grantId: uuid()
      .notNull()
      .references(() => apiAccessGrants.id, { onDelete: "restrict" }),
    /** Acentenin kendi yazılımındaki villa kimliği (büyük/küçük harf duyarlı). */
    externalPropertyId: text().notNull(),
    status: text({ enum: API_CONNECTION_STATUSES }).notNull().default("active"),
    endReason: text({ enum: ["agency", "grant_revoked"] }),
    createdAt: ts().notNull().defaultNow(),
    endedAt: ts(),
    lastSyncedAt: ts(),
    /**
     * 5. adım: son snapshot'ın cursor'ı (değişiklik kimliği). Hesap geneli akış ve webhook, bu
     * kimlikten SONRAKİ değişiklikleri verir: snapshot'tan eski bir değişiklik snapshot'ın üzerine
     * uygulanıp takvimi geri götüremez. Snapshot alınmamış bağlantıya webhook gitmez.
     */
    snapshotChangeId: bigint({ mode: "number" }),
    /**
     * 3. adım: bağlantıya özel cursor anahtarı (rastgele). Cursor bununla imzalanır; başka
     * bağlantının veya değiştirilmiş cursor kabul edilmez. API yanıtlarında hiçbir zaman dönmez.
     */
    cursorKey: text()
      .notNull()
      .default(sql`gen_random_uuid()::text`),
  },
  (t) => [
    foreignKey({
      name: "api_calendar_connections_property_fk",
      columns: [t.propertyId, t.workspaceId],
      foreignColumns: [properties.id, properties.workspaceId],
    }).onDelete("restrict"),
    uniqueIndex("api_calendar_connections_active_property_key")
      .on(t.clientId, t.propertyId)
      .where(sql`${t.status} = 'active'`),
    uniqueIndex("api_calendar_connections_active_external_key")
      .on(t.clientId, t.externalPropertyId)
      .where(sql`${t.status} = 'active'`),
    index("api_calendar_connections_client_idx").on(t.clientId, t.id),
    index("api_calendar_connections_property_idx").on(t.propertyId, t.status),
    index("api_calendar_connections_grant_idx").on(t.grantId),
    index("api_calendar_connections_workspace_idx").on(t.workspaceId),
    check(
      "api_calendar_connections_status_check",
      sql`${t.status} in ('active', 'disconnected', 'revoked')`,
    ),
    check(
      "api_calendar_connections_external_id_format",
      sql`${t.externalPropertyId} ~ '^[!-~]([ -~]{0,98}[!-~])?$'`,
    ),
    check(
      "api_calendar_connections_end_consistent",
      sql`(${t.status} = 'active' and ${t.endedAt} is null and ${t.endReason} is null) or (${t.status} = 'disconnected' and ${t.endedAt} is not null and ${t.endReason} = 'agency') or (${t.status} = 'revoked' and ${t.endedAt} is not null and ${t.endReason} = 'grant_revoked')`,
    ),
  ],
);

/**
 * 2. aşama, 3. adım — snapshot ve cursor (drizzle/0057, 0058).
 *
 * api_sync_state (tek satır): değişiklik kaydının yazıcısı (işlemci, 4. adım) ile snapshot'ın
 * buluştuğu nokta. İşlemci transaction'ının İLK ifadesi bu satırı UPDATE ile kilitler ve
 * değişiklikleri yazdıktan sonra last_change_id'yi aynı transaction'da günceller; snapshot bu
 * satırı FOR SHARE ile kilitler, ardından cursor (last_change_id) ve dolu aralıkları TEK SQL
 * ifadesinde okur. İkisi birbirini bekler; snapshot'ın gördüğü veri anı cursor'la aynıdır.
 * pruned_through_id: 30 günlük saklama sonucu bu kimliğe kadar (dahil) kayıtlar silinmiş olabilir.
 *
 * api_calendar_changes: sıralı değişiklik kaydı. Her satır "bu villanın [start_date, end_date)
 * aralığındaki doluluk şu" der (busy: [{start_date, end_date}], aralığa kırpılmış). Uygulamak
 * yerine koymadır; aynı kaydı iki kez uygulamak sonucu değiştirmez. Misafir, kaynak, tutar veya
 * kayıt kimliği yoktur. Kimlikleri yalnız işlemci (tek yazıcı, satır kilidi altında) atar.
 */
export const apiSyncState = pgTable(
  "api_sync_state",
  {
    id: smallint().primaryKey(),
    lastChangeId: bigint({ mode: "number" }).notNull().default(0),
    prunedThroughId: bigint({ mode: "number" }).notNull().default(0),
    updatedAt: ts().notNull().defaultNow(),
  },
  (t) => [
    check("api_sync_state_singleton", sql`${t.id} = 1`),
    check(
      "api_sync_state_ids_check",
      sql`${t.lastChangeId} >= 0 and ${t.prunedThroughId} >= 0 and ${t.prunedThroughId} <= ${t.lastChangeId}`,
    ),
  ],
);

export const apiCalendarChanges = pgTable(
  "api_calendar_changes",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    propertyId: uuid().notNull(),
    startDate: date({ mode: "string" }).notNull(),
    endDate: date({ mode: "string" }).notNull(),
    /** [{start_date, end_date}] — aralık içindeki dolu bölümler; kalanı boş. */
    busy: jsonb().$type<{ start_date: string; end_date: string }[]>().notNull(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [
    index("api_calendar_changes_property_idx").on(t.propertyId, t.id),
    index("api_calendar_changes_created_idx").on(t.createdAt),
    check("api_calendar_changes_range_check", sql`${t.endDate} > ${t.startDate}`),
    check("api_calendar_changes_busy_array", sql`jsonb_typeof(${t.busy}) = 'array'`),
  ],
);

/**
 * 2. aşama, 5. adım — webhook (drizzle/0060, 0061).
 *
 * api_webhook_endpoints: acente başına tek adres (yalnız HTTPS). İmza sırrı uygulamada AES-256-GCM
 * ile şifrelenir (API_WEBHOOK_SECRET_KEY, veritabanında yok); açık hâli yalnız oluşturma/yenileme
 * yanıtında bir kez döner.
 *
 * api_webhook_deliveries: her (bağlantı, değişiklik) için tek teslim kaydı; kimliği olay kimliğidir
 * ve yeniden denemelerde değişmez. Değişiklik kaydıyla AYNI transaction'da (işlemci) oluşur.
 * Bağlantı başına sıra: yalnız en eski bekleyen kayıt gönderilir. En az bir kez: kilit süresi
 * dolan gönderim aynı olay kimliğiyle yeniden denenir. Gövde ve yanıt saklanmaz.
 */
export const API_DELIVERY_STATUSES = ["pending", "delivered", "failed", "cancelled"] as const;

export const apiWebhookEndpoints = pgTable(
  "api_webhook_endpoints",
  {
    clientId: uuid()
      .primaryKey()
      .references(() => apiClients.id, { onDelete: "cascade" }),
    url: text().notNull(),
    /** AES-256-GCM ("v1:iv:etiket:şifreli", base64url). */
    secretEnc: text().notNull(),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts().notNull().defaultNow(),
    secretRotatedAt: ts().notNull().defaultNow(),
  },
  (t) => [
    check(
      "api_webhook_endpoints_url_format",
      sql`${t.url} ~ '^https://[^/@[:space:]]+(/[^[:space:]]*)?$' and length(${t.url}) <= 2048`,
    ),
    check(
      "api_webhook_endpoints_secret_format",
      sql`${t.secretEnc} ~ '^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$'`,
    ),
  ],
);

export const apiWebhookDeliveries = pgTable(
  "api_webhook_deliveries",
  {
    /** Olay kimliği (Kiraligim-Event-Id); yeniden denemelerde aynı. */
    id: uuid().primaryKey(),
    clientId: uuid()
      .notNull()
      .references(() => apiClients.id, { onDelete: "cascade" }),
    connectionId: uuid()
      .notNull()
      .references(() => apiCalendarConnections.id, { onDelete: "cascade" }),
    changeId: bigint({ mode: "number" }).notNull(),
    status: text({ enum: API_DELIVERY_STATUSES }).notNull().default("pending"),
    attempts: integer().notNull().default(0),
    nextAttemptAt: ts().notNull().defaultNow(),
    leaseToken: uuid(),
    leaseUntil: ts(),
    lastStatus: integer(),
    lastError: text(),
    cancelReason: text(),
    createdAt: ts().notNull().defaultNow(),
    finishedAt: ts(),
  },
  (t) => [
    uniqueIndex("api_webhook_deliveries_connection_change_key").on(t.connectionId, t.changeId),
    index("api_webhook_deliveries_pending_idx")
      .on(t.connectionId, t.changeId)
      .where(sql`${t.status} = 'pending'`),
    index("api_webhook_deliveries_client_idx").on(t.clientId, t.status),
    index("api_webhook_deliveries_created_idx").on(t.createdAt),
    check(
      "api_webhook_deliveries_status_check",
      sql`${t.status} in ('pending', 'delivered', 'failed', 'cancelled')`,
    ),
    check(
      "api_webhook_deliveries_finished_consistent",
      sql`(${t.status} = 'pending') = (${t.finishedAt} is null)`,
    ),
    check(
      "api_webhook_deliveries_codes_format",
      sql`(${t.lastError} is null or ${t.lastError} ~ '^[a-z0-9_]{1,64}$') and (${t.cancelReason} is null or ${t.cancelReason} ~ '^[a-z0-9_]{1,64}$')`,
    ),
    check("api_webhook_deliveries_attempts_check", sql`${t.attempts} >= 0`),
  ],
);
