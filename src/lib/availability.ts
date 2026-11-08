/**
 * Müşteriye açık villa sayfası: müsaitlik kuralları (saf, bağımlılıksız; tarayıcı ve sunucu).
 *
 * Dolu aralıklar [start, end) gecelerdir (rezervasyonlarla aynı model): `end` günü çıkış günüdür ve
 * yeni bir girişe açıktır. Beklemede, onaylı rezervasyonlar ve bloklar ayrım yapılmadan "dolu"dur.
 *
 * Kurallar (ürün kararları):
 *  - Giriş günü [bugün, son giriş günü] aralığında; aynı gün giriş serbest (gece boşsa).
 *  - Konaklamanın hiçbir gecesi dolu olamaz; çıkış, girişten sonraki ilk dolu gecenin başlangıç
 *    gününe kadar seçilebilir (o gün başka misafirin giriş günüdür, çıkış için uygundur).
 *  - Konaklama en fazla `maxNights` gece.
 */
import { addDays, nightsBetween } from "./reservation-meta";
import type { BusyRange } from "./public-villa";

export type AvailabilityWindow = { today: string; lastCheckIn: string; maxNights: number };

/** Sıralar, boş/ters aralıkları atar, kesişen ve bitişik aralıkları birleştirir. */
export function normalizeBusy(ranges: readonly BusyRange[]): BusyRange[] {
  const sorted = ranges
    .filter((r) => r.start < r.end)
    .slice()
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const out: BusyRange[] = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r.start <= last.end) {
      if (r.end > last.end) last.end = r.end;
    } else out.push({ ...r });
  }
  return out;
}

/** `date` gecesi dolu mu? (aralıklar normalize edilmiş olmalı) */
export function isNightBusy(date: string, busy: readonly BusyRange[]): boolean {
  let lo = 0;
  let hi = busy.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = busy[mid]!;
    if (date < r.start) hi = mid - 1;
    else if (date >= r.end) lo = mid + 1;
    else return true;
  }
  return false;
}

/** [checkIn, checkOut) gecelerinden biri dolu mu? */
export function overlapsBusy(checkIn: string, checkOut: string, busy: readonly BusyRange[]) {
  return busy.some((r) => r.start < checkOut && r.end > checkIn);
}

export function canCheckIn(date: string, busy: readonly BusyRange[], w: AvailabilityWindow) {
  return date >= w.today && date <= w.lastCheckIn && !isNightBusy(date, busy);
}

/**
 * Girişten sonra seçilebilecek en geç çıkış günü: sonraki ilk dolu aralığın başlangıcı ve
 * en uzun konaklama sınırından küçüğü. Giriş geçersizse null.
 */
export function latestCheckOut(
  checkIn: string,
  busy: readonly BusyRange[],
  w: AvailabilityWindow,
): string | null {
  if (!canCheckIn(checkIn, busy, w)) return null;
  const cap = addDays(checkIn, w.maxNights);
  const next = busy.find((r) => r.start > checkIn);
  return next && next.start < cap ? next.start : cap;
}

export function canCheckOut(
  checkIn: string,
  checkOut: string,
  busy: readonly BusyRange[],
  w: AvailabilityWindow,
): boolean {
  const latest = latestCheckOut(checkIn, busy, w);
  return latest !== null && checkOut > checkIn && checkOut <= latest;
}

export type StayCheck =
  | { ok: true; nights: number }
  | {
      ok: false;
      reason: "invalid" | "past" | "too_far" | "too_long" | "busy";
    };

/** Seçilen konaklamanın müsaitlik denetimi (fiyat ve minimum gece ayrı: quoteStay). */
export function checkStay(
  checkIn: string,
  checkOut: string,
  busy: readonly BusyRange[],
  w: AvailabilityWindow,
): StayCheck {
  const nights = nightsBetween(checkIn, checkOut);
  if (!(nights > 0)) return { ok: false, reason: "invalid" };
  if (checkIn < w.today) return { ok: false, reason: "past" };
  if (checkIn > w.lastCheckIn) return { ok: false, reason: "too_far" };
  if (nights > w.maxNights) return { ok: false, reason: "too_long" };
  if (overlapsBusy(checkIn, checkOut, busy)) return { ok: false, reason: "busy" };
  return { ok: true, nights };
}
