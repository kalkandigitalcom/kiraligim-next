/**
 * Rezervasyon ve blok sabitleri, tarih ve tutar yardımcıları. Bağımlılıksız: sunucu (Drizzle
 * şeması, Zod, servis) ve tarayıcı (formlar, takvim) aynı değerleri kullanır. Veritabanı
 * CHECK'leri ve tetikleyicisi aynı sınırlarla yazılmıştır (drizzle/0015, 0016).
 *
 * Tarihler saat dilimsiz "YYYY-MM-DD" metinleridir; konaklama [giriş, çıkış) yarı açık aralıktır:
 * çıkış günü başka bir rezervasyonun giriş günü olabilir. "Bugün" Europe/Istanbul'a göredir.
 */
export const RESERVATION_KINDS = ["reservation", "block"] as const;
export type ReservationKind = (typeof RESERVATION_KINDS)[number];

export const RESERVATION_STATUSES = ["pending", "confirmed", "cancelled"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/** Tarihleri kapatan (çakışma denetimine giren) durumlar. */
export const ACTIVE_RESERVATION_STATUSES = ["pending", "confirmed"] as const;

export const RESERVATION_SOURCES = [
  "direct",
  "phone",
  "airbnb",
  "booking",
  "other",
  "web",
] as const;
export type ReservationSource = (typeof RESERVATION_SOURCES)[number];

/**
 * Panelde elle seçilebilen kaynaklar. "web" yalnız villa sayfasındaki rezervasyon talebi
 * formundan gelir (drizzle/0027); elle eklenen kayıtta seçenek olarak sunulmaz.
 */
export const MANUAL_RESERVATION_SOURCES = [
  "direct",
  "phone",
  "airbnb",
  "booking",
  "other",
] as const;

/**
 * Misafire gösterilen talep numarası: kaydın kimliğinin son 8 onaltılık hanesi (UUID v7'de
 * rastgele kısım; ilk haneler zaman damgasıdır ve aynı dakikada tekrar edebilir). "TLP-3FA9C21B".
 */
export const requestReference = (id: string) =>
  `TLP-${id.replace(/-/g, "").slice(-8).toUpperCase()}`;

export const CURRENCIES = ["TRY", "EUR", "USD", "GBP"] as const;
export type Currency = (typeof CURRENCIES)[number];

export const RESERVATION_KIND_LABELS: Record<ReservationKind, string> = {
  reservation: "Rezervasyon",
  block: "Blok",
};

export const RESERVATION_STATUS_LABELS: Record<ReservationStatus, string> = {
  pending: "Beklemede",
  confirmed: "Onaylı",
  cancelled: "İptal",
};

export const RESERVATION_SOURCE_LABELS: Record<ReservationSource, string> = {
  direct: "Doğrudan",
  phone: "Telefon",
  airbnb: "Airbnb",
  booking: "Booking.com",
  other: "Diğer",
  web: "Web sitesi talebi",
};

export const RESERVATION_LIMITS = {
  maxNights: 365,
  /** Giriş tarihi en fazla bu kadar yıl geçmişte / ileride olabilir. */
  pastYears: 1,
  futureYears: 3,
  guestNameMin: 2,
  guestNameMax: 120,
  phoneMax: 20,
  emailMax: 254,
  adultsMin: 1,
  guestsMax: 50,
  noteMax: 2000,
  cancelReasonMax: 500,
  /** Tutar üst sınırı (kuruş/sent): 9.999.999.999,99. */
  amountMaxMinor: 999_999_999_999,
} as const;

export const TIME_ZONE = "Europe/Istanbul";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Geçerli bir takvim günü mü ("2026-02-30" değil)? */
export function isIsoDate(v: string): boolean {
  const m = ISO_DATE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === v;
}

const toUtc = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
};
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** İki gün arasındaki gece sayısı (çıkış − giriş). */
export const nightsBetween = (checkIn: string, checkOut: string) =>
  Math.round((toUtc(checkOut) - toUtc(checkIn)) / 86_400_000);

export const addDays = (iso: string, days: number) => fromUtc(toUtc(iso) + days * 86_400_000);

/** Yıl ekler; 29 Şubat artık olmayan yılda 28 Şubat olur (PostgreSQL interval ile aynı). */
export function addYears(iso: string, years: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const ty = y + years;
  const last = new Date(Date.UTC(ty, m, 0)).getUTCDate();
  return `${String(ty).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** Europe/Istanbul'a göre bugünün tarihi. */
export function istanbulToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return parts; // en-CA → YYYY-MM-DD
}

/** Giriş tarihi için izin verilen aralık [today − 1 yıl, today + 3 yıl]. */
export function checkInWindow(today: string) {
  return {
    min: addYears(today, -RESERVATION_LIMITS.pastYears),
    max: addYears(today, RESERVATION_LIMITS.futureYears),
  };
}

/**
 * Tutar girişi (Türkçe veya düz): "12.500,50", "12500,5", "12500.50", "12.500" → sayı.
 * Virgül varsa ondalık ayırıcıdır ve noktalar binliktir; virgül yoksa yalnız "1.234.567" biçimi
 * binlik, diğer tek nokta ondalık sayılır. Boş → undefined; geçersiz → NaN. En fazla 2 ondalık.
 */
export function parseAmount(input: string): number | undefined {
  const t = input
    .trim()
    .replace(/\s/g, "")
    .replace(/(₺|TL|TRY|EUR|USD|GBP|€|\$|£)$/i, "");
  if (!t) return undefined;
  let normalized: string;
  if (t.includes(",")) {
    if (!/^\d{1,3}(\.\d{3})*(,\d{1,2})?$|^\d+(,\d{1,2})?$/.test(t)) return Number.NaN;
    normalized = t.replace(/\./g, "").replace(",", ".");
  } else if (/^\d{1,3}(\.\d{3})+$/.test(t)) {
    normalized = t.replace(/\./g, "");
  } else if (/^\d+(\.\d{1,2})?$/.test(t)) {
    normalized = t;
  } else {
    return Number.NaN;
  }
  return Math.round(Number(normalized) * 100) / 100;
}

/**
 * Tutarlar kuruş/sent (tam sayı) olarak saklanır; dört para biriminin de 2 ondalığı vardır.
 * parseAmount ile alınan ana birim değeri → kuruş.
 */
export const toMinor = (amount: number) => Math.round(amount * 100);

/** Kuruş → giriş alanında gösterim: 1250050 → "12.500,50". */
export const minorToInput = (minor: number) =>
  (minor / 100).toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Tutar gösterimi (kuruştan): 12.500,00 ₺ / €12.500,00 (tr-TR). */
export const formatMoney = (minor: number, currency: Currency) =>
  new Intl.NumberFormat("tr-TR", { style: "currency", currency }).format(minor / 100);

/** Kalan tutar (kuruş): toplam − ön ödeme; veritabanındaki hesaplanan kolonla aynı kural. */
export const balanceOf = (totalMinor: number | null, depositMinor: number | null) =>
  totalMinor === null ? null : totalMinor - (depositMinor ?? 0);

const DAY_FMT = new Intl.DateTimeFormat("tr-TR", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const DAY_MONTH_FMT = new Intl.DateTimeFormat("tr-TR", {
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});

/** "2026-07-12" → "12 Temmuz 2026". */
export const formatDay = (iso: string) => DAY_FMT.format(new Date(toUtc(iso)));

/** Konaklama aralığı: "12–15 Temmuz 2026", "30 Haziran – 3 Temmuz 2026", yıllar farklıysa ikisi de. */
export function formatStay(checkIn: string, checkOut: string): string {
  const [y1, m1] = checkIn.split("-");
  const [y2, m2] = checkOut.split("-");
  const d1 = new Date(toUtc(checkIn));
  if (y1 === y2 && m1 === m2) return `${d1.getUTCDate()}–${formatDay(checkOut)}`;
  if (y1 === y2) return `${DAY_MONTH_FMT.format(d1)} – ${formatDay(checkOut)}`;
  return `${formatDay(checkIn)} – ${formatDay(checkOut)}`;
}
