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
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { RATE_LIMITS as L } from "../../lib/rate-meta";
import { CURRENCIES } from "../../lib/reservation-meta";
import { users } from "./auth";
import { properties } from "./properties";
import { workspaces } from "./tenancy";

/**
 * Mülk fiyat dönemleri (Aşama 3.1). Tenant tablosu: workspace_id + ENABLE/FORCE RLS.
 *
 * Dönem [start_date, end_date) yarı açık aralıktır (rezervasyonlarla aynı): bitiş günü bir sonraki
 * dönemin başlangıcı olabilir. Gecelik ve/veya haftalık (7 gecelik toplam) fiyat; en az biri dolu.
 * Tutarlar proje kuralı gereği kuruş/sent (bigint) + para birimi char(3).
 *
 * Elle yazılan migration'da (drizzle/0018_property_rates_security.sql):
 *  - çakışma kısıtı: aynı mülkte dönemler kesişemez (EXCLUDE USING gist, btree_gist — 0000'da);
 *  - RLS: tüm üyeler okur; owner/manager ekler, düzenler, siler (staff yalnız görüntüler);
 *  - kolon yetkileri: mülk, işletme ve oluşturan sonradan değiştirilemez.
 *
 * Rezervasyon tutarları bu tablodan HESAPLANMAZ (ayrı aşama); mevcut rezervasyonlar etkilenmez.
 */
export const propertyRates = pgTable(
  "property_rates",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    propertyId: uuid().notNull(),
    startDate: date({ mode: "string" }).notNull(),
    /** Hariç (son gece = end_date − 1). */
    endDate: date({ mode: "string" }).notNull(),
    nightlyAmountMinor: bigint({ mode: "number" }),
    /** Bu dönemde geçerli 7 gecelik toplam fiyat. */
    weeklyAmountMinor: bigint({ mode: "number" }),
    currency: char({ length: 3, enum: CURRENCIES }).notNull(),
    minNights: smallint(),
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    // Dönem yalnız aynı işletmenin mülküne bağlanabilir; fiyatı olan mülk silinemez.
    foreignKey({
      name: "property_rates_property_fk",
      columns: [t.propertyId, t.workspaceId],
      foreignColumns: [properties.id, properties.workspaceId],
    }).onDelete("restrict"),
    index("property_rates_property_start_idx").on(t.propertyId, t.startDate),
    index("property_rates_workspace_idx").on(t.workspaceId),
    index("property_rates_created_by_idx").on(t.createdBy),
    check(
      "property_rates_dates",
      sql`${t.endDate} > ${t.startDate} and ${t.endDate} - ${t.startDate} <= ${sql.raw(String(L.maxNights))}`,
    ),
    check(
      "property_rates_amounts",
      sql`(${t.nightlyAmountMinor} is not null or ${t.weeklyAmountMinor} is not null) and (${t.nightlyAmountMinor} is null or ${t.nightlyAmountMinor} between 1 and ${sql.raw(String(L.amountMaxMinor))}) and (${t.weeklyAmountMinor} is null or ${t.weeklyAmountMinor} between 1 and ${sql.raw(String(L.amountMaxMinor))})`,
    ),
    check("property_rates_currency_check", sql`${t.currency} in ('TRY', 'EUR', 'USD', 'GBP')`),
    check(
      "property_rates_min_nights",
      sql`${t.minNights} is null or ${t.minNights} between ${sql.raw(String(L.minNightsMin))} and ${sql.raw(String(L.minNightsMax))}`,
    ),
  ],
);
