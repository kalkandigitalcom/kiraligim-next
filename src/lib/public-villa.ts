/**
 * Müşteriye açık villa sayfası (F2): istemciye giden veri biçimi ve sabitler. Bağımlılıksız:
 * sunucu servisi (src/server/public/villa.ts) ve tarayıcı bileşenleri aynı tipleri kullanır.
 *
 * Bu nesnede YALNIZ public sayfanın göstereceği alanlar bulunur: misafir/rezervasyon bilgisi,
 * belge numarası, işletme adı ve kimliği yoktur. Konum yalnız mahalle/ilçe/il ve sahibin
 * misafire göstermek için seçtiği harita (Google gömme adresi veya OpenStreetMap iğnesi). Dolu tarihler
 * rezervasyon/blok ayrımı yapılmadan birleşik aralıklardır.
 */
import { addDays, type Currency } from "./reservation-meta";
import type { RatePeriod } from "./rate-meta";
import type { DistanceKey, DistanceUnit } from "./villa-extras";

/** Misafire gösterilecek harita: sahibin seçtiği yöntem (src/lib/map-pin.ts). */
export type PublicMap =
  | { kind: "google"; embedUrl: string; openUrl: string | null }
  | { kind: "pin"; lat: number; lng: number; openUrl: string };

export const PUBLIC_BOOKING = {
  /** Takvim bugünden bu kadar ay ileriye açılır (son giriş günü). */
  monthsAhead: 18,
  /** Sayfadaki hesaplayıcının kabul ettiği en uzun konaklama; daha uzunu WhatsApp'a. */
  maxNights: 60,
} as const;

export type PublicPool = {
  depth: number;
  width: number;
  length: number;
  /** Yalnız yüzme havuzunda. */
  protected?: boolean;
};

export type PublicPhoto = {
  src: string;
  srcSet: string;
  thumb: string;
  large: string;
  width: number;
  height: number;
  isCover: boolean;
};

/** [start, end) — gece aralığı; end hariç (çıkış günü). */
export type BusyRange = { start: string; end: string };

export type PublicVilla = {
  slug: string;
  name: string;
  propertyType: string;
  descriptionHtml: string | null;
  descriptionText: string | null;
  /** Tek YouTube videosu (kimlik); yoksa null. */
  youtubeVideoId: string | null;
  maxGuests: number;
  bedrooms: number;
  bathrooms: number;
  location: { province: string; district: string; neighborhood: string | null };
  /** Seçili yöntemle harita (Google gömme adresi yeniden doğrulanmış); yoksa null. */
  map: PublicMap | null;
  /** Girilmiş mesafeler, katalog sırasıyla (km + gösterim birimi; NULL birim = eski kayıt). */
  distances: { key: DistanceKey; km: number; unit: DistanceUnit | null }[];
  pools: { swimming: PublicPool | null; indoor: PublicPool | null; kids: PublicPool | null };
  amenities: string[];
  checkInTime: string | null;
  checkOutTime: string | null;
  /** Hazır ev kuralları (katalog sırasıyla, katalog dışı anahtarlar atlanır). */
  houseRuleKeys: string[];
  /** Ev kuralları ek notu (serbest metin). */
  houseRules: string | null;
  /** Fiyata dahil olanlar (bilgi amaçlı; katalog sırasıyla). */
  priceIncludes: string[];
  /** İşletme WhatsApp numarası (+905321234567). */
  whatsapp: string;
  photos: PublicPhoto[];
  /** quoteStay'e doğrudan verilebilir; kimlikler sentetiktir (d1, d2…). */
  rates: RatePeriod[];
  currency: Currency | null;
  busy: BusyRange[];
  /** Sayfanın hesaplandığı gün (Europe/Istanbul) ve son giriş günü. */
  window: { today: string; lastCheckIn: string; maxNights: number };
  updatedAt: string;
};

/** Son giriş günü: bugün + 18 ay (ay sonu taşmasında ayın son günü). */
export function lastCheckInDay(today: string): string {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + PUBLIC_BOOKING.monthsAhead;
  const ty = Math.floor(total / 12);
  const tm = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${ty}-${String(tm).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Dolu tarih sorgusunun penceresi: [bugün, son giriş + en uzun konaklama]. */
export const busyQueryWindow = (today: string) => ({
  from: today,
  to: addDays(lastCheckInDay(today), PUBLIC_BOOKING.maxNights + 1),
});
