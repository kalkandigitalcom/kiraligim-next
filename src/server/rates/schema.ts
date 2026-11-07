import { z } from "zod";

import { endFromLastNight, RATE_LIMITS as L } from "@/lib/rate-meta";
import {
  checkInWindow,
  CURRENCIES,
  isIsoDate,
  nightsBetween,
  parseAmount,
  toMinor,
} from "@/lib/reservation-meta";

/**
 * Fiyat dönemi formu doğrulaması. Kullanıcı başlangıç ve bitişi DAHİL girer (bitiş = son fiyatlı
 * gece, alan adı lastNight); çıktı veritabanı biçimindedir: endDate = son gece + 1 (hariç sınır).
 * Kurallar veritabanı CHECK'leriyle aynıdır (drizzle/0017, 0018);
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
const amount = (label: string, opts: { allowZero?: boolean } = {}) =>
  z.preprocess(
    (v) => (typeof v === "string" ? parseAmount(v) : v),
    z
      .number({ error: `${label} geçerli bir tutar olmalı (ör. 5.000 veya 5.000,50).` })
      .refine(
        (n) => !Number.isNaN(n),
        `${label} geçerli bir tutar olmalı (ör. 5.000 veya 5.000,50).`,
      )
      .refine(
        (n) => (opts.allowZero ? n >= 0 : n > 0),
        opts.allowZero ? `${label} negatif olamaz.` : `${label} sıfırdan büyük olmalı.`,
      )
      .transform(toMinor)
      .refine((n) => n <= L.amountMaxMinor, `${label} çok büyük.`)
      .optional(),
  );

export function rateInput(rules: RateDateRules) {
  return z
    .object({
      startDate: isoDate("Başlangıç tarihi"),
      /** Bitiş günü (DAHİL). Saklanırken ertesi gün hariç bitiş sınırına çevrilir. */
      lastNight: isoDate("Bitiş tarihi"),
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
      ) /** Temizlik ücreti (3.3): isteğe bağlı; 0 → ücret yok. */,
      cleaningFee: amount("Temizlik ücreti", { allowZero: true }),
      cleaningFeeFreeNights: z.preprocess(
        (v) => {
          if (typeof v !== "string") return v;
          const t = v.trim();
          return t === "" ? undefined : Number(t);
        },
        z
          .number({ error: "Gece sınırı bir sayı olmalı." })
          .int("Gece sınırı tam sayı olmalı.")
          .min(L.minNightsMin, `Gece sınırı en az ${L.minNightsMin} olmalı.`)
          .max(L.minNightsMax, `Gece sınırı en fazla ${L.minNightsMax} olabilir.`)
          .optional(),
      ),
    })
    .superRefine((v, ctx) => {
      const nights = nightsBetween(v.startDate, v.lastNight) + 1;
      if (nights <= 0) {
        ctx.addIssue({
          code: "custom",
          path: ["lastNight"],
          message: "Bitiş tarihi başlangıç tarihinden önce olamaz.",
        });
      } else if (nights > L.maxNights) {
        ctx.addIssue({
          code: "custom",
          path: ["lastNight"],
          message: `Bir fiyat dönemi en fazla ${L.maxNights} gün olabilir.`,
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
      if (v.cleaningFeeFreeNights !== undefined && v.cleaningFee === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["cleaningFee"],
          message: "Gece sınırı için temizlik ücretini girin.",
        });
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
      endDate: endFromLastNight(v.lastNight),
      nightlyAmountMinor: v.nightlyAmount ?? null,
      weeklyAmountMinor: v.weeklyAmount ?? null,
      currency: v.currency,
      minNights: v.minNights ?? null,
      cleaningFeeMinor: v.cleaningFee ?? null,
      cleaningFeeFreeNights: v.cleaningFeeFreeNights ?? null,
    }));
}

export type RateValues = z.output<ReturnType<typeof rateInput>>;

/** Formdaki alan adları (FormData → nesne). */
export const RATE_FIELDS = [
  "startDate",
  "lastNight",
  "nightlyAmount",
  "weeklyAmount",
  "currency",
  "minNights",
  "cleaningFee",
  "cleaningFeeFreeNights",
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
