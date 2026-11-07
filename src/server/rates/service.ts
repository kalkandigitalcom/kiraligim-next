import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";

import { PG, pgErrorInfo } from "@/db/pg-error";
import type { MemberRole, TenantContext, Tx } from "@/db/tenant";
import { AppError, forbidden, validationError } from "@/lib/errors";
import { type Quote, quoteStay } from "@/lib/pricing";
import { formatPeriod, lastNightOf, type RatePeriod, sortPeriods } from "@/lib/rate-meta";
import {
  type Currency,
  isIsoDate,
  istanbulToday,
  nightsBetween,
  RESERVATION_LIMITS,
} from "@/lib/reservation-meta";
import { zodFieldErrors } from "@/lib/result";
import { type RATE_AUDIT_FIELDS, recordAudit } from "@/server/audit/record";
import { isUuid } from "@/server/properties/service";

import { type RateDateRules, rateInput, type RateValues } from "./schema";

/**
 * Fiyat dönemleri servisi (Aşama 3.1). TÜM fonksiyonlar withTenant içinden (tx + ctx) çağrılır:
 *  - workspace_id ve created_by istemciden değil, transaction bağlamından gelir;
 *  - RLS (FORCE) başka işletmenin dönemlerini gizler, staff'ın yazmasını engeller;
 *  - aynı mülkte kesişen dönem veritabanındaki exclusion constraint'le engellenir (eşzamanlı
 *    eklemeler dahil); buradaki ön denetim yalnız anlaşılır hata mesajı içindir.
 *  - Rezervasyonlara dokunulmaz: fiyat dönemi eklemek/değiştirmek mevcut tutarları değiştirmez.
 *  - Pasif mülkün fiyatları da yönetilebilir (fiyat bir ayardır; yeni kayıt kuralı rezervasyonda).
 *  - Bir mülkün tüm dönemleri tek para birimindedir (3.2; veritabanı tetikleyicisi 0019).
 */

export const RATE_MANAGER_ROLES: readonly MemberRole[] = ["owner", "manager"];
export const canManageRates = (role: MemberRole) => RATE_MANAGER_ROLES.includes(role);

type Row = {
  id: string;
  property_id: string;
  start_date: string;
  end_date: string;
  nightly_amount_minor: string | number | null;
  weekly_amount_minor: string | number | null;
  currency: Currency;
  min_nights: number | null;
  cleaning_fee_minor: string | number | null;
  cleaning_fee_free_nights: number | null;
};

const SELECT = sql`
  select r.id, r.property_id,
         to_char(r.start_date, 'YYYY-MM-DD') as start_date,
         to_char(r.end_date, 'YYYY-MM-DD') as end_date,
         r.nightly_amount_minor, r.weekly_amount_minor, r.currency, r.min_nights,
         r.cleaning_fee_minor, r.cleaning_fee_free_nights
    from property_rates r`;

const num = (v: string | number | null) => (v === null ? null : Number(v));

const toRate = (r: Row): RatePeriod & { propertyId: string } => ({
  id: r.id,
  propertyId: r.property_id,
  startDate: r.start_date,
  endDate: r.end_date,
  nightlyAmountMinor: num(r.nightly_amount_minor),
  weeklyAmountMinor: num(r.weekly_amount_minor),
  currency: r.currency,
  minNights: r.min_nights,
  cleaningFeeMinor: num(r.cleaning_fee_minor),
  cleaningFeeFreeNights: r.cleaning_fee_free_nights,
});

const notFoundRate = () => new AppError("NOT_FOUND", "Fiyat dönemi bulunamadı.");
const notFoundProperty = () => new AppError("NOT_FOUND", "Mülk bulunamadı.");

/** Mülkün tüm fiyat dönemleri, başlangıca göre sıralı. Başka işletmenin mülkü → boş liste. */
export async function listRates(tx: Tx, propertyId: string): Promise<RatePeriod[]> {
  if (!isUuid(propertyId)) return [];
  const res = await tx.execute<Row>(sql`${SELECT}
    where r.workspace_id = app_current_workspace_id() and r.property_id = ${propertyId}
    order by r.start_date, r.id`);
  return res.rows.map(toRate);
}

/** Tek dönem; başka işletmeye aitse veya yoksa null (RLS satırı göstermez). */
export async function getRate(
  tx: Tx,
  id: string,
): Promise<(RatePeriod & { propertyId: string }) | null> {
  if (!isUuid(id)) return null;
  const res = await tx.execute<Row>(sql`${SELECT}
    where r.id = ${id} and r.workspace_id = app_current_workspace_id()`);
  const row = res.rows[0];
  return row ? toRate(row) : null;
}

/** [start, end) ile kesişen dönemler (kendisi hariç). Hata mesajı ve ön denetim içindir. */
export async function findRateConflicts(
  tx: Tx,
  propertyId: string,
  startDate: string,
  endDate: string,
  excludeId?: string,
): Promise<RatePeriod[]> {
  if (!isUuid(propertyId)) return [];
  const res = await tx.execute<Row>(sql`${SELECT}
    where r.workspace_id = app_current_workspace_id()
      and r.property_id = ${propertyId}
      and daterange(r.start_date, r.end_date, '[)') && daterange(${startDate}::date, ${endDate}::date, '[)')
      ${excludeId && isUuid(excludeId) ? sql`and r.id <> ${excludeId}` : sql``}
    order by r.start_date
    limit 5`);
  return res.rows.map(toRate);
}

export function rateConflictMessage(conflicts: Pick<RatePeriod, "startDate" | "endDate">[]) {
  if (conflicts.length === 0) return "Bu tarihler başka bir fiyat dönemiyle çakışıyor.";
  const parts = sortPeriods(conflicts.map((c, i) => ({ ...c, id: String(i) }))).map((c) =>
    formatPeriod(c),
  );
  return `Bu tarihler mevcut fiyat dönemiyle çakışıyor: ${parts.join("; ")}. Yeni dönem, mevcut dönemin son gecesinden sonraki gün başlayabilir.`;
}

/**
 * Mülkün fiyat para birimi: dönemlerin (varsa düzenlenen dönem hariç) para birimi; dönem yoksa
 * null. Aşama 3.2: bir mülkün tüm dönemleri tek para birimindedir (veritabanı: 0019).
 */
export async function propertyRateCurrency(
  tx: Tx,
  propertyId: string,
  excludeId?: string,
): Promise<Currency | null> {
  if (!isUuid(propertyId)) return null;
  const res = await tx.execute<{ currency: Currency }>(sql`
    select r.currency from property_rates r
     where r.workspace_id = app_current_workspace_id() and r.property_id = ${propertyId}
       ${excludeId && isUuid(excludeId) ? sql`and r.id <> ${excludeId}` : sql``}
     order by r.start_date
     limit 1`);
  return res.rows[0]?.currency ?? null;
}

const currencyError = (c: Currency) =>
  validationError({
    currency: [
      `Bu mülkün fiyat dönemleri ${c} para biriminde; tüm dönemler aynı para biriminde olmalı.`,
    ],
  });

/**
 * Konaklama fiyat hesabı (Aşama 3.2) — SALT OKUNUR: yalnız fiyat dönemlerini okur, hiçbir kaydı
 * değiştirmez. Tüm üyeler (staff dahil) çağırabilir; dönemler zaten görüntülenebilir. Başka
 * işletmenin mülkü → dönem görünmez → "fiyat tanımlı değil" sonucu (veri sızmaz).
 */
export async function quoteForProperty(
  tx: Tx,
  propertyId: string,
  checkIn: string,
  checkOut: string,
): Promise<Quote | null> {
  if (!isUuid(propertyId) || !isIsoDate(checkIn) || !isIsoDate(checkOut)) return null;
  const nights = nightsBetween(checkIn, checkOut);
  if (nights <= 0 || nights > RESERVATION_LIMITS.maxNights) return null;
  const res = await tx.execute<Row>(sql`${SELECT}
    where r.workspace_id = app_current_workspace_id()
      and r.property_id = ${propertyId}
      and daterange(r.start_date, r.end_date, '[)') && daterange(${checkIn}::date, ${checkOut}::date, '[)')
    order by r.start_date`);
  return quoteStay(checkIn, checkOut, res.rows.map(toRate));
}

function parseRate(input: Record<string, unknown>, rules: RateDateRules): RateValues {
  const parsed = rateInput(rules).safeParse(input);
  if (!parsed.success) throw validationError(zodFieldErrors(parsed.error));
  return parsed.data;
}

async function propertyExists(tx: Tx, propertyId: string): Promise<boolean> {
  if (!isUuid(propertyId)) return false;
  const res = await tx.execute<{ id: string }>(sql`
    select id from properties where id = ${propertyId} and workspace_id = app_current_workspace_id()`);
  return res.rows.length > 0;
}

/** Veritabanı hatalarını kullanıcıya gösterilebilir hatalara çevirir. Çakışma özel ele alınır. */
async function mapWriteError(
  tx: Tx,
  err: unknown,
  ctx: { propertyId: string; startDate: string; endDate: string; excludeId?: string },
): Promise<never> {
  const pg = pgErrorInfo(err);
  if (pg.code === PG.EXCLUSION_VIOLATION) {
    const conflicts = await findRateConflicts(
      tx,
      ctx.propertyId,
      ctx.startDate,
      ctx.endDate,
      ctx.excludeId,
    );
    throw validationError({ startDate: [rateConflictMessage(conflicts)] });
  }
  if (pg.code === PG.INSUFFICIENT_PRIVILEGE) throw forbidden();
  if (pg.message === "property_rates_currency_mismatch") {
    const c = await propertyRateCurrency(tx, ctx.propertyId, ctx.excludeId);
    throw c
      ? currencyError(c)
      : validationError({ currency: ["Tüm dönemler aynı para biriminde olmalı."] });
  }
  if (pg.code === PG.FOREIGN_KEY_VIOLATION) throw notFoundProperty();
  if (pg.code === PG.CHECK_VIOLATION) {
    throw validationError({}, "Girilen değerlerden biri geçerli aralıkta değil.");
  }
  throw err;
}

/** Yeni fiyat dönemi (owner/manager). Döner: dönem kimliği. */
export async function createRate(
  tx: Tx,
  ctx: TenantContext,
  propertyId: string,
  input: Record<string, unknown>,
): Promise<string> {
  if (!canManageRates(ctx.role)) throw forbidden();
  if (!(await propertyExists(tx, propertyId))) throw notFoundProperty();
  const v = parseRate(input, { today: istanbulToday(), checkWindow: true });

  const conflicts = await findRateConflicts(tx, propertyId, v.startDate, v.endDate);
  if (conflicts.length) throw validationError({ startDate: [rateConflictMessage(conflicts)] });
  const current = await propertyRateCurrency(tx, propertyId);
  if (current && current !== v.currency) throw currencyError(current);

  const id = uuidv7();
  try {
    await tx.execute(sql`savepoint create_rate`);
    await tx.execute(sql`
      insert into property_rates (
        id, workspace_id, property_id, start_date, end_date,
        nightly_amount_minor, weekly_amount_minor, currency, min_nights,
        cleaning_fee_minor, cleaning_fee_free_nights, created_by)
      values (
        ${id}, app_current_workspace_id(), ${propertyId}, ${v.startDate}, ${v.endDate},
        ${v.nightlyAmountMinor}, ${v.weeklyAmountMinor}, ${v.currency}, ${v.minNights},
        ${v.cleaningFeeMinor}, ${v.cleaningFeeFreeNights}, app_current_user_id())`);
    await tx.execute(sql`release savepoint create_rate`);
  } catch (err) {
    await tx.execute(sql`rollback to savepoint create_rate`);
    await mapWriteError(tx, err, { propertyId, startDate: v.startDate, endDate: v.endDate });
  }
  await recordAudit(tx, {
    action: "property.rate_created",
    targetType: "property_rate",
    targetId: id,
    metadata: { property: propertyId },
  });
  return id;
}

type AuditField = (typeof RATE_AUDIT_FIELDS)[number];

function changedFields(before: RatePeriod, v: RateValues): AuditField[] {
  const out: AuditField[] = [];
  if (before.startDate !== v.startDate || before.endDate !== v.endDate) out.push("dates");
  if (before.nightlyAmountMinor !== v.nightlyAmountMinor) out.push("nightly_amount");
  if (before.weeklyAmountMinor !== v.weeklyAmountMinor) out.push("weekly_amount");
  if (before.currency !== v.currency) out.push("currency");
  if (before.minNights !== v.minNights) out.push("min_nights");
  if (
    (before.cleaningFeeMinor ?? null) !== v.cleaningFeeMinor ||
    (before.cleaningFeeFreeNights ?? null) !== v.cleaningFeeFreeNights
  )
    out.push("cleaning_fee");
  return out;
}

/**
 * Dönemi düzenler (owner/manager). Mülk değişmez. Tarih penceresi yalnız tarihler değiştiyse
 * denetlenir; dönem kendi kaydıyla çakışmaz. Döner: değişen alan sayısı.
 */
export async function updateRate(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  input: Record<string, unknown>,
): Promise<{ changed: number; propertyId: string }> {
  if (!canManageRates(ctx.role)) throw forbidden();
  if (!isUuid(id)) throw notFoundRate();
  const lock = await tx.execute<{ id: string }>(sql`
    select id from property_rates where id = ${id} and workspace_id = app_current_workspace_id()
       for update`);
  if (!lock.rows[0]) throw notFoundRate();
  const before = (await getRate(tx, id))!;
  const trimmed = (v: unknown) => (typeof v === "string" ? v.trim() : v);
  const datesChanged =
    trimmed(input.startDate) !== before.startDate ||
    trimmed(input.lastNight) !== lastNightOf(before);
  const v = parseRate(input, { today: istanbulToday(), checkWindow: datesChanged });

  const fields = changedFields(before, v);
  if (fields.length === 0) return { changed: 0, propertyId: before.propertyId };

  if (datesChanged) {
    const conflicts = await findRateConflicts(tx, before.propertyId, v.startDate, v.endDate, id);
    if (conflicts.length) throw validationError({ startDate: [rateConflictMessage(conflicts)] });
  }
  if (v.currency !== before.currency) {
    const others = await propertyRateCurrency(tx, before.propertyId, id);
    if (others && others !== v.currency) throw currencyError(others);
  }
  try {
    await tx.execute(sql`savepoint update_rate`);
    await tx.execute(sql`
      update property_rates
         set start_date = ${v.startDate}, end_date = ${v.endDate},
             nightly_amount_minor = ${v.nightlyAmountMinor},
             weekly_amount_minor = ${v.weeklyAmountMinor},
             currency = ${v.currency}, min_nights = ${v.minNights},
             cleaning_fee_minor = ${v.cleaningFeeMinor},
             cleaning_fee_free_nights = ${v.cleaningFeeFreeNights}
       where id = ${id} and workspace_id = app_current_workspace_id()`);
    await tx.execute(sql`release savepoint update_rate`);
  } catch (err) {
    await tx.execute(sql`rollback to savepoint update_rate`);
    await mapWriteError(tx, err, {
      propertyId: before.propertyId,
      startDate: v.startDate,
      endDate: v.endDate,
      excludeId: id,
    });
  }
  await recordAudit(tx, {
    action: "property.rate_updated",
    targetType: "property_rate",
    targetId: id,
    metadata: { property: before.propertyId, fields },
  });
  return { changed: fields.length, propertyId: before.propertyId };
}

/** Dönemi siler (owner/manager); tarihleri yeniden tanımlanabilir hâle gelir. */
export async function deleteRate(
  tx: Tx,
  ctx: TenantContext,
  id: string,
): Promise<{ propertyId: string }> {
  if (!canManageRates(ctx.role)) throw forbidden();
  const before = await getRate(tx, id);
  if (!before) throw notFoundRate();
  let deleted = 0;
  try {
    await tx.execute(sql`savepoint delete_rate`);
    const res = await tx.execute(sql`
      delete from property_rates where id = ${id} and workspace_id = app_current_workspace_id()`);
    deleted = res.rowCount ?? 0;
    await tx.execute(sql`release savepoint delete_rate`);
  } catch (err) {
    await tx.execute(sql`rollback to savepoint delete_rate`);
    if (pgErrorInfo(err).code === PG.INSUFFICIENT_PRIVILEGE) throw forbidden();
    throw err;
  }
  // RLS: staff için DELETE politikası satırı göstermez (0 satır) — uygulama denetimi zaten reddeder.
  if (deleted === 0) throw notFoundRate();
  await recordAudit(tx, {
    action: "property.rate_deleted",
    targetType: "property_rate",
    targetId: id,
    metadata: { property: before.propertyId },
  });
  return { propertyId: before.propertyId };
}
