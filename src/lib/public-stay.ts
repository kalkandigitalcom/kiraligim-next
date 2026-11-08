/**
 * Müşteriye açık villa sayfası (F2c): tarih seçimi, konaklama değerlendirmesi ve WhatsApp mesajı.
 * Saf ve bağımlılıksız (tarayıcı + sunucu + birim testleri). YENİ FİYAT KURALI YOKTUR: müsaitlik
 * F2a'daki availability.ts, fiyat mevcut quoteStay (src/lib/pricing.ts) ile hesaplanır.
 *
 * Kurallar:
 *  - Konaklama [giriş, çıkış) gecelerdir; çıkış günü başka bir konaklamanın giriş günü olabilir.
 *  - Giriş [bugün, son giriş günü] aralığında ve gecesi boş olmalı (aynı gün giriş serbest).
 *  - En fazla PUBLIC_BOOKING.maxNights gece; aradaki hiçbir gece dolu olamaz.
 *  - Minimum konaklama (giriş gecesinin dönemi) public sayfada ZORUNLUDUR (ürün kararı); karşılanmazsa
 *    tutar gösterilmez.
 *  - Toplam yalnız quoteStay `ok` iken gösterilir; fiyatsız gece varsa tutar gösterilmez.
 *  - Bu modül hiçbir yere yazmaz; sonuç yalnız bilgilendirme ve WhatsApp mesajıdır.
 */
import {
  type AvailabilityWindow,
  canCheckIn,
  checkStay,
  isNightBusy,
  latestCheckOut,
  type StayCheck,
} from "./availability";
import { monthOf } from "./calendar";
import { type Quote, quoteStay } from "./pricing";
import { type BusyRange, PUBLIC_BOOKING } from "./public-villa";
import type { RatePeriod } from "./rate-meta";
import { addDays, formatMoney, formatStay, nightsBetween } from "./reservation-meta";

export type StaySelection = { checkIn: string | null; checkOut: string | null };
export const EMPTY_STAY: StaySelection = { checkIn: null, checkOut: null };

/**
 * Takvimde bir güne tıklama. Giriş seçiliyken: geçerli bir çıkış günü çıkışı tamamlar; değilse
 * (geçerli bir giriş günüyse) yeni giriş olur. Seçilemeyen günler seçimi değiştirmez.
 */
export function selectStayDay(
  sel: StaySelection,
  day: string,
  busy: readonly BusyRange[],
  w: AvailabilityWindow,
): StaySelection {
  if (sel.checkIn && !sel.checkOut) {
    const latest = latestCheckOut(sel.checkIn, busy, w);
    if (latest && day > sel.checkIn && day <= latest)
      return { checkIn: sel.checkIn, checkOut: day };
  }
  if (canCheckIn(day, busy, w)) return { checkIn: day, checkOut: null };
  return sel;
}

export type DayView = {
  date: string;
  /** Gecesi dolu mu (rezervasyon/blok ayrımı yok). */
  busy: boolean;
  /** Bugünden önce ya da son çıkış ufkunun ötesinde. */
  outside: boolean;
  selectable: boolean;
  /** Dolu bir gecenin günü ama çıkış için seçilebilir (önceki konaklama sabah biter). */
  checkoutOnly: boolean;
  role: "checkin" | "checkout" | "inside" | null;
};

/** Takvim hücresinin durumu (çizim ve erişilebilirlik etiketi için). */
export function dayView(
  date: string,
  sel: StaySelection,
  busy: readonly BusyRange[],
  w: AvailabilityWindow,
): DayView {
  const horizon = addDays(w.lastCheckIn, w.maxNights);
  const outside = date < w.today || date > horizon;
  const nightBusy = isNightBusy(date, busy);
  let selectable = canCheckIn(date, busy, w);
  let checkoutOnly = false;
  if (sel.checkIn && !sel.checkOut) {
    const latest = latestCheckOut(sel.checkIn, busy, w);
    if (latest && date > sel.checkIn && date <= latest) {
      selectable = true;
      checkoutOnly = nightBusy || date > w.lastCheckIn;
    }
  }
  const role =
    date === sel.checkIn
      ? "checkin"
      : date === sel.checkOut
        ? "checkout"
        : sel.checkIn && sel.checkOut && date > sel.checkIn && date < sel.checkOut
          ? "inside"
          : null;
  return { date, busy: nightBusy && !outside, outside, selectable, checkoutOnly, role };
}

/** Takvimin gösterebileceği ilk ve son ay (son çıkış ufku dahil). */
export function stayMonthRange(w: AvailabilityWindow) {
  return { min: monthOf(w.today), max: monthOf(addDays(w.lastCheckIn, w.maxNights)) };
}

export type StayEvaluation =
  | { state: "empty" }
  | { state: "checkout"; checkIn: string; latest: string }
  | {
      state: "invalid";
      checkIn: string;
      checkOut: string;
      reason: Extract<StayCheck, { ok: false }>["reason"];
    }
  | { state: "min-nights"; checkIn: string; checkOut: string; nights: number; required: number }
  | { state: "unpriced"; checkIn: string; checkOut: string; nights: number; quote: Quote }
  | { state: "quote"; checkIn: string; checkOut: string; nights: number; quote: Quote };

/**
 * Seçimin değerlendirmesi: önce müsaitlik (checkStay), sonra quoteStay. Tutar yalnız "quote"
 * durumunda vardır; diğer durumlarda hiçbir toplam üretilmez.
 */
export function evaluateStay(
  sel: StaySelection,
  busy: readonly BusyRange[],
  w: AvailabilityWindow,
  rates: readonly RatePeriod[],
): StayEvaluation {
  if (!sel.checkIn) return { state: "empty" };
  if (!sel.checkOut) {
    const latest = latestCheckOut(sel.checkIn, busy, w);
    return latest ? { state: "checkout", checkIn: sel.checkIn, latest } : { state: "empty" };
  }
  const { checkIn, checkOut } = sel;
  const check = checkStay(checkIn, checkOut, busy, w);
  if (!check.ok) return { state: "invalid", checkIn, checkOut, reason: check.reason };
  const quote = quoteStay(checkIn, checkOut, rates);
  if (quote.minNights) {
    return {
      state: "min-nights",
      checkIn,
      checkOut,
      nights: check.nights,
      required: quote.minNights.required,
    };
  }
  if (!quote.ok || quote.totalMinor === null || quote.currency === null) {
    return { state: "unpriced", checkIn, checkOut, nights: check.nights, quote };
  }
  return { state: "quote", checkIn, checkOut, nights: check.nights, quote };
}

export const STAY_INVALID_MESSAGES: Record<
  Extract<StayEvaluation, { state: "invalid" }>["reason"],
  string
> = {
  invalid: "Çıkış tarihi girişten sonra olmalı.",
  past: "Geçmiş bir tarih seçilemez.",
  too_far: "Bu tarih için henüz rezervasyon alınmıyor.",
  too_long: `Sayfadan en fazla ${PUBLIC_BOOKING.maxNights} gecelik konaklama hesaplanabilir; daha uzun konaklama için ev sahibine yazın.`,
  busy: "Seçilen tarihlerde dolu geceler var.",
};

/**
 * WhatsApp hazır mesajı (misafirin ağzından). Yalnız villa adı, sayfa adresi, tarihler, gece ve
 * (varsa) kişi sayısı ile hesaplanan toplam; misafirin adı veya iletişim bilgisi yoktur. Toplam
 * yalnız geçerli teklifte eklenir.
 */
export function stayWhatsappText(opts: {
  villaName: string;
  /** Sayfa adresi; null ise (önizlemede adres henüz kaydedilmemiş) mesaja eklenmez. */
  pageUrl: string | null;
  evaluation: StayEvaluation;
  guests?: number | null;
}): string {
  const { villaName, pageUrl, evaluation: e, guests } = opts;
  const who = guests && guests > 0 ? `, ${guests} kişi` : "";
  if (e.state === "quote" && e.quote.totalMinor !== null && e.quote.currency) {
    return [
      `Merhaba, ${villaName} için ${formatStay(e.checkIn, e.checkOut)} (${e.nights} gece${who}) konaklamak istiyorum.`,
      `Sayfadaki hesaplamaya göre toplam tutar ${formatMoney(e.quote.totalMinor, e.quote.currency)}.`,
      "Müsaitliği ve fiyatı teyit edebilir misiniz?",
      ...(pageUrl ? [pageUrl] : []),
    ].join("\n");
  }
  // Tutar gösterilemeyen ama tarihleri geçerli seçimler: tarih ve gece sayısı, tutar YOK.
  const datesOnly =
    e.state === "min-nights" ||
    e.state === "unpriced" ||
    (e.state === "invalid" && e.reason === "too_long");
  if (datesOnly) {
    const nights = nightsBetween(e.checkIn, e.checkOut);
    return [
      `Merhaba, ${villaName} için ${formatStay(e.checkIn, e.checkOut)} (${nights} gece${who}) konaklama hakkında bilgi almak istiyorum.`,
      ...(pageUrl ? [pageUrl] : []),
    ].join("\n");
  }
  // Genel mesaj: F2b'deki iletişim bağlantısıyla aynı metin.
  return `Merhaba, ${villaName} hakkında bilgi almak istiyorum.${pageUrl ? ` ${pageUrl}` : ""}`;
}

/** wa.me bağlantısı: yalnız numara ve metin (başka parametre yok). */
export function whatsappLink(number: string, text: string): string {
  return `https://wa.me/${number.replace(/\D/g, "")}?text=${encodeURIComponent(text)}`;
}
