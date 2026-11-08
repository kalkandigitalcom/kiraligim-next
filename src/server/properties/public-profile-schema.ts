import { z } from "zod";

import {
  CONTROL_CHARS_RE,
  isAmenityKey,
  isHhMm,
  normalizeWhatsapp,
  orderAmenities,
  PUBLIC_PROFILE_LIMITS as L,
  SLUG_PROBLEM_MESSAGES,
  slugProblem,
} from "@/lib/public-profile-meta";
import { EXTRA_LIST_MAX, HOUSE_RULES, PRICE_INCLUDES } from "@/lib/villa-extras";

/**
 * Villa sayfası formu (F1). Kurallar veritabanı CHECK'leriyle aynıdır (drizzle/0022); veritabanı son
 * savunma hattıdır. Form değerleri metin gelir: boş metin "yok" sayılır. Metinler düz metindir.
 */

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const slugField = z.preprocess(
  (v) => (typeof v === "string" ? (v.trim() === "" ? undefined : v.trim().toLowerCase()) : v),
  z
    .string()
    .superRefine((s, ctx) => {
      const p = slugProblem(s);
      if (p) ctx.addIssue({ code: "custom", message: SLUG_PROBLEM_MESSAGES[p] });
    })
    .optional(),
);

const timeField = (label: string) =>
  z.preprocess(
    blank,
    z.string().refine(isHhMm, `${label} SS:DD biçiminde olmalı (ör. 16:00).`).optional(),
  );

const textField = (label: string, max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim() || undefined : v),
    z
      .string()
      .max(max, `${label} en fazla ${max.toLocaleString("tr-TR")} karakter olabilir.`)
      .refine((s) => !CONTROL_CHARS_RE.test(s), `${label} geçersiz karakter içeriyor.`)
      .optional(),
  );

// Alan tanımları tek yerde: birleşik form (F1, uyumluluk) ve ayrık formlar (Aşama 2) aynı kuralları
// kullanır.
const amenitiesField = z
  .array(z.string())
  .default([])
  .superRefine((list, ctx) => {
    const unknown = list.filter((k) => !isAmenityKey(k));
    if (unknown.length > 0) ctx.addIssue({ code: "custom", message: "Geçersiz olanak seçimi." });
  })
  // Tekrarsız ve katalog sırasıyla saklanır (karşılaştırma ve gösterim kararlı olsun).
  .transform((list) => orderAmenities(list))
  .refine(
    (list) => list.length <= L.amenitiesMax,
    `En fazla ${L.amenitiesMax} olanak seçilebilir.`,
  );

/**
 * Hazır seçim listesi (ev kuralları, fiyata dahil olanlar). Katalog dışı anahtar reddedilir;
 * tekrarsız ve katalog sırasıyla saklanır. Gönderilmezse (undefined) kayıttaki değer korunur.
 */
const keyListField = (catalog: readonly (readonly [string, string])[], label: string) =>
  z
    .array(z.string())
    .superRefine((list, ctx) => {
      const keys = new Set(catalog.map(([k]) => k));
      if (list.some((k) => !keys.has(k))) {
        ctx.addIssue({ code: "custom", message: `Geçersiz ${label} seçimi.` });
      }
    })
    .transform((list) => {
      const set = new Set(list);
      return catalog.map(([k]) => k).filter((k) => set.has(k));
    })
    .refine(
      (list) => list.length <= EXTRA_LIST_MAX,
      `En fazla ${EXTRA_LIST_MAX} seçim yapılabilir.`,
    )
    .optional();

const stayShape = {
  amenities: amenitiesField,
  houseRuleKeys: keyListField(HOUSE_RULES, "kural"),
  priceIncludes: keyListField(PRICE_INCLUDES, "fiyata dahil"),
  checkInTime: timeField("Giriş saati"),
  checkOutTime: timeField("Çıkış saati"),
  houseRules: textField("Ek not", L.houseRulesMax),
  // Revizyon 2: iptal ve ödeme koşulları kaldırıldı. Eski istemciden gelse de şema bilinmeyen
  // alanları atar; kolonlar ayrı daraltma migration'ına kadar veritabanında yalnız durur.
};

const slugShape = {
  publicSlug: slugField,
  /** Yayındaki sayfanın adresi değişirken "eski bağlantı çalışmayacak" onayı. */
  confirmSlugChange: z.preprocess((v) => v === "on" || v === true, z.boolean()),
};

const stayOut = (v: {
  amenities: string[];
  houseRuleKeys?: string[] | undefined;
  priceIncludes?: string[] | undefined;
  checkInTime?: string;
  checkOutTime?: string;
  houseRules?: string;
}) => ({
  amenities: v.amenities,
  // Gönderilmeyen liste çıktıda hiç yer almaz: birleştirmede kayıttaki değer korunur.
  ...(v.houseRuleKeys === undefined ? {} : { houseRuleKeys: v.houseRuleKeys }),
  ...(v.priceIncludes === undefined ? {} : { priceIncludes: v.priceIncludes }),
  checkInTime: v.checkInTime ?? null,
  checkOutTime: v.checkOutTime ?? null,
  houseRules: v.houseRules ?? null,
});

/** Birleşik villa sayfası ayarları (F1; updatePublicProfile — uyumluluk için korunur). */
export const publicProfileInput = z.object({ ...slugShape, ...stayShape }).transform((v) => ({
  publicSlug: v.publicSlug ?? null,
  ...stayOut(v),
  confirmSlugChange: v.confirmSlugChange,
}));

/** Olanaklar ve konaklama bilgileri (mülk bilgisi; sayfa adresi ve yayın durumu dahil değil). */
export const stayDetailsInput = z.object(stayShape).transform(stayOut);
export type StayDetailsValues = z.output<typeof stayDetailsInput>;

/** Yalnız sayfa adresi (Yayın sayfası). */
export const publicSlugInput = z.object(slugShape).transform((v) => ({
  publicSlug: v.publicSlug ?? null,
  confirmSlugChange: v.confirmSlugChange,
}));
export type PublicSlugValues = z.output<typeof publicSlugInput>;

export type PublicProfileValues = z.output<typeof publicProfileInput>;

export const PUBLIC_PROFILE_FIELDS = [
  "publicSlug",
  "checkInTime",
  "checkOutTime",
  "houseRules",
] as const;
export type PublicProfileTextField = (typeof PUBLIC_PROFILE_FIELDS)[number];

export type PublicProfileFormRaw = Record<PublicProfileTextField, string> & {
  amenities: string[];
  confirmSlugChange: boolean;
};

export const STAY_TEXT_FIELDS = ["checkInTime", "checkOutTime", "houseRules"] as const;
export type StayDetailsFormRaw = Record<(typeof STAY_TEXT_FIELDS)[number], string> & {
  amenities: string[];
  houseRuleKeys: string[];
  priceIncludes: string[];
};
/** Liste (çoklu seçim) alanları. */
export const STAY_LIST_FIELDS = ["amenities", "houseRuleKeys", "priceIncludes"] as const;
export type PublicSlugFormRaw = { publicSlug: string; confirmSlugChange: boolean };

const text = (data: FormData, k: string) => {
  const v = data.get(k);
  return typeof v === "string" ? v : "";
};

/** FormData → olanak ve konaklama formu (hata durumunda forma geri döner). */
export function stayDetailsFormValues(data: FormData): StayDetailsFormRaw {
  const out = {} as StayDetailsFormRaw;
  for (const k of STAY_TEXT_FIELDS) out[k] = text(data, k);
  for (const k of STAY_LIST_FIELDS) {
    out[k] = data.getAll(k).filter((v): v is string => typeof v === "string");
  }
  return out;
}

/** FormData → sayfa adresi formu. */
export function publicSlugFormValues(data: FormData): PublicSlugFormRaw {
  return {
    publicSlug: text(data, "publicSlug"),
    confirmSlugChange: data.get("confirmSlugChange") === "on",
  };
}

/** FormData → ham form nesnesi (hata durumunda forma geri döner). */
export function publicProfileFormValues(data: FormData): PublicProfileFormRaw {
  const out = {} as PublicProfileFormRaw;
  for (const k of PUBLIC_PROFILE_FIELDS) {
    const v = data.get(k);
    out[k] = typeof v === "string" ? v : "";
  }
  out.amenities = data.getAll("amenities").filter((v): v is string => typeof v === "string");
  out.confirmSlugChange = data.get("confirmSlugChange") === "on";
  return out;
}

/** İşletme WhatsApp numarası: boş → kaldır (null); geçersiz → hata. */
export const whatsappInput = z.preprocess(
  (v) => (typeof v === "string" ? v : ""),
  z.string().transform((s, ctx) => {
    if (s.trim() === "") return null;
    const n = normalizeWhatsapp(s);
    if (!n) {
      ctx.addIssue({
        code: "custom",
        message: "Geçerli bir telefon numarası girin (ör. 0532 123 45 67 veya +44 7700 900123).",
      });
      return z.NEVER;
    }
    return n;
  }),
);
