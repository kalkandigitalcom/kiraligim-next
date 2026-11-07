import { z } from "zod";

import { PROPERTY_LIMITS as L, PROPERTY_STATUSES, PROPERTY_TYPES } from "@/lib/property-meta";
import { TR_PROVINCES } from "@/lib/tr-provinces";

/**
 * Mülk formu doğrulaması. Kurallar veritabanı CHECK'leriyle aynıdır (src/db/schema/properties.ts);
 * veritabanı son savunma hattıdır. Form değerleri metin gelir: boş metin "yok" sayılır.
 */

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const text = (min: number, max: number, label: string) =>
  z
    .string({ error: `${label} gerekli.` })
    .trim()
    .min(1, { error: `${label} gerekli.`, abort: true })
    .min(min, `${label} en az ${min} karakter olmalı.`)
    .max(max, `${label} en fazla ${max} karakter olabilir.`);

const optionalText = (max: number, label: string) =>
  z.preprocess(
    blankToUndefined,
    z.string().trim().max(max, `${label} en fazla ${max} karakter olabilir.`).optional(),
  );

/** Boş → "gerekli", sayı olmayan → "bir sayı olmalı" (NaN da reddedilir). */
const int = (min: number, max: number, label: string) =>
  z.preprocess(
    (v) => {
      if (typeof v !== "string") return v;
      const t = v.trim();
      return t === "" ? undefined : Number(t);
    },
    z
      .number({
        error: (iss) =>
          iss.input === undefined ? `${label} gerekli.` : `${label} bir sayı olmalı.`,
      })
      .int(`${label} tam sayı olmalı.`)
      .min(min, `${label} en az ${min} olmalı.`)
      .max(max, `${label} en fazla ${max} olabilir.`),
  );

const intDefaultZero = (max: number, label: string) =>
  z.preprocess((v) => (blankToUndefined(v) === undefined ? 0 : v), int(0, max, label));

const coordinate = (min: number, max: number, label: string) =>
  z.preprocess(
    (v) => (typeof v === "string" ? (blankToUndefined(v.replace(",", ".")) ?? undefined) : v),
    z.coerce
      .number({ error: `${label} bir sayı olmalı.` })
      .min(min, `${label} ${min} ile ${max} arasında olmalı.`)
      .max(max, `${label} ${min} ile ${max} arasında olmalı.`)
      // Veritabanı numeric(9,6): 6 ondalık basamağa yuvarlanır.
      .transform((n) => Math.round(n * 1e6) / 1e6)
      .optional(),
  );

export const propertyInput = z
  .object({
    name: text(L.nameMin, L.nameMax, "Mülk adı"),
    propertyType: z.enum(PROPERTY_TYPES, { error: "Mülk türünü seçin." }),
    description: optionalText(L.descriptionMax, "Açıklama"),
    maxGuests: int(L.guestsMin, L.guestsMax, "Kişi kapasitesi"),
    bedrooms: int(0, L.roomsMax, "Yatak odası sayısı"),
    bathrooms: int(0, L.roomsMax, "Banyo sayısı"),
    bedsDouble: intDefaultZero(L.bedsMax, "Çift kişilik yatak"),
    bedsSingle: intDefaultZero(L.bedsMax, "Tek kişilik yatak"),
    bedsSofa: intDefaultZero(L.bedsMax, "Çekyat / kanepe yatak"),
    province: z.enum(TR_PROVINCES, { error: "İl seçin." }),
    district: text(2, L.placeMax, "İlçe"),
    neighborhood: optionalText(L.neighborhoodMax, "Mahalle / köy"),
    addressLine: optionalText(L.addressMax, "Açık adres"),
    postalCode: z.preprocess(
      blankToUndefined,
      z
        .string()
        .trim()
        .regex(/^[0-9]{5}$/, "Posta kodu 5 haneli olmalı.")
        .optional(),
    ),
    latitude: coordinate(-90, 90, "Enlem"),
    longitude: coordinate(-180, 180, "Boylam"),
  })
  .superRefine((v, ctx) => {
    if ((v.latitude === undefined) !== (v.longitude === undefined)) {
      const path = v.latitude === undefined ? "latitude" : "longitude";
      ctx.addIssue({
        code: "custom",
        path: [path],
        message: "Enlem ve boylam birlikte girilmeli.",
      });
    }
  });

export type PropertyInput = z.infer<typeof propertyInput>;

/** Formdaki alan adları (FormData → nesne). */
export const PROPERTY_FIELDS = [
  "name",
  "propertyType",
  "description",
  "maxGuests",
  "bedrooms",
  "bathrooms",
  "bedsDouble",
  "bedsSingle",
  "bedsSofa",
  "province",
  "district",
  "neighborhood",
  "addressLine",
  "postalCode",
  "latitude",
  "longitude",
] as const satisfies readonly (keyof PropertyInput)[];

export type PropertyField = (typeof PROPERTY_FIELDS)[number];

export function propertyFormValues(data: FormData): Record<PropertyField, string> {
  const out = {} as Record<PropertyField, string>;
  for (const k of PROPERTY_FIELDS) {
    const v = data.get(k);
    out[k] = typeof v === "string" ? v : "";
  }
  return out;
}

export const propertyStatusInput = z.enum(PROPERTY_STATUSES);
