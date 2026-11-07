import { z } from "zod";

import {
  checkInWindow,
  CURRENCIES,
  isIsoDate,
  nightsBetween,
  parseAmount,
  RESERVATION_LIMITS as L,
  RESERVATION_SOURCES,
  toMinor,
} from "@/lib/reservation-meta";

/**
 * Rezervasyon ve blok formu doğrulaması. Kurallar veritabanı CHECK'leri ve tetikleyicisiyle
 * aynıdır (drizzle/0015, 0016); veritabanı son savunma hattıdır. Form değerleri metin gelir:
 * boş metin "yok" sayılır.
 */

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const isoDate = (label: string) =>
  z
    .string({ error: `${label} gerekli.` })
    .trim()
    .min(1, { error: `${label} gerekli.`, abort: true })
    .refine(isIsoDate, `${label} geçerli bir tarih olmalı.`);

const optionalText = (max: number, label: string) =>
  z.preprocess(
    blankToUndefined,
    z.string().trim().max(max, `${label} en fazla ${max} karakter olabilir.`).optional(),
  );

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

/** Tutar (ana birim metni) → kuruş; boş → undefined. */
const amount = (label: string) =>
  z.preprocess(
    (v) => (typeof v === "string" ? parseAmount(v) : v),
    z
      .number({ error: `${label} geçerli bir tutar olmalı (ör. 12.500,00).` })
      .refine((n) => !Number.isNaN(n), `${label} geçerli bir tutar olmalı (ör. 12.500,00).`)
      .refine((n) => n >= 0, `${label} negatif olamaz.`)
      .transform(toMinor)
      .refine((n) => n <= L.amountMaxMinor, `${label} çok büyük.`)
      .optional(),
  );

const PHONE = /^\+?[0-9][0-9 ()-]{5,18}[0-9]$/;

export type DateRules = {
  /** Europe/Istanbul bugünü (YYYY-MM-DD). */
  today: string;
  /** Giriş tarihi [bugün − 1 yıl, bugün + 3 yıl] denetimi (düzenlemede yalnız tarih değişirse). */
  checkWindow: boolean;
};

function refineDates(
  v: { checkIn: string; checkOut: string },
  ctx: z.RefinementCtx,
  rules: DateRules,
) {
  const nights = nightsBetween(v.checkIn, v.checkOut);
  if (nights <= 0) {
    ctx.addIssue({
      code: "custom",
      path: ["checkOut"],
      message: "Çıkış tarihi giriş tarihinden sonra olmalı.",
    });
  } else if (nights > L.maxNights) {
    ctx.addIssue({
      code: "custom",
      path: ["checkOut"],
      message: `Konaklama en fazla ${L.maxNights} gece olabilir.`,
    });
  }
  if (rules.checkWindow) {
    const w = checkInWindow(rules.today);
    if (v.checkIn < w.min || v.checkIn > w.max) {
      ctx.addIssue({
        code: "custom",
        path: ["checkIn"],
        message: "Giriş tarihi en fazla 1 yıl geçmişte ve 3 yıl ileride olabilir.",
      });
    }
  }
}

export function reservationInput(rules: DateRules) {
  return z
    .object({
      checkIn: isoDate("Giriş tarihi"),
      checkOut: isoDate("Çıkış tarihi"),
      status: z.preprocess(
        (v) => blankToUndefined(v) ?? "confirmed",
        z.enum(["pending", "confirmed"], { error: "Geçersiz durum." }),
      ),
      source: z.preprocess(
        (v) => blankToUndefined(v) ?? "direct",
        z.enum(RESERVATION_SOURCES, { error: "Rezervasyon kaynağını seçin." }),
      ),
      guestName: z
        .string({ error: "Misafir adı gerekli." })
        .trim()
        .min(1, { error: "Misafir adı gerekli.", abort: true })
        .min(L.guestNameMin, `Misafir adı en az ${L.guestNameMin} karakter olmalı.`)
        .max(L.guestNameMax, `Misafir adı en fazla ${L.guestNameMax} karakter olabilir.`),
      guestPhone: z.preprocess(
        (v) => (typeof v === "string" ? blankToUndefined(v.trim().replace(/\s+/g, " ")) : v),
        z
          .string()
          .regex(PHONE, "Telefon numarası geçerli değil (ör. +90 532 123 45 67).")
          .optional(),
      ),
      guestEmail: z.preprocess(
        (v) => (typeof v === "string" ? blankToUndefined(v.trim().toLowerCase()) : v),
        z
          .email("E-posta adresi geçerli değil.")
          .max(L.emailMax, "E-posta adresi çok uzun.")
          .optional(),
      ),
      adults: int(L.adultsMin, L.guestsMax, "Yetişkin sayısı"),
      children: z.preprocess(
        (v) => (blankToUndefined(v) === undefined ? 0 : v),
        int(0, L.guestsMax, "Çocuk sayısı"),
      ),
      totalAmount: amount("Toplam tutar"),
      depositAmount: amount("Ön ödeme"),
      currency: z.preprocess(
        blankToUndefined,
        z.enum(CURRENCIES, { error: "Para birimini seçin." }).optional(),
      ),
      note: optionalText(L.noteMax, "Not"),
    })
    .superRefine((v, ctx) => {
      refineDates(v, ctx, rules);
      if (v.depositAmount !== undefined && v.totalAmount === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["totalAmount"],
          message: "Ön ödeme için önce toplam tutarı girin.",
        });
      } else if (
        v.depositAmount !== undefined &&
        v.totalAmount !== undefined &&
        v.depositAmount > v.totalAmount
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["depositAmount"],
          message: "Ön ödeme toplam tutardan büyük olamaz.",
        });
      }
      if (v.totalAmount !== undefined && v.currency === undefined) {
        ctx.addIssue({ code: "custom", path: ["currency"], message: "Para birimini seçin." });
      }
    })
    .transform((v) => ({
      type: "reservation" as const,
      checkIn: v.checkIn,
      checkOut: v.checkOut,
      status: v.status,
      source: v.source,
      guestName: v.guestName,
      guestPhone: v.guestPhone ?? null,
      guestEmail: v.guestEmail ?? null,
      adults: v.adults,
      children: v.children,
      totalAmountMinor: v.totalAmount ?? null,
      depositAmountMinor: v.totalAmount === undefined ? null : (v.depositAmount ?? null),
      // Toplam yoksa para birimi de yok (veritabanı kuralı).
      currency: v.totalAmount === undefined ? null : (v.currency ?? null),
      note: v.note ?? null,
    }));
}

export function blockInput(rules: DateRules) {
  return z
    .object({
      checkIn: isoDate("Başlangıç tarihi"),
      checkOut: isoDate("Bitiş tarihi"),
      note: optionalText(L.noteMax, "Açıklama"),
    })
    .superRefine((v, ctx) => refineDates(v, ctx, rules))
    .transform((v) => ({
      type: "block" as const,
      checkIn: v.checkIn,
      checkOut: v.checkOut,
      note: v.note ?? null,
    }));
}

export type ReservationValues = z.output<ReturnType<typeof reservationInput>>;
export type BlockValues = z.output<ReturnType<typeof blockInput>>;

export const cancelReasonInput = z.preprocess(
  blankToUndefined,
  z
    .string()
    .trim()
    .max(L.cancelReasonMax, `İptal nedeni en fazla ${L.cancelReasonMax} karakter olabilir.`)
    .optional(),
);

/** Formdaki alan adları (FormData → nesne). */
export const RESERVATION_FIELDS = [
  "kind",
  "propertyId",
  "checkIn",
  "checkOut",
  "status",
  "source",
  "guestName",
  "guestPhone",
  "guestEmail",
  "adults",
  "children",
  "totalAmount",
  "depositAmount",
  "currency",
  "note",
] as const;
export type ReservationField = (typeof RESERVATION_FIELDS)[number];

export function reservationFormValues(data: FormData): Record<ReservationField, string> {
  const out = {} as Record<ReservationField, string>;
  for (const k of RESERVATION_FIELDS) {
    const v = data.get(k);
    out[k] = typeof v === "string" ? v : "";
  }
  return out;
}
