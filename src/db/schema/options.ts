import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  OPTION_END_REASON_LIST,
  OPTION_END_REASONS,
  OPTION_EVENTS,
  OPTION_EXPIRY_SOURCES,
  OPTION_LIMITS as OL,
  OPTION_SOURCES,
  OPTION_STATUSES,
  SHADOW_DECISIONS,
  SHADOW_INTENTS,
} from "../../lib/option-meta";
import { RESERVATION_LIMITS } from "../../lib/reservation-meta";
import { users } from "./auth";
import { properties } from "./properties";
import { reservations } from "./reservations";
import { workspaces } from "./tenancy";
import { waGroups, waInboundMessages } from "./whatsapp";

const ts = () => timestamp({ withTimezone: true, mode: "date" });
const list = (xs: readonly string[]) => sql.raw(xs.map((x) => `'${x}'`).join(", "));

/**
 * Opsiyonlar (Aşama 2). Rezervasyonlardan TAMAMEN ayrı tablo: reservations / external_calendar_events
 * tablolarına yazılmaz, çakışma kısıtına (reservations_no_overlap) girmez, hiçbir doluluk, iCal,
 * API veya webhook fonksiyonu bu tabloyu okumaz. Opsiyon kesinleşirse KESİN kayıt reservations'a
 * ayrıca yazılır (Aşama 4) ve converted_reservation_id ile bağlanır.
 *
 * Elle yazılan migration'da (drizzle/0065_reservation_options_security.sql):
 *  - ENABLE/FORCE RLS; app_user yalnız OKUR (yazma Aşama 2'de yok, sonra fonksiyonlarla);
 *  - tetikleyici: yalnız open → son durum geçişi, son durum ve kimlik alanları değiştirilemez,
 *    sona eriş zamanı ve sürüm veritabanında yazılır, pasif mülke yeni opsiyon yok;
 *  - geçmiş: her ekleme / güncelleme reservation_option_events'e yazılır (append-only).
 */
export const reservationOptions = pgTable(
  "reservation_options",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    propertyId: uuid().notNull(),
    source: text({ enum: OPTION_SOURCES }).notNull(),
    /** WhatsApp kaynağında opsiyonu açan grup (mesaj silinse de kalır). */
    groupId: uuid(),
    /** Opsiyonu açan mesaj; 90 günlük mesaj temizliğinde NULL olur. */
    originMessageId: uuid().references(() => waInboundMessages.id, { onDelete: "set null" }),
    /** WhatsApp mesaj kimliği (kalıcı): aynı mesaj iki opsiyon açamaz. */
    originWaMessageId: text(),
    checkIn: date({ mode: "string" }).notNull(),
    checkOut: date({ mode: "string" }).notNull(),
    status: text({ enum: OPTION_STATUSES }).notNull().default("open"),
    /** Son geçerlilik; süre verilmezse NULL (süresiz, uydurulmaz). */
    expiresAt: ts(),
    expirySource: text({ enum: OPTION_EXPIRY_SOURCES }),
    guestName: text(),
    note: text(),
    /** Kesinleşmede oluşan kesin kayıt (reservations); yalnız converted durumunda dolu. */
    convertedReservationId: uuid().references(() => reservations.id, { onDelete: "restrict" }),
    /** Sona eriş (converted / cancelled / expired) anı: veritabanı yazar. */
    endedAt: ts(),
    endReason: text({ enum: OPTION_END_REASON_LIST }),
    endedByMessageId: uuid().references(() => waInboundMessages.id, { onDelete: "set null" }),
    endedByUserId: uuid().references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts().notNull().defaultNow(),
    /** İyimser kilit; her güncellemede veritabanı artırır. */
    version: integer().notNull().default(1),
  },
  (t) => [
    foreignKey({
      name: "reservation_options_property_fk",
      columns: [t.propertyId, t.workspaceId],
      foreignColumns: [properties.id, properties.workspaceId],
    }).onDelete("restrict"),
    foreignKey({
      name: "reservation_options_group_fk",
      columns: [t.groupId, t.workspaceId],
      foreignColumns: [waGroups.id, waGroups.workspaceId],
    }).onDelete("restrict"),
    unique("reservation_options_scope_key").on(t.id, t.workspaceId),
    unique("reservation_options_converted_key").on(t.convertedReservationId),
    // Aynı WhatsApp mesajı (grup + mesaj kimliği) en fazla bir opsiyon açar.
    uniqueIndex("reservation_options_origin_key")
      .on(t.groupId, t.originWaMessageId)
      .where(sql`${t.originWaMessageId} is not null`),
    index("reservation_options_workspace_check_in_idx").on(t.workspaceId, t.checkIn),
    index("reservation_options_open_property_idx")
      .on(t.propertyId, t.checkIn)
      .where(sql`${t.status} = 'open'`),
    index("reservation_options_open_expiry_idx")
      .on(t.expiresAt)
      .where(sql`${t.status} = 'open' and ${t.expiresAt} is not null`),
    check("reservation_options_status_check", sql`${t.status} in (${list(OPTION_STATUSES)})`),
    check("reservation_options_source_check", sql`${t.source} in (${list(OPTION_SOURCES)})`),
    check(
      "reservation_options_dates",
      sql`${t.checkOut} > ${t.checkIn} and ${t.checkOut} - ${t.checkIn} <= ${sql.raw(String(RESERVATION_LIMITS.maxNights))}`,
    ),
    // WhatsApp opsiyonu grup ve mesaj kimliği taşır; panel opsiyonu taşımaz.
    check(
      "reservation_options_origin",
      sql`(${t.source} = 'whatsapp' and ${t.groupId} is not null and ${t.originWaMessageId} is not null)
        or (${t.source} = 'panel' and ${t.groupId} is null and ${t.originMessageId} is null
            and ${t.originWaMessageId} is null)`,
    ),
    check(
      "reservation_options_expiry",
      sql`(${t.expiresAt} is null) = (${t.expirySource} is null)
        and (${t.expirySource} is null or ${t.expirySource} in (${list(OPTION_EXPIRY_SOURCES)}))`,
    ),
    // Durum ↔ sona eriş alanları tutarlı: açıkta hepsi boş; kesinleşmede kesin kayıt zorunlu.
    check(
      "reservation_options_end_state",
      sql`(${t.status} = 'open' and ${t.endedAt} is null and ${t.endReason} is null
            and ${t.convertedReservationId} is null and ${t.endedByMessageId} is null
            and ${t.endedByUserId} is null)
        or (${t.status} = 'converted' and ${t.endedAt} is not null and ${t.convertedReservationId} is not null
            and ${t.endReason} in (${list(OPTION_END_REASONS.converted)}))
        or (${t.status} = 'cancelled' and ${t.endedAt} is not null and ${t.convertedReservationId} is null
            and ${t.endReason} in (${list(OPTION_END_REASONS.cancelled)}))
        or (${t.status} = 'expired' and ${t.endedAt} is not null and ${t.convertedReservationId} is null
            and ${t.expiresAt} is not null and ${t.endReason} in (${list(OPTION_END_REASONS.expired)}))`,
    ),
    check(
      "reservation_options_lengths",
      sql`(${t.guestName} is null or length(btrim(${t.guestName})) between 1 and ${sql.raw(String(OL.guestNameMax))})
        and (${t.note} is null or length(${t.note}) <= ${sql.raw(String(OL.noteMax))})
        and (${t.originWaMessageId} is null or length(${t.originWaMessageId}) between 1 and ${sql.raw(String(OL.waMessageIdMax))})
        and ${t.version} >= 1`,
    ),
  ],
);

/**
 * Opsiyon geçmişi (append-only). Yalnız reservation_options tetikleyicisi yazar; güncelleme ve
 * silme veritabanında reddedilir. Opsiyonlar silinmediği için geçmiş de silinmez.
 */
export const reservationOptionEvents = pgTable(
  "reservation_option_events",
  {
    id: uuid().primaryKey(),
    optionId: uuid().notNull(),
    workspaceId: uuid().notNull(),
    event: text({ enum: OPTION_EVENTS }).notNull(),
    fromStatus: text({ enum: OPTION_STATUSES }),
    toStatus: text({ enum: OPTION_STATUSES }).notNull(),
    reason: text({ enum: OPTION_END_REASON_LIST }),
    actorUserId: uuid().references(() => users.id, { onDelete: "set null" }),
    messageId: uuid().references(() => waInboundMessages.id, { onDelete: "set null" }),
    convertedReservationId: uuid(),
    version: integer().notNull(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "reservation_option_events_option_fk",
      columns: [t.optionId, t.workspaceId],
      foreignColumns: [reservationOptions.id, reservationOptions.workspaceId],
    }).onDelete("restrict"),
    index("reservation_option_events_option_idx").on(t.optionId, t.createdAt),
    check("reservation_option_events_event_check", sql`${t.event} in (${list(OPTION_EVENTS)})`),
  ],
);

/**
 * Gölge mod kararları (Aşama 2). Worker, merkezi ayar (WA_OPTION_SHADOW=on) açıksa opsiyonla
 * ilgili mesajı analiz eder ve "opsiyon özelliği açık olsaydı ne yapılırdı" kararını YALNIZ buraya
 * yazar. Hiçbir opsiyon, rezervasyon, blok veya tepki oluşturmaz/değiştirmez. Mesaj başına öğe
 * numarasıyla tekil (yeniden işlemede mükerrer kayıt yok); mesaj temizlenince silinir.
 */
export const waOptionShadowDecisions = pgTable(
  "wa_option_shadow_decisions",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid().notNull(),
    groupId: uuid().notNull(),
    messageId: uuid()
      .notNull()
      .references(() => waInboundMessages.id, { onDelete: "cascade" }),
    itemNo: smallint().notNull(),
    parserVersion: smallint().notNull(),
    intent: text({ enum: SHADOW_INTENTS }).notNull(),
    decision: text({ enum: SHADOW_DECISIONS }).notNull(),
    reasons: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Grubun villası (veritabanı belirler); villasız grupta NULL. */
    propertyId: uuid().references(() => properties.id, { onDelete: "set null" }),
    checkIn: date({ mode: "string" }),
    checkOut: date({ mode: "string" }),
    /** Mesajda yazan opsiyon süresi (dakika); yoksa NULL. */
    expiresInMinutes: integer(),
    /** Kesinleştirme / iptal için bulunan opsiyon (yalnız bilgi). */
    targetOptionId: uuid().references(() => reservationOptions.id, { onDelete: "set null" }),
    conflictCount: smallint().notNull().default(0),
    openOptionCount: smallint().notNull().default(0),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "wa_option_shadow_decisions_group_fk",
      columns: [t.groupId, t.workspaceId],
      foreignColumns: [waGroups.id, waGroups.workspaceId],
    }).onDelete("restrict"),
    unique("wa_option_shadow_decisions_message_item_key").on(t.messageId, t.itemNo),
    index("wa_option_shadow_decisions_workspace_idx").on(t.workspaceId, t.createdAt),
    check("wa_option_shadow_decisions_intent_check", sql`${t.intent} in (${list(SHADOW_INTENTS)})`),
    check(
      "wa_option_shadow_decisions_decision_check",
      sql`${t.decision} in (${list(SHADOW_DECISIONS)})`,
    ),
    check(
      "wa_option_shadow_decisions_values",
      sql`${t.itemNo} between 0 and 19 and ${t.parserVersion} >= 1
        and ${t.conflictCount} >= 0 and ${t.openOptionCount} >= 0
        and (${t.expiresInMinutes} is null or ${t.expiresInMinutes} > 0)
        and ((${t.checkIn} is null and ${t.checkOut} is null) or ${t.checkOut} > ${t.checkIn})
        and cardinality(${t.reasons}) <= 20 and array_position(${t.reasons}, null) is null
        and (cardinality(${t.reasons}) = 0
             or array_to_string(${t.reasons}, ',') ~ '^[a-z_]{1,40}(,[a-z_]{1,40})*$')`,
    ),
  ],
);
