import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  check,
  date,
  foreignKey,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import {
  CURRENCIES,
  RESERVATION_KINDS,
  RESERVATION_LIMITS as L,
  RESERVATION_SOURCES,
  RESERVATION_STATUSES,
} from "../../lib/reservation-meta";
import { users } from "./auth";
import { properties } from "./properties";
import { workspaces } from "./tenancy";

/**
 * Rezervasyonlar ve sahibin takvim blokları (Aşama 3.0a). Tenant tablosu: workspace_id +
 * ENABLE/FORCE RLS. Tek tablo: rezervasyon ve blok AYNI çakışma kısıtına tabidir.
 *
 * Elle yazılan migration'da (drizzle/0016_reservations_security.sql):
 *  - RLS politikaları ve kolon yetkileri (silme yok; iptal güncellemeyle yapılır);
 *  - çakışma kısıtı: aynı mülkte beklemede/onaylı kayıtların [giriş, çıkış) aralıkları kesişemez
 *    (EXCLUDE USING gist, btree_gist — 0000'da kurulu);
 *  - tetikleyici: iptal edilen kayıt değiştirilemez, iptal zamanı/eden veritabanında yazılır,
 *    pasif mülke yeni kayıt eklenemez, giriş tarihi [bugün − 1 yıl, bugün + 3 yıl] (Europe/Istanbul).
 *
 * Tarihler saat dilimsiz `date`; uygulamaya "YYYY-MM-DD" metni olarak gelir (src/db/pool.ts).
 */
export const reservations = pgTable(
  "reservations",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    propertyId: uuid().notNull(),
    kind: text({ enum: RESERVATION_KINDS }).notNull(),
    status: text({ enum: RESERVATION_STATUSES }).notNull(),
    /** Yalnız rezervasyonda; blokta NULL. */
    source: text({ enum: RESERVATION_SOURCES }),
    checkIn: date({ mode: "string" }).notNull(),
    checkOut: date({ mode: "string" }).notNull(),
    guestName: text(),
    guestPhone: text(),
    guestEmail: text(),
    adults: smallint(),
    children: smallint(),
    // Tutarlar proje kuralı gereği kuruş/sent (bigint) + para birimi char(3).
    totalAmountMinor: bigint({ mode: "number" }),
    /** Ön ödeme (alınan). */
    depositAmountMinor: bigint({ mode: "number" }),
    currency: char({ length: 3, enum: CURRENCIES }),
    /** Kalan tutar: veritabanı hesaplar (toplam − ön ödeme); elle yazılamaz. */
    balanceAmountMinor: bigint({ mode: "number" }).generatedAlwaysAs(
      sql`total_amount_minor - coalesce(deposit_amount_minor, 0)`,
    ),
    /** İç not; blokta açıklama (ör. "Bakım"). */
    note: text(),
    cancelledAt: timestamp({ withTimezone: true, mode: "date" }),
    cancelledBy: uuid().references(() => users.id, { onDelete: "set null" }),
    cancelReason: text(),
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    // Rezervasyon yalnız aynı işletmenin mülküne bağlanabilir; mülkü olan kayıt silinemez.
    foreignKey({
      name: "reservations_property_fk",
      columns: [t.propertyId, t.workspaceId],
      foreignColumns: [properties.id, properties.workspaceId],
    }).onDelete("restrict"),
    index("reservations_workspace_check_in_idx").on(t.workspaceId, t.checkIn),
    index("reservations_property_check_in_idx").on(t.propertyId, t.checkIn),
    index("reservations_created_by_idx").on(t.createdBy),
    check("reservations_kind_check", sql`${t.kind} in ('reservation', 'block')`),
    check("reservations_status_check", sql`${t.status} in ('pending', 'confirmed', 'cancelled')`),
    check(
      "reservations_source_check",
      sql`${t.source} is null or ${t.source} in ('direct', 'phone', 'airbnb', 'booking', 'other', 'web')`,
    ),
    check(
      "reservations_dates",
      sql`${t.checkOut} > ${t.checkIn} and ${t.checkOut} - ${t.checkIn} <= ${sql.raw(String(L.maxNights))}`,
    ),
    // Rezervasyon: misafir adı, kaynak ve yetişkin sayısı zorunlu.
    check(
      "reservations_reservation_fields",
      sql`${t.kind} <> 'reservation' or (${t.guestName} is not null and ${t.source} is not null and ${t.adults} is not null and ${t.children} is not null)`,
    ),
    // Blok: yalnız tarih ve not; misafir/tutar alanları boş, durum beklemede olamaz.
    check(
      "reservations_block_fields",
      sql`${t.kind} <> 'block' or (${t.status} <> 'pending' and ${t.guestName} is null and ${t.guestPhone} is null and ${t.guestEmail} is null and ${t.source} is null and ${t.adults} is null and ${t.children} is null and ${t.totalAmountMinor} is null and ${t.depositAmountMinor} is null and ${t.currency} is null)`,
    ),
    check(
      "reservations_guest_name_length",
      sql`${t.guestName} is null or length(btrim(${t.guestName})) between ${sql.raw(String(L.guestNameMin))} and ${sql.raw(String(L.guestNameMax))}`,
    ),
    check(
      "reservations_guest_phone_format",
      sql`${t.guestPhone} is null or ${t.guestPhone} ~ '^\\+?[0-9][0-9 ()-]{5,18}[0-9]$'`,
    ),
    check(
      "reservations_guest_email_format",
      sql`${t.guestEmail} is null or (length(${t.guestEmail}) <= ${sql.raw(String(L.emailMax))} and ${t.guestEmail} ~ '^[^@\\s<>]+@[^@\\s<>]+\\.[^@\\s<>]+$')`,
    ),
    check(
      "reservations_guests_range",
      sql`(${t.adults} is null or ${t.adults} between ${sql.raw(String(L.adultsMin))} and ${sql.raw(String(L.guestsMax))}) and (${t.children} is null or ${t.children} between 0 and ${sql.raw(String(L.guestsMax))})`,
    ),
    check(
      "reservations_amounts",
      sql`(${t.totalAmountMinor} is null or ${t.totalAmountMinor} between 0 and ${sql.raw(String(L.amountMaxMinor))}) and (${t.depositAmountMinor} is null or (${t.depositAmountMinor} >= 0 and ${t.totalAmountMinor} is not null and ${t.depositAmountMinor} <= ${t.totalAmountMinor})) and ((${t.totalAmountMinor} is null) = (${t.currency} is null))`,
    ),
    check(
      "reservations_currency_check",
      sql`${t.currency} is null or ${t.currency} in ('TRY', 'EUR', 'USD', 'GBP')`,
    ),
    check(
      "reservations_note_length",
      sql`${t.note} is null or length(${t.note}) <= ${sql.raw(String(L.noteMax))}`,
    ),
    // İptal bilgileri yalnız iptal edilmiş kayıtta.
    check(
      "reservations_cancellation",
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null) and (${t.status} = 'cancelled' or (${t.cancelledBy} is null and ${t.cancelReason} is null)) and (${t.cancelReason} is null or length(${t.cancelReason}) <= ${sql.raw(String(L.cancelReasonMax))})`,
    ),
  ],
);
