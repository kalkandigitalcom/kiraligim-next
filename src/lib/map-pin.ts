/**
 * Harita yöntemleri (Revizyon 2): işletme sahibi villasının yerini iki yoldan biriyle gösterir.
 *   google → Google Haritalar yerleştirme kodu / tam bağlantı (src/lib/map-embed.ts; değişmedi)
 *   pin    → OpenStreetMap üzerinde iğne (Leaflet): yalnız enlem/boylam saklanır.
 * İki yöntemin verisi ayrı kolonlarda tutulur (yöntem değiştirilince diğeri kaybolmaz); misafire
 * yalnız `map_mode` ile seçili yöntem gösterilir. Saf ve bağımlılıksız: Zod şeması, Drizzle CHECK
 * kısıtları, sihirbaz, misafir sayfası ve testler aynı sınırları kullanır.
 */

export const MAP_MODES = ["google", "pin"] as const;
export type MapMode = (typeof MAP_MODES)[number];

export const isMapMode = (v: unknown): v is MapMode => v === "google" || v === "pin";

export const MAP_MODE_LABELS: Record<MapMode, string> = {
  google: "Google Haritalar kodu",
  pin: "Haritada iğne bırak",
};

export type MapPin = { lat: number; lng: number };

/** Veritabanı numeric(8,6) / numeric(9,6): en fazla 6 ondalık. */
export const PIN_DECIMALS = 6;

/** Aralıkta, sonlu ve (0,0) değil ("boş" ada noktası: büyük olasılıkla hatalı giriş). */
export function isValidPin(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Koordinat metni: "36.261234", "-29,4" (virgül de kabul); en fazla 3 tam ve 6 ondalık basamak. */
const COORD_RE = /^-?[0-9]{1,3}(\.[0-9]{1,6})?$/;

export type PinParse =
  { ok: true; pin: MapPin | null } | { ok: false; error: "partial" | "format" | "range" };

export const PIN_PARSE_MESSAGES: Record<"partial" | "format" | "range", string> = {
  partial: "Enlem ve boylamın ikisi de girilmeli (veya haritada bir noktaya dokunun).",
  format: "Koordinat en fazla 6 ondalıklı bir sayı olmalı (ör. 36,261234).",
  range: "Koordinat geçerli aralıkta değil (enlem −90…90, boylam −180…180).",
};

/** Formdaki enlem/boylam metinleri → iğne. İkisi de boşsa iğne yok (geçerli). */
export function parsePinInput(latRaw: unknown, lngRaw: unknown): PinParse {
  const norm = (v: unknown) => (typeof v === "string" ? v.trim().replace(",", ".") : "");
  const a = norm(latRaw);
  const b = norm(lngRaw);
  if (!a && !b) return { ok: true, pin: null };
  if (!a || !b) return { ok: false, error: "partial" };
  if (!COORD_RE.test(a) || !COORD_RE.test(b)) return { ok: false, error: "format" };
  const lat = Number(a);
  const lng = Number(b);
  if (!isValidPin(lat, lng)) return { ok: false, error: "range" };
  return { ok: true, pin: { lat: round6(lat), lng: round6(lng) } };
}

/** Kayıt → form metni (nokta ile, en fazla 6 ondalık; gereksiz sıfırlar atılır). */
export const pinToInput = (n: number | null) => (n === null ? "" : String(round6(n)));

/**
 * Misafire gösterilecek yöntem. Kayıtta seçilen yöntem her zaman açıkça yazılır; o yöntemin
 * verisi yoksa harita gösterilmez (diğer yöntemin verisi olsa bile). Yöntem kolonu NULL ise
 * Revizyon 2 öncesi kayıttır: eski davranış sürer (Google adresi varsa Google haritası).
 */
export function effectiveMapMode(
  mode: MapMode | null,
  embedUrl: string | null,
  pin: MapPin | null,
): MapMode | null {
  if (mode === "pin") return pin ? "pin" : null;
  if (mode === "google") return embedUrl ? "google" : null;
  return embedUrl ? "google" : null;
}

/** "Google Haritalar'da aç" bağlantısı (iğne için). */
export const pinOpenUrl = (p: MapPin) =>
  `https://www.google.com/maps/search/?api=1&query=${p.lat.toFixed(PIN_DECIMALS)},${p.lng.toFixed(PIN_DECIMALS)}`;

// ---------------------------------------------------------------------------
// OpenStreetMap karoları (API anahtarı yok). CSP img-src bu kökene izin verir
// (src/lib/security-headers.ts). OSM karo kullanım politikası: atıf zorunlu, yoğun ticari
// kullanımda ayrı bir karo sağlayıcısı düşünülmeli.
// ---------------------------------------------------------------------------

export const OSM_TILE_ORIGIN = "https://tile.openstreetmap.org";
export const OSM_TILE_URL = `${OSM_TILE_ORIGIN}/{z}/{x}/{y}.png`;
export const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> katkıcıları';
export const OSM_MAX_ZOOM = 19;

/** İğne yokken açılış görünümü: Türkiye. */
export const DEFAULT_VIEW = { lat: 39.0, lng: 35.2, zoom: 5 } as const;
/** İğne varken yakınlaştırma. */
export const PIN_ZOOM = 16;
