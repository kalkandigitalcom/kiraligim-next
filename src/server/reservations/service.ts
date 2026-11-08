import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";

import { PG, pgErrorInfo } from "@/db/pg-error";
import type { MemberRole, TenantContext, Tx } from "@/db/tenant";
import { AppError, forbidden, validationError } from "@/lib/errors";
import {
  type Currency,
  formatStay,
  istanbulToday,
  RESERVATION_KIND_LABELS,
  RESERVATION_STATUS_LABELS,
  type ReservationKind,
  type ReservationSource,
  type ReservationStatus,
} from "@/lib/reservation-meta";
import { zodFieldErrors } from "@/lib/result";
import { recordAudit, type RESERVATION_AUDIT_FIELDS } from "@/server/audit/record";
import { type ExternalConflict, findExternalConflicts } from "@/server/ical/service";
import { isUuid } from "@/server/properties/service";

import {
  blockInput,
  type BlockValues,
  cancelReasonInput,
  type DateRules,
  reservationInput,
  type ReservationValues,
} from "./schema";

/**
 * Rezervasyon ve blok servisi. TÜM fonksiyonlar withTenant içinden (tx + ctx) çağrılır:
 *  - workspace_id ve created_by istemciden değil, transaction bağlamından gelir;
 *  - RLS (FORCE) başka işletmenin kayıtlarını gizler, staff'ın yazmasını engeller;
 *  - çakışma, iptal kuralları, pasif mülk ve tarih aralığı veritabanında da denetlenir
 *    (drizzle/0016_reservations_security.sql); buradaki denetimler anlaşılır hata içindir.
 *  - Abonelik durumu denetlenmez: deneme süresi bitse de mevcut mülklerin rezervasyonları
 *    yönetilir (yeni mülk ekleme mülk servisindeki kurallara tabidir).
 */

export const RESERVATION_MANAGER_ROLES: readonly MemberRole[] = ["owner", "manager"];
export const canManageReservations = (role: MemberRole) => RESERVATION_MANAGER_ROLES.includes(role);

export type Reservation = {
  id: string;
  propertyId: string;
  propertyName: string;
  kind: ReservationKind;
  status: ReservationStatus;
  source: ReservationSource | null;
  checkIn: string;
  checkOut: string;
  nights: number;
  guestName: string | null;
  guestPhone: string | null;
  guestEmail: string | null;
  adults: number | null;
  children: number | null;
  totalAmountMinor: number | null;
  depositAmountMinor: number | null;
  balanceAmountMinor: number | null;
  currency: Currency | null;
  note: string | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type Row = {
  id: string;
  property_id: string;
  property_name: string;
  kind: ReservationKind;
  status: ReservationStatus;
  source: ReservationSource | null;
  check_in: string;
  check_out: string;
  nights: number;
  guest_name: string | null;
  guest_phone: string | null;
  guest_email: string | null;
  adults: number | null;
  children: number | null;
  total_amount_minor: string | number | null;
  deposit_amount_minor: string | number | null;
  balance_amount_minor: string | number | null;
  currency: Currency | null;
  note: string | null;
  cancelled_at: Date | string | null;
  cancel_reason: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const num = (v: string | number | null) => (v === null ? null : Number(v));
const date = (v: Date | string | null) => (v === null ? null : new Date(v));

const toReservation = (r: Row): Reservation => ({
  id: r.id,
  propertyId: r.property_id,
  propertyName: r.property_name,
  kind: r.kind,
  status: r.status,
  source: r.source,
  checkIn: r.check_in,
  checkOut: r.check_out,
  nights: Number(r.nights),
  guestName: r.guest_name,
  guestPhone: r.guest_phone,
  guestEmail: r.guest_email,
  adults: r.adults,
  children: r.children,
  totalAmountMinor: num(r.total_amount_minor),
  depositAmountMinor: num(r.deposit_amount_minor),
  balanceAmountMinor: num(r.balance_amount_minor),
  currency: r.currency ? (r.currency.trim() as Currency) : null,
  note: r.note,
  cancelledAt: date(r.cancelled_at),
  cancelReason: r.cancel_reason,
  createdAt: new Date(r.created_at),
  updatedAt: new Date(r.updated_at),
});

// Tarihler sürücü ayarından bağımsız olarak her zaman "YYYY-MM-DD" metni döner.
const SELECT = sql`
  select r.id, r.property_id, p.name as property_name, r.kind, r.status, r.source,
         to_char(r.check_in, 'YYYY-MM-DD') as check_in,
         to_char(r.check_out, 'YYYY-MM-DD') as check_out,
         (r.check_out - r.check_in) as nights,
         r.guest_name, r.guest_phone, r.guest_email, r.adults, r.children,
         r.total_amount_minor, r.deposit_amount_minor, r.balance_amount_minor, r.currency,
         r.note, r.cancelled_at, r.cancel_reason, r.created_at, r.updated_at
    from reservations r
    join properties p on p.id = r.property_id and p.workspace_id = r.workspace_id`;

/** Bugün (Europe/Istanbul) — veritabanı tetikleyicisiyle aynı tanım. */
const TODAY = sql`(now() at time zone 'Europe/Istanbul')::date`;

const notFoundReservation = () => new AppError("NOT_FOUND", "Kayıt bulunamadı.");
const notFoundProperty = () => new AppError("NOT_FOUND", "Mülk bulunamadı.");

/** Tek kayıt; başka işletmeye aitse veya yoksa null (RLS satırı göstermez). */
export async function getReservation(tx: Tx, id: string): Promise<Reservation | null> {
  if (!isUuid(id)) return null;
  const res = await tx.execute<Row>(sql`${SELECT}
    where r.id = ${id} and r.workspace_id = app_current_workspace_id()`);
  const row = res.rows[0];
  return row ? toReservation(row) : null;
}

export const RESERVATION_VIEWS = ["upcoming", "current", "past", "cancelled"] as const;
export type ReservationView = (typeof RESERVATION_VIEWS)[number];

export type ListOptions = {
  view: ReservationView;
  propertyId?: string | undefined;
  /** Misafir adında arama (büyük/küçük harf duyarsız). */
  query?: string | undefined;
  kind?: ReservationKind | undefined;
  limit?: number;
  offset?: number;
};

/**
 * Liste görünümleri (bugün = Europe/Istanbul):
 *  - upcoming: aktif, giriş bugünden sonra (yakından uzağa)
 *  - current: aktif, giriş ≤ bugün < çıkış (şu an konaklayan)
 *  - past: aktif, çıkış ≤ bugün (yeniden eskiye)
 *  - cancelled: iptal edilenler (son iptal önce)
 */
export async function listReservations(
  tx: Tx,
  opts: ListOptions,
): Promise<{ items: Reservation[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const where = [sql`r.workspace_id = app_current_workspace_id()`];
  const active = sql`r.status in ('pending', 'confirmed')`;
  let order;
  switch (opts.view) {
    case "upcoming":
      where.push(active, sql`r.check_in > ${TODAY}`);
      order = sql`r.check_in, r.check_out, r.id`;
      break;
    case "current":
      where.push(active, sql`r.check_in <= ${TODAY}`, sql`r.check_out > ${TODAY}`);
      order = sql`r.check_out, r.check_in, r.id`;
      break;
    case "past":
      where.push(active, sql`r.check_out <= ${TODAY}`);
      order = sql`r.check_in desc, r.id desc`;
      break;
    case "cancelled":
      where.push(sql`r.status = 'cancelled'`);
      order = sql`r.cancelled_at desc, r.id desc`;
      break;
    default:
      throw validationError({ view: ["Geçersiz görünüm."] });
  }
  if (opts.propertyId !== undefined) {
    if (!isUuid(opts.propertyId)) return { items: [], hasMore: false };
    where.push(sql`r.property_id = ${opts.propertyId}`);
  }
  if (opts.kind) where.push(sql`r.kind = ${opts.kind}`);
  const q = opts.query?.trim().slice(0, 120);
  if (q) {
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(sql`r.guest_name ilike ${pattern}`);
  }
  const res = await tx.execute<Row>(sql`${SELECT}
    where ${sql.join(where, sql` and `)}
    order by ${order}
    limit ${limit + 1} offset ${offset}`);
  const rows = res.rows.map(toReservation);
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

/**
 * Villa sayfasından gelen, ev sahibi onayı bekleyen talepler (kaynak "web", beklemede, çıkışı
 * bugünden sonra). Genel Bakış'taki hatırlatma için; RLS yalnız bağlamdaki işletmeyi gösterir.
 */
export async function countPendingWebRequests(tx: Tx): Promise<number> {
  const res = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from reservations r
     where r.workspace_id = app_current_workspace_id()
       and r.kind = 'reservation' and r.status = 'pending' and r.source = 'web'
       and r.check_out > ${TODAY}`);
  return res.rows[0]?.n ?? 0;
}

/** Takvim: mülkün [from, to) aralığıyla kesişen AKTİF kayıtları (rezervasyon + blok). */
export async function listCalendarEntries(
  tx: Tx,
  propertyId: string,
  from: string,
  to: string,
): Promise<Reservation[]> {
  if (!isUuid(propertyId)) return [];
  const res = await tx.execute<Row>(sql`${SELECT}
    where r.workspace_id = app_current_workspace_id()
      and r.property_id = ${propertyId}
      and r.status in ('pending', 'confirmed')
      and daterange(r.check_in, r.check_out, '[)') && daterange(${from}::date, ${to}::date, '[)')
    order by r.check_in, r.id`);
  return res.rows.map(toReservation);
}

export type Conflict = {
  id: string;
  kind: ReservationKind;
  status: ReservationStatus;
  checkIn: string;
  checkOut: string;
};

/** Verilen aralıkla çakışan aktif kayıtlar (müsaitlik ön denetimi ve hata mesajı için). */
export async function findConflicts(
  tx: Tx,
  propertyId: string,
  checkIn: string,
  checkOut: string,
  excludeId?: string,
): Promise<Conflict[]> {
  if (!isUuid(propertyId)) return [];
  const res = await tx.execute<{
    id: string;
    kind: ReservationKind;
    status: ReservationStatus;
    check_in: string;
    check_out: string;
  }>(sql`
    select r.id, r.kind, r.status,
           to_char(r.check_in, 'YYYY-MM-DD') as check_in,
           to_char(r.check_out, 'YYYY-MM-DD') as check_out
      from reservations r
     where r.workspace_id = app_current_workspace_id()
       and r.property_id = ${propertyId}
       and r.status in ('pending', 'confirmed')
       and daterange(r.check_in, r.check_out, '[)') && daterange(${checkIn}::date, ${checkOut}::date, '[)')
       ${excludeId && isUuid(excludeId) ? sql`and r.id <> ${excludeId}` : sql``}
     order by r.check_in
     limit 5`);
  return res.rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    checkIn: r.check_in,
    checkOut: r.check_out,
  }));
}

/**
 * "Seçilen tarihler dolu: 12–15 Temmuz 2026 (onaylı rezervasyon)." Harici takvim (iCal)
 * dolulukları kaynak adıyla eklenir: "… (harici takvim: Airbnb)".
 */
export function conflictMessage(conflicts: Conflict[], external: ExternalConflict[] = []): string {
  if (conflicts.length === 0 && external.length === 0) {
    return "Seçilen tarihler başka bir kayıtla çakışıyor.";
  }
  const parts = conflicts.map((c) => {
    const what =
      c.kind === "block"
        ? "blok"
        : `${RESERVATION_STATUS_LABELS[c.status].toLocaleLowerCase("tr-TR")} ${RESERVATION_KIND_LABELS.reservation.toLocaleLowerCase("tr-TR")}`;
    return `${formatStay(c.checkIn, c.checkOut)} (${what})`;
  });
  for (const e of external) {
    parts.push(`${formatStay(e.checkIn, e.checkOut)} (harici takvim: ${e.sourceName})`);
  }
  return `Seçilen tarihler dolu: ${parts.join("; ")}.`;
}

type PropertyInfo = { status: "active" | "passive"; max_guests: number };

async function propertyInfo(tx: Tx, propertyId: string): Promise<PropertyInfo | null> {
  if (!isUuid(propertyId)) return null;
  const res = await tx.execute<PropertyInfo>(sql`
    select status, max_guests from properties
     where id = ${propertyId} and workspace_id = app_current_workspace_id()`);
  return res.rows[0] ?? null;
}

function parseWith<T>(
  schema: {
    safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: unknown };
  },
  input: unknown,
): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw validationError(zodFieldErrors(parsed.error as Parameters<typeof zodFieldErrors>[0]));
  }
  return parsed.data;
}

const capacityError = (max: number) =>
  validationError({
    adults: [`Misafir sayısı mülk kapasitesini (${max} kişi) aşamaz.`],
  });

/** Veritabanı hatalarını kullanıcıya gösterilebilir hatalara çevirir. Çakışma özel ele alınır. */
async function mapWriteError(
  tx: Tx,
  err: unknown,
  ctx: { propertyId: string; checkIn: string; checkOut: string; excludeId?: string },
): Promise<never> {
  const pg = pgErrorInfo(err);
  if (pg.code === PG.EXCLUSION_VIOLATION) {
    const conflicts = await findConflicts(
      tx,
      ctx.propertyId,
      ctx.checkIn,
      ctx.checkOut,
      ctx.excludeId,
    );
    // Harici takvim (iCal) doluluğu da 23P01 ile gelir (reservations_guard_external, 0029).
    const external = await findExternalConflicts(tx, ctx.propertyId, ctx.checkIn, ctx.checkOut);
    throw new AppError("CONFLICT", conflictMessage(conflicts, external));
  }
  if (pg.code === PG.INSUFFICIENT_PRIVILEGE) throw forbidden();
  switch (pg.message) {
    case "reservation_property_inactive":
      throw new AppError("CONFLICT", "Pasif mülke yeni rezervasyon veya blok eklenemez.");
    case "reservation_cancelled_immutable":
      throw new AppError("CONFLICT", "İptal edilen kayıt değiştirilemez.");
    case "reservation_property_not_found":
      throw notFoundProperty();
    case "reservation_date_out_of_range":
      throw validationError({
        checkIn: ["Giriş tarihi en fazla 1 yıl geçmişte ve 3 yıl ileride olabilir."],
      });
  }
  if (pg.code === PG.FOREIGN_KEY_VIOLATION) throw notFoundProperty();
  if (pg.code === PG.CHECK_VIOLATION) {
    throw validationError({}, "Girilen değerlerden biri geçerli aralıkta değil.");
  }
  throw err;
}

export type CreateInput = Record<string, unknown> & { kind?: unknown; propertyId?: unknown };

/** Yeni rezervasyon veya blok (owner/manager). Pasif mülke eklenemez. */
export async function createReservation(
  tx: Tx,
  ctx: TenantContext,
  input: CreateInput,
): Promise<string> {
  if (!canManageReservations(ctx.role)) throw forbidden();
  const kind =
    input.kind === "block" ? "block" : input.kind === "reservation" ? "reservation" : null;
  if (!kind) throw validationError({ kind: ["Kayıt türü geçersiz."] });
  const propertyId = typeof input.propertyId === "string" ? input.propertyId : "";
  const rules: DateRules = { today: istanbulToday(), checkWindow: true };
  const v: ReservationValues | BlockValues =
    kind === "reservation"
      ? parseWith(reservationInput(rules), input)
      : parseWith(blockInput(rules), input);

  const property = await propertyInfo(tx, propertyId);
  if (!property) throw validationError({ propertyId: ["Mülk seçin."] });
  if (property.status !== "active") {
    throw new AppError("CONFLICT", "Pasif mülke yeni rezervasyon veya blok eklenemez.");
  }
  if (v.type === "reservation" && v.adults + v.children > property.max_guests) {
    throw capacityError(property.max_guests);
  }

  const id = uuidv7();
  const r = v.type === "reservation" ? v : null;
  try {
    await tx.execute(sql`savepoint create_reservation`);
    await tx.execute(sql`
      insert into reservations (
        id, workspace_id, property_id, kind, status, source, check_in, check_out,
        guest_name, guest_phone, guest_email, adults, children,
        total_amount_minor, deposit_amount_minor, currency, note, created_by)
      values (
        ${id}, app_current_workspace_id(), ${propertyId}, ${kind},
        ${r ? r.status : "confirmed"}, ${r?.source ?? null}, ${v.checkIn}, ${v.checkOut},
        ${r?.guestName ?? null}, ${r?.guestPhone ?? null}, ${r?.guestEmail ?? null},
        ${r?.adults ?? null}, ${r?.children ?? null},
        ${r?.totalAmountMinor ?? null}, ${r?.depositAmountMinor ?? null}, ${r?.currency ?? null},
        ${v.note}, app_current_user_id())`);
    await tx.execute(sql`release savepoint create_reservation`);
  } catch (err) {
    await tx.execute(sql`rollback to savepoint create_reservation`);
    await mapWriteError(tx, err, { propertyId, checkIn: v.checkIn, checkOut: v.checkOut });
  }
  await recordAudit(tx, {
    action: "reservation.created",
    targetType: "reservation",
    targetId: id,
    metadata: {
      property: propertyId,
      kind,
      status: r ? r.status : "confirmed",
      source: r?.source ?? null,
    },
  });
  return id;
}

type AuditField = (typeof RESERVATION_AUDIT_FIELDS)[number];

function changedFields(before: Reservation, v: ReservationValues | BlockValues): AuditField[] {
  const out: AuditField[] = [];
  if (before.checkIn !== v.checkIn || before.checkOut !== v.checkOut) out.push("dates");
  if (v.type === "reservation") {
    if (before.source !== v.source) out.push("source");
    if (before.guestName !== v.guestName) out.push("guest_name");
    if (before.guestPhone !== v.guestPhone) out.push("guest_phone");
    if (before.guestEmail !== v.guestEmail) out.push("guest_email");
    if (before.adults !== v.adults || before.children !== v.children) out.push("guests");
    if (
      before.totalAmountMinor !== v.totalAmountMinor ||
      before.depositAmountMinor !== v.depositAmountMinor
    )
      out.push("amounts");
    if (before.currency !== v.currency) out.push("currency");
  }
  if (before.note !== v.note) out.push("note");
  return out;
}

/**
 * Kaydı düzenler (owner/manager). Mülk ve tür değişmez (gönderilse de yok sayılır); durum bu
 * fonksiyonla değişmez (confirmReservation / cancelReservation). İptal edilen kayıt
 * düzenlenemez. Tarih aralığı sınırı ve kapasite yalnız ilgili alan değiştiyse denetlenir:
 * eski bir kaydın notu, kapasitesi düşürülmüş bir mülkte de düzeltilebilir. Pasif mülkteki
 * mevcut kayıtlar düzenlenebilir.
 */
export async function updateReservation(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  input: Record<string, unknown>,
): Promise<{ changed: number }> {
  if (!canManageReservations(ctx.role)) throw forbidden();
  if (!isUuid(id)) throw notFoundReservation();
  const lock = await tx.execute<{ id: string }>(sql`
    select id from reservations where id = ${id} and workspace_id = app_current_workspace_id()
       for update`);
  if (!lock.rows[0]) throw notFoundReservation();
  const before = (await getReservation(tx, id))!;
  if (before.status === "cancelled") {
    throw new AppError("CONFLICT", "İptal edilen kayıt değiştirilemez.");
  }
  const trimmed = (v: unknown) => (typeof v === "string" ? v.trim() : v);
  const datesChanged = (v: { checkIn?: unknown; checkOut?: unknown }) =>
    trimmed(v.checkIn) !== before.checkIn || trimmed(v.checkOut) !== before.checkOut;
  const rules: DateRules = {
    today: istanbulToday(),
    checkWindow: datesChanged(input as { checkIn?: unknown; checkOut?: unknown }),
  };
  const v: ReservationValues | BlockValues =
    before.kind === "reservation"
      ? parseWith(reservationInput(rules), { ...input, status: before.status })
      : parseWith(blockInput(rules), input);

  if (v.type === "reservation" && (v.adults !== before.adults || v.children !== before.children)) {
    const property = await propertyInfo(tx, before.propertyId);
    if (property && v.adults + v.children > property.max_guests) {
      throw capacityError(property.max_guests);
    }
  }

  const fields = changedFields(before, v);
  if (fields.length === 0) return { changed: 0 };
  const r = v.type === "reservation" ? v : null;
  try {
    await tx.execute(sql`savepoint update_reservation`);
    const res = await tx.execute(
      r
        ? sql`
        update reservations set
          check_in = ${v.checkIn}, check_out = ${v.checkOut}, source = ${r.source},
          guest_name = ${r.guestName}, guest_phone = ${r.guestPhone}, guest_email = ${r.guestEmail},
          adults = ${r.adults}, children = ${r.children},
          total_amount_minor = ${r.totalAmountMinor}, deposit_amount_minor = ${r.depositAmountMinor},
          currency = ${r.currency}, note = ${v.note}
        where id = ${id} and workspace_id = app_current_workspace_id()`
        : sql`
        update reservations set check_in = ${v.checkIn}, check_out = ${v.checkOut}, note = ${v.note}
        where id = ${id} and workspace_id = app_current_workspace_id()`,
    );
    if (res.rowCount !== 1) throw notFoundReservation();
    await tx.execute(sql`release savepoint update_reservation`);
  } catch (err) {
    await tx.execute(sql`rollback to savepoint update_reservation`);
    if (err instanceof AppError) throw err;
    await mapWriteError(tx, err, {
      propertyId: before.propertyId,
      checkIn: v.checkIn,
      checkOut: v.checkOut,
      excludeId: id,
    });
  }
  await recordAudit(tx, {
    action: "reservation.updated",
    targetType: "reservation",
    targetId: id,
    metadata: { property: before.propertyId, fields },
  });
  return { changed: fields.length };
}

async function changeStatus(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  to: "confirmed" | "cancelled",
  reason: string | null,
): Promise<{ changed: boolean }> {
  if (!canManageReservations(ctx.role)) throw forbidden();
  if (!isUuid(id)) throw notFoundReservation();
  const cur = await tx.execute<{
    status: ReservationStatus;
    kind: ReservationKind;
    property_id: string;
  }>(
    sql`select status, kind, property_id from reservations
         where id = ${id} and workspace_id = app_current_workspace_id() for update`,
  );
  const row = cur.rows[0];
  if (!row) throw notFoundReservation();
  if (row.status === "cancelled") {
    if (to === "cancelled") return { changed: false };
    throw new AppError("CONFLICT", "İptal edilen kayıt yeniden etkinleştirilemez.");
  }
  if (row.status === to) return { changed: false };
  try {
    await tx.execute(sql`savepoint reservation_status`);
    const res = await tx.execute(sql`
      update reservations set status = ${to}, cancel_reason = ${reason}
       where id = ${id} and workspace_id = app_current_workspace_id() and status = ${row.status}`);
    if (res.rowCount !== 1) {
      throw new AppError("CONFLICT", "Kayıt değiştirilemedi; lütfen tekrar deneyin.");
    }
    await tx.execute(sql`release savepoint reservation_status`);
  } catch (err) {
    await tx.execute(sql`rollback to savepoint reservation_status`);
    if (err instanceof AppError) throw err;
    const pg = pgErrorInfo(err);
    if (pg.code === PG.INSUFFICIENT_PRIVILEGE) throw forbidden();
    if (pg.message === "reservation_cancelled_immutable") {
      throw new AppError("CONFLICT", "İptal edilen kayıt değiştirilemez.");
    }
    throw err;
  }
  await recordAudit(tx, {
    action: "reservation.status_changed",
    targetType: "reservation",
    targetId: id,
    metadata: { property: row.property_id, from: row.status, to },
  });
  return { changed: true };
}

/** Beklemedeki rezervasyonu onaylar. Tarihler zaten kapalı olduğu için çakışma oluşmaz. */
export async function confirmReservation(tx: Tx, ctx: TenantContext, id: string) {
  return changeStatus(tx, ctx, id, "confirmed", null);
}

/** İptal (kesin): tarihler yeniden açılır; kayıt bir daha değiştirilemez veya etkinleştirilemez. */
export async function cancelReservation(tx: Tx, ctx: TenantContext, id: string, reason?: unknown) {
  const parsed = cancelReasonInput.safeParse(reason);
  if (!parsed.success) throw validationError(zodFieldErrors(parsed.error));
  return changeStatus(tx, ctx, id, "cancelled", parsed.data ?? null);
}
