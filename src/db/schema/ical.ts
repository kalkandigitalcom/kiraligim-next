import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { ICAL_LIMITS as L } from "../../lib/ical-meta";
import { users } from "./auth";
import { properties } from "./properties";
import { workspaces } from "./tenancy";

/**
 * iCal entegrasyonu (Aşama 3.1). Tenant tabloları: workspace_id + ENABLE/FORCE RLS.
 *
 * Harici takvim verisi rezervasyon tablosundan AYRIDIR: kaynaktan gelen dolu aralıklar
 * external_calendar_events'te tutulur ve yalnız müsaitlik engeli olarak kullanılır (misafir,
 * tutar, durum akışı yok). Bir kaynak silinince yalnız onun olayları silinir (ON DELETE CASCADE).
 *
 * Elle yazılan migration'da (drizzle/0029_ical_security.sql):
 *  - RLS politikaları ve kolon yetkileri; olaylar ve senkron kayıtları yalnız SECURITY DEFINER
 *    fonksiyonlarla yazılır (app_ical_claim_sources / app_ical_apply_sync);
 *  - reservations üzerinde tetikleyici: yeni kayıt veya tarih değişikliği etkin harici dolulukla
 *    çakışırsa 23P01 (exclusion_violation) — mevcut çakışma hata yolu aynen kullanılır;
 *  - dışa aktarma akışı app_ical_export (yalnız rezervasyon + blok; harici olaylar okunmaz);
 *  - app_public_villa_busy harici dolulukları da içerecek şekilde yeniden tanımlanır.
 */

export const externalCalendarSources = pgTable(
  "external_calendar_sources",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    propertyId: uuid().notNull(),
    /** Kullanıcının verdiği ad (ör. "Airbnb"). */
    name: text().notNull(),
    /** Normalize edilmiş http(s) adresi; erişim anahtarı içerebilir, log'a yazılmaz. */
    url: text().notNull(),
    isActive: boolean().notNull().default(true),
    status: text({ enum: ["pending", "ok", "error"] })
      .notNull()
      .default("pending"),
    lastSyncedAt: timestamp({ withTimezone: true, mode: "date" }),
    lastSuccessAt: timestamp({ withTimezone: true, mode: "date" }),
    lastErrorCode: text(),
    /** Son başarılı senkronda etkin olay sayısı ve Kiraligim kayıtlarıyla çakışan olay sayısı. */
    eventCount: integer().notNull().default(0),
    conflictCount: integer().notNull().default(0),
    consecutiveFailures: integer().notNull().default(0),
    /** Eşzamanlı senkron kilidi (yalnız fonksiyonlar yazar). */
    lockedUntil: timestamp({ withTimezone: true, mode: "date" }),
    lockToken: uuid(),
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "external_calendar_sources_property_fk",
      columns: [t.propertyId, t.workspaceId],
      foreignColumns: [properties.id, properties.workspaceId],
    }).onDelete("restrict"),
    unique("external_calendar_sources_scope_key").on(t.id, t.workspaceId, t.propertyId),
    uniqueIndex("external_calendar_sources_property_name_key").on(
      t.propertyId,
      sql`lower(${t.name})`,
    ),
    index("external_calendar_sources_workspace_idx").on(t.workspaceId),
    index("external_calendar_sources_due_idx").on(t.isActive, t.lastSyncedAt),
    index("external_calendar_sources_created_by_idx").on(t.createdBy),
    check(
      "external_calendar_sources_name_length",
      sql`length(btrim(${t.name})) between ${sql.raw(String(L.nameMin))} and ${sql.raw(String(L.nameMax))}`,
    ),
    check(
      "external_calendar_sources_url_format",
      sql`length(${t.url}) <= ${sql.raw(String(L.urlMax))} and ${t.url} ~ '^https?://[^\\s]+$'`,
    ),
    check("external_calendar_sources_status_check", sql`${t.status} in ('pending', 'ok', 'error')`),
    check(
      "external_calendar_sources_error_code_format",
      sql`${t.lastErrorCode} is null or ${t.lastErrorCode} ~ '^[a-z_]{1,40}$'`,
    ),
    check(
      "external_calendar_sources_counts",
      sql`${t.eventCount} >= 0 and ${t.conflictCount} >= 0 and ${t.consecutiveFailures} >= 0`,
    ),
  ],
);

export const externalCalendarEvents = pgTable(
  "external_calendar_events",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid().notNull(),
    propertyId: uuid().notNull(),
    sourceId: uuid().notNull(),
    /** Akıştaki UID (yinelenen örneklerde RECURRENCE-ID eklenmiş hali). Özet/açıklama saklanmaz. */
    uid: text().notNull(),
    /** [başlangıç, bitiş) — iCal DTEND gibi bitiş hariçtir. */
    startDate: date({ mode: "string" }).notNull(),
    endDate: date({ mode: "string" }).notNull(),
    /** Son başarılı senkronda akışta yoksa false (kayıt silinmez; yalnız engel olmaktan çıkar). */
    isActive: boolean().notNull().default(true),
    firstSeenAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
    lastSeenAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
    createdAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    // Olay yalnız kendi kaynağının işletmesine ve mülküne bağlanabilir; kaynak silinince silinir.
    foreignKey({
      name: "external_calendar_events_source_fk",
      columns: [t.sourceId, t.workspaceId, t.propertyId],
      foreignColumns: [
        externalCalendarSources.id,
        externalCalendarSources.workspaceId,
        externalCalendarSources.propertyId,
      ],
    }).onDelete("cascade"),
    unique("external_calendar_events_source_uid_key").on(t.sourceId, t.uid),
    index("external_calendar_events_property_idx")
      .on(t.propertyId, t.startDate)
      .where(sql`${t.isActive}`),
    index("external_calendar_events_workspace_idx").on(t.workspaceId),
    check("external_calendar_events_dates", sql`${t.endDate} > ${t.startDate}`),
    check(
      "external_calendar_events_uid_length",
      sql`length(${t.uid}) between 1 and ${sql.raw(String(L.uidMax))}`,
    ),
  ],
);

export const externalCalendarSyncRuns = pgTable(
  "external_calendar_sync_runs",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid().notNull(),
    sourceId: uuid().notNull(),
    trigger: text({ enum: ["cron", "manual"] }).notNull(),
    startedAt: timestamp({ withTimezone: true, mode: "date" }).notNull(),
    finishedAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
    outcome: text({ enum: ["ok", "error"] }).notNull(),
    errorCode: text(),
    eventsTotal: integer().notNull().default(0),
    eventsAdded: integer().notNull().default(0),
    eventsUpdated: integer().notNull().default(0),
    eventsDeactivated: integer().notNull().default(0),
  },
  (t) => [
    foreignKey({
      name: "external_calendar_sync_runs_source_fk",
      columns: [t.sourceId],
      foreignColumns: [externalCalendarSources.id],
    }).onDelete("cascade"),
    index("external_calendar_sync_runs_source_idx").on(t.sourceId, t.finishedAt),
    index("external_calendar_sync_runs_workspace_idx").on(t.workspaceId),
    check("external_calendar_sync_runs_trigger_check", sql`${t.trigger} in ('cron', 'manual')`),
    check("external_calendar_sync_runs_outcome_check", sql`${t.outcome} in ('ok', 'error')`),
    check(
      "external_calendar_sync_runs_error_code_format",
      sql`${t.errorCode} is null or ${t.errorCode} ~ '^[a-z_]{1,40}$'`,
    ),
  ],
);

/** Mülk başına dışa aktarma akışı: tahmin edilemez belirteç (32 bayt, base64url). */
export const propertyIcalExports = pgTable(
  "property_ical_exports",
  {
    propertyId: uuid().notNull(),
    workspaceId: uuid().notNull(),
    token: text().notNull(),
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
    rotatedAt: timestamp({ withTimezone: true, mode: "date" }),
    /** Akış en son ne zaman okundu (platform senkronu; en fazla 10 dakikada bir güncellenir). */
    lastFetchedAt: timestamp({ withTimezone: true, mode: "date" }),
  },
  (t) => [
    primaryKey({ name: "property_ical_exports_pkey", columns: [t.propertyId] }),
    foreignKey({
      name: "property_ical_exports_property_fk",
      columns: [t.propertyId, t.workspaceId],
      foreignColumns: [properties.id, properties.workspaceId],
    }).onDelete("restrict"),
    uniqueIndex("property_ical_exports_token_key").on(t.token),
    index("property_ical_exports_workspace_idx").on(t.workspaceId),
    index("property_ical_exports_created_by_idx").on(t.createdBy),
    check("property_ical_exports_token_format", sql`${t.token} ~ '^[A-Za-z0-9_-]{43}$'`),
  ],
);
