/**
 * Villa bilgisi revizyonu: yakın yerlere mesafeler, hazır ev kuralları ve fiyata dahil olanlar.
 * Saf ve bağımlılıksız: Drizzle şeması (CHECK kısıtları), Zod şemaları, sihirbaz ve misafir
 * sayfası aynı katalogları kullanır. Anahtarlar veritabanında saklanır; etiket değişse de kayıt
 * bozulmaz. Katalogdan çıkarılan anahtar gösterilmez (yeni kayıtta da kabul edilmez).
 */

// ---------------------------------------------------------------------------
// Mesafeler (km)
// ---------------------------------------------------------------------------

export const DISTANCE_KEYS = [
  "distanceMarketKm",
  "distanceRestaurantKm",
  "distanceCenterKm",
  "distanceBeachKm",
  "distanceAirportAytKm",
  "distanceAirportDlmKm",
  "distanceHealthKm",
] as const;
export type DistanceKey = (typeof DISTANCE_KEYS)[number];

export const DISTANCE_LABELS: Record<DistanceKey, string> = {
  distanceMarketKm: "Market",
  distanceRestaurantKm: "Restoran",
  distanceCenterKm: "Merkez",
  distanceBeachKm: "Plaj",
  distanceAirportAytKm: "Antalya Havalimanı",
  distanceAirportDlmKm: "Dalaman Havalimanı",
  distanceHealthKm: "Sağlık Merkezi",
};

/** Veritabanı kolon adları (aynı sıra). */
export const DISTANCE_COLUMNS: Record<DistanceKey, string> = {
  distanceMarketKm: "distance_market_km",
  distanceRestaurantKm: "distance_restaurant_km",
  distanceCenterKm: "distance_center_km",
  distanceBeachKm: "distance_beach_km",
  distanceAirportAytKm: "distance_airport_ayt_km",
  distanceAirportDlmKm: "distance_airport_dlm_km",
  distanceHealthKm: "distance_health_km",
};

/** km: 0 < değer ≤ 9999,99; en fazla iki ondalık (numeric(6,2)). */
export const DISTANCE_LIMITS = { min: 0, max: 9999.99 } as const;

/** Türkçe gösterim: 1 km altı metre ("350 m"), üstü en fazla bir ondalık ("2,5 km"). */
export function formatDistance(km: number): string {
  if (km < 1) return `${Math.max(10, Math.round((km * 1000) / 10) * 10)} m`;
  const v = km < 10 ? Math.round(km * 10) / 10 : Math.round(km);
  return `${v.toLocaleString("tr-TR", { maximumFractionDigits: 1 })} km`;
}

/** Form gösterimi (kayıt → form): "2,5"; boş → "". */
export const distanceToInput = (km: number | null) =>
  km === null ? "" : km.toLocaleString("tr-TR", { maximumFractionDigits: 2, useGrouping: false });

// ---------------------------------------------------------------------------
// Ev kuralları (hazır seçenekler) ve fiyata dahil olanlar
// ---------------------------------------------------------------------------

export const HOUSE_RULES = [
  ["evcil-hayvan-yok", "Evcil hayvan kabul edilmez"],
  ["sigara-icilmez", "Sigara içilmez"],
  ["parti-yok", "Parti ve etkinlik yapılamaz"],
  ["cocuklar-uygun", "Çocuklar için uygundur"],
  ["kimlik-zorunlu", "Kimlik ibrazı zorunludur"],
  ["sessizlik-saatleri", "Sessizlik saatlerine uyulmalıdır"],
  ["ziyaretci-yok", "Konaklayanlar dışında misafir kabul edilmez"],
  ["havuz-gozetim", "Çocuklar havuzda yetişkin gözetiminde olmalıdır"],
] as const;
export type HouseRuleKey = (typeof HOUSE_RULES)[number][0];

export const PRICE_INCLUDES = [
  ["elektrik", "Elektrik"],
  ["su", "Su"],
  ["internet", "İnternet / Wi-Fi"],
  ["havuz-bakimi", "Havuz bakımı"],
  ["bahce-bakimi", "Bahçe bakımı"],
  ["temizlik", "Temizlik"],
  ["klima", "Klima kullanımı"],
  ["isitma", "Doğalgaz / Isıtma"],
] as const;
export type PriceIncludeKey = (typeof PRICE_INCLUDES)[number][0];

export const HOUSE_RULE_LABELS: Record<string, string> = Object.fromEntries(HOUSE_RULES);
export const PRICE_INCLUDE_LABELS: Record<string, string> = Object.fromEntries(PRICE_INCLUDES);

/** Anahtar biçimi (veritabanı CHECK'i; olanaklarla aynı). */
export const EXTRA_KEY_PATTERN = "^[a-z][a-z0-9-]{1,31}$";
export const EXTRA_LIST_MAX = 20;

/** Katalog sırasıyla, tekrarsız; katalog dışı anahtarlar atlanır (gösterim için). */
const ordered = (catalog: readonly (readonly [string, string])[], keys: readonly string[]) => {
  const set = new Set(keys);
  return catalog.filter(([k]) => set.has(k)).map(([k, label]) => ({ key: k, label }));
};
export const orderHouseRules = (keys: readonly string[]) => ordered(HOUSE_RULES, keys);
export const orderPriceIncludes = (keys: readonly string[]) => ordered(PRICE_INCLUDES, keys);

/** Olanaklardaki "Evcil hayvan kabul edilir" ile çelişen kural. */
export const PET_AMENITY = "evcil-hayvan";
export const NO_PETS_RULE: HouseRuleKey = "evcil-hayvan-yok";
