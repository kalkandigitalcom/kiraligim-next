/**
 * Villa bilgisi revizyonu: yakın yerlere mesafeler, hazır ev kuralları ve fiyata dahil olanlar.
 * Saf ve bağımlılıksız: Drizzle şeması (CHECK kısıtları), Zod şemaları, sihirbaz ve misafir
 * sayfası aynı katalogları kullanır. Anahtarlar veritabanında saklanır; etiket değişse de kayıt
 * bozulmaz. Katalogdan çıkarılan anahtar gösterilmez (yeni kayıtta da kabul edilmez).
 *
 * Revizyon 2'de çıkarılanlar (RETIRED_*): eski kayıtlarda kalabilirler; gösterilmez, formda
 * işaretlenemez; 4. adım bir sonraki kaydedilişinde listeden düşer (veri migration'ı yok).
 */

// ---------------------------------------------------------------------------
// Mesafeler (kayıt km; giriş/gösterim birimi alan başına km veya m)
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

/** Kayıt (km): 0 < değer ≤ 9999,99; numeric(8,3) → 1 m çözünürlük. */
export const DISTANCE_LIMITS = { min: 0, max: 9999.99 } as const;

/**
 * Birim (Revizyon 2): her mesafe için ayrı seçilir; değer kayıtta her zaman km'dir, birim
 * yalnız giriş ve gösterim içindir. NULL birim = Revizyon 2 öncesi kayıt: eski otomatik gösterim
 * (1 km altı metre) sürer.
 */
export const DISTANCE_UNITS = ["km", "m"] as const;
export type DistanceUnit = (typeof DISTANCE_UNITS)[number];
export const isDistanceUnit = (v: unknown): v is DistanceUnit => v === "km" || v === "m";

/** Birim alanlarının form adları (mesafe anahtarıyla aynı sıra). */
export const DISTANCE_UNIT_KEYS = {
  distanceMarketKm: "distanceMarketUnit",
  distanceRestaurantKm: "distanceRestaurantUnit",
  distanceCenterKm: "distanceCenterUnit",
  distanceBeachKm: "distanceBeachUnit",
  distanceAirportAytKm: "distanceAirportAytUnit",
  distanceAirportDlmKm: "distanceAirportDlmUnit",
  distanceHealthKm: "distanceHealthUnit",
} as const satisfies Record<DistanceKey, string>;
export type DistanceUnitKey = (typeof DISTANCE_UNIT_KEYS)[DistanceKey];
export const DISTANCE_UNIT_FIELDS = DISTANCE_KEYS.map((k) => DISTANCE_UNIT_KEYS[k]);

/** Birim kolonları. */
export const DISTANCE_UNIT_COLUMNS: Record<DistanceKey, string> = {
  distanceMarketKm: "distance_market_unit",
  distanceRestaurantKm: "distance_restaurant_unit",
  distanceCenterKm: "distance_center_unit",
  distanceBeachKm: "distance_beach_unit",
  distanceAirportAytKm: "distance_airport_ayt_unit",
  distanceAirportDlmKm: "distance_airport_dlm_unit",
  distanceHealthKm: "distance_health_unit",
};

/** Giriş sınırları: km en fazla 2 ondalık; metre tam sayı. */
export const DISTANCE_INPUT_LIMITS = {
  km: { max: 9999.99, decimals: 2 },
  m: { max: 99999, decimals: 0 },
} as const;

/** Eski kayıtların birimi: 1 km altı metre (Revizyon 2 öncesi gösterimle aynı). */
export const legacyUnit = (km: number): DistanceUnit => (km < 1 ? "m" : "km");

export type DistanceParse =
  { ok: true; km: number | null } | { ok: false; error: "format" | "zero" | "max" };

/** Form metni + birim → km. Boş → null. "1,5" / "1.5" kabul; metrede ondalık yok. */
export function parseDistanceInput(raw: unknown, unit: DistanceUnit): DistanceParse {
  const t = typeof raw === "string" ? raw.trim().replace(",", ".") : "";
  if (!t) return { ok: true, km: null };
  const re = unit === "m" ? /^[0-9]{1,5}$/ : /^[0-9]{1,4}(\.[0-9]{1,2})?$/;
  if (!re.test(t)) return { ok: false, error: "format" };
  const n = Number(t);
  if (!(n > 0)) return { ok: false, error: "zero" };
  if (n > DISTANCE_INPUT_LIMITS[unit].max) return { ok: false, error: "max" };
  const km = unit === "m" ? n / 1000 : n;
  return { ok: true, km: Math.round(km * 1000) / 1000 };
}

export const DISTANCE_PARSE_MESSAGES: Record<
  DistanceUnit,
  Record<"format" | "zero" | "max", string>
> = {
  km: {
    format: "km cinsinden, en fazla 2 ondalıklı bir sayı girin (ör. 1,5).",
    zero: "0'dan büyük olmalı.",
    max: `en fazla ${DISTANCE_INPUT_LIMITS.km.max.toLocaleString("tr-TR")} km olabilir.`,
  },
  m: {
    format: "metre cinsinden tam sayı girin (ör. 500).",
    zero: "0'dan büyük olmalı.",
    max: `en fazla ${DISTANCE_INPUT_LIMITS.m.max.toLocaleString("tr-TR")} m olabilir.`,
  },
};

/**
 * Türkçe gösterim. Birim seçilmişse o birimle ("500 m", "1,5 km", "1.250 m"); eski kayıtta
 * (birim NULL) Revizyon 2 öncesi otomatik gösterim: 1 km altı metre, üstü en fazla bir ondalık.
 */
export function formatDistance(km: number, unit: DistanceUnit | null = null): string {
  if (unit === "m") return `${Math.round(km * 1000).toLocaleString("tr-TR")} m`;
  if (unit === "km") return `${km.toLocaleString("tr-TR", { maximumFractionDigits: 2 })} km`;
  if (km < 1) return `${Math.max(10, Math.round((km * 1000) / 10) * 10)} m`;
  const v = km < 10 ? Math.round(km * 10) / 10 : Math.round(km);
  return `${v.toLocaleString("tr-TR", { maximumFractionDigits: 1 })} km`;
}

/** Form gösterimi (kayıt → form) seçili birimle: km "2,5"; m "500"; boş → "". */
export function distanceToInput(km: number | null, unit: DistanceUnit = "km"): string {
  if (km === null) return "";
  if (unit === "m") return String(Math.round(km * 1000));
  return km.toLocaleString("tr-TR", { maximumFractionDigits: 2, useGrouping: false });
}

/** Formda gösterilecek birim: kayıtlı birim; yoksa eski kayıt için legacyUnit; değer yoksa km. */
export const distanceFormUnit = (km: number | null, unit: DistanceUnit | null): DistanceUnit =>
  unit ?? (km === null ? "km" : legacyUnit(km));

// ---------------------------------------------------------------------------
// Ev kuralları (hazır seçenekler) ve fiyata dahil olanlar
// ---------------------------------------------------------------------------

export const HOUSE_RULES = [
  ["evcil-hayvan-yok", "Evcil hayvan kabul edilmez"],
  ["sigara-icilmez", "Sigara içilmez"],
  ["parti-yok", "Parti ve etkinlik yapılamaz"],
  ["cocuklar-uygun", "Çocuklar için uygundur"],
  ["sessizlik-saatleri", "Sessizlik saatlerine uyulmalıdır"],
  ["ziyaretci-yok", "Konaklayanlar dışında misafir kabul edilmez"],
] as const;
export type HouseRuleKey = (typeof HOUSE_RULES)[number][0];

export const PRICE_INCLUDES = [
  ["elektrik", "Elektrik"],
  ["su", "Su"],
  ["internet", "İnternet / Wi-Fi"],
  ["havuz-bakimi", "Havuz bakımı"],
  ["bahce-bakimi", "Bahçe bakımı"],
  ["klima", "Klima kullanımı"],
] as const;
export type PriceIncludeKey = (typeof PRICE_INCLUDES)[number][0];

/** Revizyon 2'de katalogdan çıkarılan anahtarlar (eski kayıtlarda kalabilir; gösterilmez). */
export const RETIRED_HOUSE_RULES = ["kimlik-zorunlu", "havuz-gozetim"] as const;
export const RETIRED_PRICE_INCLUDES = ["temizlik", "isitma"] as const;

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
