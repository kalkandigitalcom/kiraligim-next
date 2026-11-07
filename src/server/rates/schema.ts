import { z } from "zod";

import { RATE_LIMITS as L } from "@/lib/rate-meta";
import {
  checkInWindow,
  CURRENCIES,
  isIsoDate,
  nightsBetween,
  parseAmount,
  toMinor,
} from "@/lib/reservation-meta";

/**
 * Fiyat dönemi formu doğrulaması. Kurallar veritabanı CHECK'leriyle aynıdır (drizzle/0017, 0018);
 * veritabanı son savunma hattıdır. Form değerleri metin gelir: boş metin "yok" sayılır.
 *
 * Tarih penceresi (başlangıç [bugün − 1 yıl, bugün + 3 yıl]) rezervasyonlarla aynıdır ve yalnız
 * yeni dönemde ya da tarihler değiştiğinde uygulanır: eski bir dönemin fiyatı düzeltilebilir.
 */
export type RateDateRules = { today: string; checkWindow: boolean };

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const isoDate = (label: string) =>
  z
    .string({ error: `${label} gerekli.` })
    .trim()
    .min(1, { error: `${label} gerekli.`, abort: true })
    .refine(isIsoDate, `${label} geçerli bir tarih olmalı.`);

/** Tutar (ana birim metni, ör. "5.000" ya da "12.500,50") → kuruş; boş → undefined. */
const amount = (label: string) =>
  z.preprocess(
    (v) => (typeof v === "string" ? parseAmount(v) : v),
    z
      .number({ error: `${label} geçerli bir tutar olmalı (ör. 5.000 veya 5.000,50).` })
      .refine(
        (n) => !Number.isNaN(n),
        `${label} geçerli bir tutar olmalı (ör. 5.000 veya 5.000,50).`,
      )
      .refine((n) => n > 0, `${label} sıfırdan büyük olmalı.`)
      .transform(toMinor)
      .refine((n) => n <= L.amountMaxMinor, `${label} çok büyük.`)
      .optional(),
  );

export function rateInput(rules: RateDateRules) {
  return z
    .object({
      startDate: isoDate("Başlangıç tarihi"),
      endDate: isoDate("Bitiş tarihi"),
      nightlyAmount: amount("Gecelik fiyat"),
      weeklyAmount: amount("Haftalık fiyat"),
      currency: z.preprocess(
        blankToUndefined,
        z.enum(CURRENCIES, { error: "Para birimini seçin." }),
      ),
      minNights: z.preprocess(
        (v) => {
          if (typeof v !== "string") return v;
          const t = v.trim();
          return t === "" ? undefined : Number(t);
        },
        z
          .number({ error: "Minimum konaklama bir sayı olmalı." })
          .int("Minimum konaklama tam sayı olmalı.")
          .min(L.minNightsMin, `Minimum konaklama en az ${L.minNightsMin} gece olmalı.`)
          .max(L.minNightsMax, `Minimum konaklama en fazla ${L.minNightsMax} gece olabilir.`)
          .optional(),
      ),
    })
    .superRefine((v, ctx) => {
      const nights = nightsBetween(v.startDate, v.endDate);
      if (nights <= 0) {
        ctx.addIssue({
          code: "custom",
          path: ["endDate"],
          message: "Bitiş tarihi başlangıç tarihinden sonra olmalı.",
        });
      } else if (nights > L.maxNights) {
        ctx.addIssue({
          code: "custom",
          path: ["endDate"],
          message: `Bir fiyat dönemi en fazla ${L.maxNights} gece olabilir.`,
        });
      }
      if (rules.checkWindow) {
        const w = checkInWindow(rules.today);
        if (v.startDate < w.min || v.startDate > w.max) {
          ctx.addIssue({
            code: "custom",
            path: ["startDate"],
            message: "Başlangıç tarihi en fazla 1 yıl geçmişte ve 3 yıl ileride olabilir.",
          });
        }
      }
      if (v.nightlyAmount === undefined && v.weeklyAmount === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["nightlyAmount"],
          message: "Gecelik veya haftalık fiyattan en az birini girin.",
        });
      }
    })
    .transform((v) => ({
      startDate: v.startDate,
      endDate: v.endDate,
      nightlyAmountMinor: v.nightlyAmount ?? null,
      weeklyAmountMinor: v.weeklyAmount ?? null,
      currency: v.currency,
      minNights: v.minNights ?? null,
    }));
}

export type RateValues = z.output<ReturnType<typeof rateInput>>;

/** Formdaki alan adları (FormData → nesne). */
export const RATE_FIELDS = [
  "startDate",
  "endDate",
  "nightlyAmount",
  "weeklyAmount",
  "currency",
  "minNights",
] as const;
export type RateField = (typeof RATE_FIELDS)[number];

export function rateFormValues(data: FormData): Record<RateField, string> {
  const out = {} as Record<RateField, string>;
  for (const k of RATE_FIELDS) {
    const v = data.get(k);
    out[k] = typeof v === "string" ? v : "";
  }
  return out;
}
