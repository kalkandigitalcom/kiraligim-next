import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
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
  OPTION_ALERT_SOURCES,
  OPTION_LIMITS as OL,
  OPTION_OPERATION_KINDS,
  OPTION_OPERATION_MODES,
  OPTION_OPERATION_STATUSES,
  OPTION_SETTINGS_LIMITS as SL,
  OPTION_SOURCES,
  OPTION_STATUSES,
  SHADOW_DECISIONS,
  SHADOW_INTENTS,
} from "../../lib/option-meta";
import { RESERVATION_LIMITS } from "../../lib/reservation-meta";
import { adminUsers } from "./admin";
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
    /** Aşama 3a: kişi sayısı (mesajdan veya Super Admin'den); kesinleştirmede zorunlu. */
    adults: smallint(),
    children: smallint(),
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
    // 0070: yalnız grup kimliğine bağlı (bileşik DEĞİL) — grup bağlantısı kaldırılınca
    // wa_groups.workspace_id NULL olur; bileşik anahtar mevcut "bağlantıyı kaldır" işlemini engelliyordu.
    foreignKey({
      name: "reservation_options_group_fk",
      columns: [t.groupId],
      foreignColumns: [waGroups.id],
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
      "reservation_options_guests",
      sql`(${t.adults} is null or ${t.adults} between ${sql.raw(String(RESERVATION_LIMITS.adultsMin))} and ${sql.raw(String(RESERVATION_LIMITS.guestsMax))})
        and (${t.children} is null or ${t.children} between 0 and ${sql.raw(String(RESERVATION_LIMITS.guestsMax))})`,
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
    /** Aşama 3a: işlemi yapan Super Admin (panelden iptal / onay). */
    actorAdminId: uuid().references(() => adminUsers.id, { onDelete: "set null" }),
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
    // 0070: yalnız grup kimliğine bağlı (bkz. reservation_options_group_fk).
    foreignKey({
      name: "wa_option_shadow_decisions_group_fk",
      columns: [t.groupId],
      foreignColumns: [waGroups.id],
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

// ---------------------------------------------------------------------------------------------
// Aşama 3a — otomasyon ayarları (drizzle/0066 – 0067). YALNIZ Opsiyon Sistemi'ni yönetir; mevcut
// otomatik kapat / aç / değiştir, worker ve tepki davranışı bu tablolardan HİÇ okunmaz. Satır yoksa
// KAPALI. Yazma yalnız Super Admin fonksiyonlarıyla (app_option_admin_set_*).
// ---------------------------------------------------------------------------------------------

const minutesCheck = (c: unknown) =>
  sql`${c} between ${sql.raw(String(SL.minMinutes))} and ${sql.raw(String(SL.maxMinutes))}`;

/** Global anahtar ve kill switch (tek satır, kapalı tohumlanır). */
export const optionAutomationGlobal = pgTable(
  "option_automation_global",
  {
    id: smallint().primaryKey().default(1),
    enabled: boolean().notNull().default(false),
    updatedAt: ts().notNull().defaultNow(),
    updatedByAdmin: uuid().references(() => adminUsers.id, { onDelete: "set null" }),
  },
  (t) => [check("option_automation_global_singleton", sql`${t.id} = 1`)],
);

/** İşletme anahtarı, varsayılan süre ve süre seçenekleri (dakika). Satır yoksa kapalı, süresiz. */
export const workspaceOptionSettings = pgTable(
  "workspace_option_settings",
  {
    workspaceId: uuid()
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    automationEnabled: boolean().notNull().default(false),
    defaultDurationMinutes: integer(),
    durationChoices: integer()
      .array()
      .notNull()
      .default(sql`'{}'::integer[]`),
    updatedAt: ts().notNull().defaultNow(),
    updatedByAdmin: uuid().references(() => adminUsers.id, { onDelete: "set null" }),
  },
  (t) => [
    check(
      "workspace_option_settings_values",
      sql`(${t.defaultDurationMinutes} is null or ${minutesCheck(t.defaultDurationMinutes)})
        and cardinality(${t.durationChoices}) <= ${sql.raw(String(SL.maxChoices))}
        and array_position(${t.durationChoices}, null) is null
        and ${sql.raw(String(SL.minMinutes))} <= all(${t.durationChoices})
        and ${sql.raw(String(SL.maxMinutes))} >= all(${t.durationChoices})`,
    ),
  ],
);

/**
 * Grup anahtarı. Satır yoksa kapalı (yeni gruplar kapalı başlar). Grup başka işletmeye bağlanırsa
 * veya yeniden bağlanırsa ayar geçersiz sayılır (workspace_id ve linked_at denetimi,
 * app_option_automation_enabled). wa_groups'a bileşik yabancı anahtar YOK: grup bağlantısını
 * kaldırma (workspace_id → NULL) mevcut davranışıyla aynen çalışır.
 */
export const waGroupOptionSettings = pgTable(
  "wa_group_option_settings",
  {
    groupId: uuid()
      .primaryKey()
      .references(() => waGroups.id, { onDelete: "cascade" }),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    enabled: boolean().notNull().default(false),
    updatedAt: ts().notNull().defaultNow(),
    updatedByAdmin: uuid().references(() => adminUsers.id, { onDelete: "set null" }),
  },
  (t) => [index("wa_group_option_settings_workspace_idx").on(t.workspaceId)],
);

// ---------------------------------------------------------------------------------------------
// Aşama 3a — işlemler, uyarılar ve mesaj imleci (drizzle/0068 – 0069). Yazma yalnız SECURITY
// DEFINER fonksiyonlarıyla; app_user'ın yazma yetkisi yok.
// ---------------------------------------------------------------------------------------------

/**
 * Her opsiyon işlemi (oluştur / iptal / kesinleştir): kaynak mesaj, hedef, karar ve sonuç.
 * Otomatik uygulanan işlem doğrudan "applied" yazılır; belirsiz olan Super Admin onayı bekler
 * (pending → approved | rejected → … ). Onaylanan işlem uygulanırken takvim parmak izi yeniden
 * hesaplanır; değişmişse "stale" olur ve uygulanmaz. Aynı WhatsApp mesajı + öğe en fazla bir işlem.
 */
export const optionOperations = pgTable(
  "option_operations",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    kind: text({ enum: OPTION_OPERATION_KINDS }).notNull(),
    mode: text({ enum: OPTION_OPERATION_MODES }).notNull(),
    status: text({ enum: OPTION_OPERATION_STATUSES }).notNull(),
    source: text({ enum: OPTION_SOURCES }).notNull(),
    /**
     * Yalnız grup kimliğine bağlanır (bileşik anahtar DEĞİL): grup bağlantısı kaldırılınca
     * wa_groups.workspace_id NULL olur; bileşik anahtar mevcut "bağlantıyı kaldır" işlemini
     * engellerdi.
     */
    groupId: uuid().references(() => waGroups.id, { onDelete: "restrict" }),
    messageId: uuid().references(() => waInboundMessages.id, { onDelete: "set null" }),
    waMessageId: text(),
    itemNo: smallint().notNull().default(0),
    propertyId: uuid().notNull(),
    checkIn: date({ mode: "string" }),
    checkOut: date({ mode: "string" }),
    /** Mesajdan gelen gönderim anı (süre bu andan hesaplanır). */
    sentAt: ts(),
    expiresInMinutes: integer(),
    expirySource: text({ enum: OPTION_EXPIRY_SOURCES }),
    endReason: text({ enum: OPTION_END_REASON_LIST }),
    targetOptionId: uuid().references(() => reservationOptions.id, { onDelete: "restrict" }),
    targetOptionVersion: integer(),
    resultOptionId: uuid().references(() => reservationOptions.id, { onDelete: "restrict" }),
    resultReservationId: uuid().references(() => reservations.id, { onDelete: "set null" }),
    reasons: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Karar anındaki takvim özeti (md5): uygulama anında yeniden hesaplanır. */
    fingerprint: text(),
    beforeState: jsonb().$type<Record<string, unknown>>(),
    afterState: jsonb().$type<Record<string, unknown>>(),
    guestName: text(),
    adults: smallint(),
    children: smallint(),
    decidedByAdmin: uuid().references(() => adminUsers.id, { onDelete: "set null" }),
    decidedAt: ts(),
    decisionNote: text(),
    failureCode: text(),
    lockToken: uuid(),
    lockedUntil: ts(),
    attempts: smallint().notNull().default(0),
    version: integer().notNull().default(1),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts().notNull().defaultNow(),
    appliedAt: ts(),
  },
  (t) => [
    foreignKey({
      name: "option_operations_property_fk",
      columns: [t.propertyId, t.workspaceId],
      foreignColumns: [properties.id, properties.workspaceId],
    }).onDelete("restrict"),
    uniqueIndex("option_operations_message_key")
      .on(t.groupId, t.waMessageId, t.itemNo)
      .where(sql`${t.waMessageId} is not null`),
    index("option_operations_status_idx").on(t.status, t.createdAt),
    index("option_operations_workspace_idx").on(t.workspaceId, t.createdAt),
    index("option_operations_target_idx").on(t.targetOptionId),
    index("option_operations_result_option_idx").on(t.resultOptionId),
    check("option_operations_kind_check", sql`${t.kind} in (${list(OPTION_OPERATION_KINDS)})`),
    check("option_operations_mode_check", sql`${t.mode} in (${list(OPTION_OPERATION_MODES)})`),
    check(
      "option_operations_status_check",
      sql`${t.status} in (${list(OPTION_OPERATION_STATUSES)})`,
    ),
    check("option_operations_source_check", sql`${t.source} in (${list(OPTION_SOURCES)})`),
    check(
      "option_operations_origin",
      sql`(${t.source} = 'whatsapp' and ${t.groupId} is not null and ${t.waMessageId} is not null)
        or (${t.source} = 'panel' and ${t.groupId} is null and ${t.messageId} is null and ${t.waMessageId} is null)`,
    ),
    check(
      "option_operations_values",
      sql`${t.itemNo} between 0 and 19 and ${t.version} >= 1 and ${t.attempts} >= 0
        and ((${t.checkIn} is null and ${t.checkOut} is null) or ${t.checkOut} > ${t.checkIn})
        and (${t.expiresInMinutes} is null or ${minutesCheck(t.expiresInMinutes)})
        and (${t.expirySource} is null or ${t.expirySource} in (${list(OPTION_EXPIRY_SOURCES)}))
        and (${t.endReason} is null or ${t.endReason} in (${list(OPTION_END_REASON_LIST)}))
        and (${t.adults} is null or ${t.adults} between ${sql.raw(String(RESERVATION_LIMITS.adultsMin))} and ${sql.raw(String(RESERVATION_LIMITS.guestsMax))})
        and (${t.children} is null or ${t.children} between 0 and ${sql.raw(String(RESERVATION_LIMITS.guestsMax))})
        and (${t.guestName} is null or length(btrim(${t.guestName})) between ${sql.raw(String(RESERVATION_LIMITS.guestNameMin))} and ${sql.raw(String(RESERVATION_LIMITS.guestNameMax))})
        and (${t.decisionNote} is null or length(${t.decisionNote}) <= ${sql.raw(String(SL.noteMax))})
        and (${t.waMessageId} is null or length(${t.waMessageId}) between 1 and ${sql.raw(String(OL.waMessageIdMax))})
        and (${t.fingerprint} is null or ${t.fingerprint} ~ '^[0-9a-f]{32}$')
        and (${t.failureCode} is null or ${t.failureCode} ~ '^[a-z0-9_]{1,60}$')
        and cardinality(${t.reasons}) <= 20 and array_position(${t.reasons}, null) is null
        and (cardinality(${t.reasons}) = 0
             or array_to_string(${t.reasons}, ',') ~ '^[a-z_]{1,40}(,[a-z_]{1,40})*$')
        and (${t.beforeState} is null or (jsonb_typeof(${t.beforeState}) = 'object' and pg_column_size(${t.beforeState}) <= 4096))
        and (${t.afterState} is null or (jsonb_typeof(${t.afterState}) = 'object' and pg_column_size(${t.afterState}) <= 4096))`,
    ),
    // Karar alanları durumla tutarlı: Super Admin kararı yalnız onay / ret sonrası; sonuç yalnız applied.
    check(
      "option_operations_state",
      sql`(${t.status} in ('pending') and ${t.decidedAt} is null and ${t.appliedAt} is null)
        or (${t.status} in ('approved', 'rejected') and ${t.mode} = 'needs_approval'
            and ${t.decidedAt} is not null and ${t.appliedAt} is null)
        or (${t.status} = 'applied' and ${t.appliedAt} is not null
            and (${t.mode} = 'auto' or ${t.decidedAt} is not null))
        or (${t.status} in ('stale', 'failed') and ${t.appliedAt} is null)`,
    ),
  ],
);

/**
 * Açık opsiyonla çakışan kesin kayıt (rezervasyon / blok, beklemede veya onaylı) ya da etkin harici
 * takvim olayı uyarısı. Opsiyon ve rezervasyon DEĞİŞMEZ; yalnız Super Admin bilgilendirilir.
 * Aynı opsiyon + kaynak için tek uyarı.
 */
export const optionConflictAlerts = pgTable(
  "option_conflict_alerts",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid().notNull(),
    optionId: uuid().notNull(),
    propertyId: uuid().notNull(),
    sourceKind: text({ enum: OPTION_ALERT_SOURCES }).notNull(),
    sourceId: uuid().notNull(),
    detectedAt: ts().notNull().defaultNow(),
    acknowledgedAt: ts(),
    acknowledgedByAdmin: uuid().references(() => adminUsers.id, { onDelete: "set null" }),
  },
  (t) => [
    foreignKey({
      name: "option_conflict_alerts_option_fk",
      columns: [t.optionId, t.workspaceId],
      foreignColumns: [reservationOptions.id, reservationOptions.workspaceId],
    }).onDelete("restrict"),
    unique("option_conflict_alerts_source_key").on(t.optionId, t.sourceKind, t.sourceId),
    index("option_conflict_alerts_open_idx")
      .on(t.detectedAt)
      .where(sql`${t.acknowledgedAt} is null`),
    index("option_conflict_alerts_workspace_idx").on(t.workspaceId, t.detectedAt),
    check(
      "option_conflict_alerts_source_check",
      sql`${t.sourceKind} in (${list(OPTION_ALERT_SOURCES)})`,
    ),
    check(
      "option_conflict_alerts_ack",
      sql`${t.acknowledgedByAdmin} is null or ${t.acknowledgedAt} is not null`,
    ),
  ],
);

/**
 * option-maintenance görevinin mesaj imleci (K-D): worker'ın işlediği mesajları OKUR, mesajın
 * durumuna dokunmaz. claimed → done; kilit süresi dolan "claimed" yeniden alınır (en fazla 3).
 * Mesaj temizlenince silinir.
 */
export const optionMessageScans = pgTable(
  "option_message_scans",
  {
    messageId: uuid()
      .primaryKey()
      .references(() => waInboundMessages.id, { onDelete: "cascade" }),
    workspaceId: uuid().notNull(),
    status: text({ enum: ["claimed", "done"] }).notNull(),
    attempts: smallint().notNull().default(1),
    claimedAt: ts().notNull().defaultNow(),
    doneAt: ts(),
  },
  (t) => [
    index("option_message_scans_claimed_idx")
      .on(t.claimedAt)
      .where(sql`${t.status} = 'claimed'`),
    check(
      "option_message_scans_state",
      sql`(${t.status} = 'claimed' and ${t.doneAt} is null) or (${t.status} = 'done' and ${t.doneAt} is not null)`,
    ),
    check("option_message_scans_attempts", sql`${t.attempts} between 1 and 10`),
  ],
);
