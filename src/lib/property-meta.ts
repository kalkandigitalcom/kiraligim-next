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
} as const;

/** "Haritada aç" bağlantısı (OpenStreetMap, yeni sekmede). Gömülü harita kullanılmaz. */
export function mapLink(lat: number, lng: number): string {
  const la = lat.toFixed(6);
  const lo = lng.toFixed(6);
  return `https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=16/${la}/${lo}`;
}
