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

export const publicProfileInput = z
  .object({
    publicSlug: slugField,
    amenities: z
      .array(z.string())
      .default([])
      .superRefine((list, ctx) => {
        const unknown = list.filter((k) => !isAmenityKey(k));
        if (unknown.length > 0)
          ctx.addIssue({ code: "custom", message: "Geçersiz olanak seçimi." });
      })
      // Tekrarsız ve katalog sırasıyla saklanır (karşılaştırma ve gösterim kararlı olsun).
      .transform((list) => orderAmenities(list))
      .refine(
        (list) => list.length <= L.amenitiesMax,
        `En fazla ${L.amenitiesMax} olanak seçilebilir.`,
      ),
    checkInTime: timeField("Giriş saati"),
    checkOutTime: timeField("Çıkış saati"),
    houseRules: textField("Ev kuralları", L.houseRulesMax),
    cancellationPolicy: textField("İptal koşulları", L.cancellationPolicyMax),
    paymentTerms: textField("Ön ödeme ve ödeme koşulları", L.paymentTermsMax),
    /** Yayındaki sayfanın adresi değişirken "eski bağlantı çalışmayacak" onayı. */
    confirmSlugChange: z.preprocess((v) => v === "on" || v === true, z.boolean()),
  })
  .transform((v) => ({
    publicSlug: v.publicSlug ?? null,
    amenities: v.amenities,
    checkInTime: v.checkInTime ?? null,
    checkOutTime: v.checkOutTime ?? null,
    houseRules: v.houseRules ?? null,
    cancellationPolicy: v.cancellationPolicy ?? null,
    paymentTerms: v.paymentTerms ?? null,
    confirmSlugChange: v.confirmSlugChange,
  }));

export type PublicProfileValues = z.output<typeof publicProfileInput>;

export const PUBLIC_PROFILE_FIELDS = [
  "publicSlug",
  "checkInTime",
  "checkOutTime",
  "houseRules",
  "cancellationPolicy",
  "paymentTerms",
] as const;
export type PublicProfileTextField = (typeof PUBLIC_PROFILE_FIELDS)[number];

export type PublicProfileFormRaw = Record<PublicProfileTextField, string> & {
  amenities: string[];
  confirmSlugChange: boolean;
};

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
