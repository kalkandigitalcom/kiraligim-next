/**
 * Mülk sabitleri ve görüntü yardımcıları. Bağımlılıksız: hem sunucu (Drizzle şeması, Zod)
 * hem tarayıcı (form) kullanır. Veritabanı CHECK'leri aynı değerlerle yazılmıştır
 * (drizzle/0009_properties.sql).
 */
export const PROPERTY_TYPES = ["villa", "apart", "bungalow", "ev"] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export const PROPERTY_STATUSES = ["active", "passive"] as const;
export type PropertyStatus = (typeof PROPERTY_STATUSES)[number];

export const PROPERTY_TYPE_LABELS: Record<PropertyType, string> = {
  villa: "Villa",
  apart: "Apart",
  bungalow: "Bungalow",
  ev: "Ev",
};

export const PROPERTY_STATUS_LABELS: Record<PropertyStatus, string> = {
  active: "Aktif",
  passive: "Pasif",
};

export const PROPERTY_LIMITS = {
  nameMin: 2,
  nameMax: 120,
  descriptionMax: 5000,
  guestsMin: 1,
  guestsMax: 50,
  roomsMax: 50,
  bedsMax: 50,
  placeMax: 60,
  neighborhoodMax: 120,
  addressMax: 300,
  /** Biçimlendirilmiş açıklama (HTML) en fazla; düz metin hali descriptionMax ile sınırlıdır. */
  descriptionHtmlMax: 20000,
  /** T.C. Kültür ve Turizm Bakanlığı belge numarası. */
  licenseMax: 40,
  youtubeMax: 10,
  /** Havuz ölçüleri (metre, 2 ondalık). */
  poolDepthMin: 0.1,
  poolDepthMax: 10,
  poolSideMin: 0.5,
  poolSideMax: 100,
} as const;

/** Belge numarasında izin verilen karakterler: harf, rakam, boşluk, - / . */
export const LICENSE_PATTERN = /^[0-9A-Za-zÇĞİÖŞÜçğıöşü][0-9A-Za-zÇĞİÖŞÜçğıöşü ./-]*$/;

export const POOL_KINDS = ["swimming", "indoor", "kids"] as const;
export type PoolKind = (typeof POOL_KINDS)[number];

export const POOL_LABELS: Record<PoolKind, string> = {
  swimming: "Yüzme Havuzu",
  indoor: "Kapalı Havuz",
  kids: "Çocuk Havuzu",
};

/** Havuz ölçüsü: Türkçe gösterim (1,50). */
export const formatMeters = (n: number) =>
  n.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "Haritada aç" bağlantısı (OpenStreetMap, yeni sekmede). Gömülü harita kullanılmaz. */
export function mapLink(lat: number, lng: number): string {
  const la = lat.toFixed(6);
  const lo = lng.toFixed(6);
  return `https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=16/${la}/${lo}`;
}
