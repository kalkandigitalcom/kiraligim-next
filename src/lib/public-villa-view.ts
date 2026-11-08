/**
 * Müşteriye açık villa sayfası (F2b): gösterim yardımcıları. Saf ve bağımlılıksız; sayfa,
 * metadata ve birim testleri aynı fonksiyonları kullanır. Veri F2a'daki PublicVilla nesnesidir;
 * burada yeni alan üretilmez, yalnız biçimlendirilir.
 */
import { AMENITY_GROUPS, orderAmenities } from "./public-profile-meta";
import { PROPERTY_TYPE_LABELS, type PropertyType } from "./property-meta";
import type { PublicVilla } from "./public-villa";
import type { RatePeriod } from "./rate-meta";
import { formatMoney } from "./reservation-meta";

export const propertyTypeLabel = (t: string) =>
  PROPERTY_TYPE_LABELS[t as PropertyType] ?? PROPERTY_TYPE_LABELS.villa;

/** "Kalkan, Kaş / Antalya" — yalnız mahalle, ilçe ve il (açık adres yok). */
export function locationLabel(l: PublicVilla["location"]): string {
  const area = l.neighborhood ? `${l.neighborhood}, ${l.district}` : l.district;
  return `${area} / ${l.province}`;
}

/** "2 çift kişilik, 2 tek kişilik, 1 çekyat"; hiç yatak girilmemişse null. */
export function bedSummary(b: PublicVilla["beds"]): string | null {
  const parts = [
    b.double > 0 ? `${b.double} çift kişilik` : null,
    b.single > 0 ? `${b.single} tek kişilik` : null,
    b.sofa > 0 ? `${b.sofa} çekyat` : null,
  ].filter((x): x is string => x !== null);
  return parts.length ? parts.join(", ") : null;
}

/** Olanaklar katalog grup sırasıyla; boş gruplar atlanır. Katalog dışı anahtar gösterilmez. */
export function amenityGroups(keys: readonly string[]) {
  const set = new Set<string>(orderAmenities(keys));
  return AMENITY_GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    items: g.items.filter(([k]) => set.has(k)).map(([k, label]) => ({ key: k, label })),
  })).filter((g) => g.items.length > 0);
}

/**
 * Sayfanın para birimindeki en düşük gecelik fiyat (kuruş). Gecelik fiyatı olmayan dönemler ve
 * farklı para birimleri dikkate alınmaz; hiç yoksa null ("fiyat için sorun").
 */
export function startingNightly(
  rates: readonly RatePeriod[],
  currency: PublicVilla["currency"],
): number | null {
  let min: number | null = null;
  for (const r of rates) {
    if (r.currency !== currency || r.nightlyAmountMinor === null) continue;
    if (min === null || r.nightlyAmountMinor < min) min = r.nightlyAmountMinor;
  }
  return min;
}

/** Sezon tablosu satırı: başlangıcı geçmişteki dönem bugünden başlar (geçmiş gösterilmez). */
export type RateRow = {
  id: string;
  startDate: string;
  endDate: string;
  nightly: string | null;
  weekly: string | null;
  minNights: number | null;
  cleaning: string | null;
  cleaningFreeFrom: number | null;
};

export function rateRows(rates: readonly RatePeriod[], today: string): RateRow[] {
  return rates
    .filter((r) => r.endDate > today)
    .map((r) => ({
      id: r.id,
      startDate: r.startDate < today ? today : r.startDate,
      endDate: r.endDate,
      nightly: r.nightlyAmountMinor === null ? null : formatMoney(r.nightlyAmountMinor, r.currency),
      weekly: r.weeklyAmountMinor === null ? null : formatMoney(r.weeklyAmountMinor, r.currency),
      minNights: r.minNights,
      cleaning: r.cleaningFeeMinor ? formatMoney(r.cleaningFeeMinor, r.currency) : null,
      cleaningFreeFrom:
        r.cleaningFeeMinor && r.cleaningFeeFreeNights ? r.cleaningFeeFreeNights : null,
    }));
}

/**
 * WhatsApp bağlantısı: yalnız villa adı ve sayfa adresi içeren hazır mesaj. Misafir bilgisi,
 * tarih veya kişi sayısı eklenmez (F2b'de form yok).
 */
export function whatsappHref(number: string, villaName: string, pageUrl: string): string {
  const digits = number.replace(/\D/g, "");
  const text = `Merhaba, ${villaName} hakkında bilgi almak istiyorum. ${pageUrl}`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

/** Arama motoru / paylaşım açıklaması: açıklama metninden en fazla `max` karakter, kelime sınırında. */
export function metaDescription(
  v: Pick<
    PublicVilla,
    "descriptionText" | "name" | "propertyType" | "location" | "maxGuests" | "bedrooms"
  >,
  max = 160,
): string {
  const fallback = `${locationLabel(v.location)} · ${propertyTypeLabel(v.propertyType)}, ${v.maxGuests} kişilik, ${v.bedrooms} yatak odası.`;
  const text = (v.descriptionText ?? "").replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,.;:–-]+$/, "")}…`;
}

/** Galeride kapak önce; F2a sıralamasını korur (kapak, sıra, kimlik). */
export const coverFirst = <P extends { isCover: boolean }>(photos: readonly P[]): P[] => {
  const i = photos.findIndex((p) => p.isCover);
  return i <= 0 ? [...photos] : [photos[i]!, ...photos.slice(0, i), ...photos.slice(i + 1)];
};
