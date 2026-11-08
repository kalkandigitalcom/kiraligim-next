import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { z } from "zod";

import { PG, pgErrorInfo } from "@/db/pg-error";
import type { PublicDb } from "@/db/public";
import type { EmailTransport } from "@/lib/email/types";
import { logger } from "@/lib/logger";
import { CONTROL_CHARS_RE, normalizeWhatsapp } from "@/lib/public-profile-meta";
import { evaluateStay, STAY_INVALID_MESSAGES } from "@/lib/public-stay";
import { formatStay, isIsoDate, istanbulToday, requestReference } from "@/lib/reservation-meta";
import {
  REQUEST_ERROR_MESSAGES as MSG,
  REQUEST_LIMITS as L,
  type RequestErrorCode,
  type RequestFieldErrors,
  type RequestResult,
} from "@/lib/reservation-request";

import { reservationRequestEmail } from "./reservation-request-email";
import { getPublicVilla } from "./villa";

const log = logger.child({ component: "reservation-request" });

/**
 * Villa sayfasından rezervasyon talebi (F3). Oturum yoktur. Akış:
 *  1. Form Zod ile doğrulanır (telefon uluslararası biçime çevrilir; tuzak alan boş olmalı).
 *  2. Villa, public okuma fonksiyonlarıyla yeniden okunur (yayında mı, dolu tarihler, fiyatlar).
 *  3. Müsaitlik, minimum gece ve fiyat MEVCUT evaluateStay / quoteStay ile SUNUCUDA hesaplanır;
 *     istemciden tutar alınmaz. Fiyat hesaplanamıyorsa talep tutarsız kaydedilir (uydurma yok).
 *  4. Kayıt yalnız SECURITY DEFINER app_public_reservation_request ile yazılır (drizzle/0027):
 *     işletme/mülk kimliği sayfa adresinden veritabanında bulunur; çakışma kısıtı eşzamanlı
 *     çakışan talepleri reddeder; villa başına spam sınırı uygulanır.
 *  5. İşletme sahibi ve yöneticilerine misafir bilgisi içermeyen bildirim e-postası (arka planda).
 * Hata ayrıntısı misafire gösterilmez; log'a kişisel veri yazılmaz.
 */

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const isoDate = z
  .string({ error: "Tarih seçin." })
  .refine(isIsoDate, { error: "Tarih geçerli değil." });

export const reservationRequestInput = z
  .object({
    slug: z.string().trim().toLowerCase().min(1).max(80),
    checkIn: isoDate,
    checkOut: isoDate,
    guests: z.coerce
      .number({ error: "Kişi sayısını seçin." })
      .int("Kişi sayısı tam sayı olmalı.")
      .min(1, "En az 1 kişi seçin.")
      .max(50, "Kişi sayısı villanın kapasitesini aşıyor."),
    name: z
      .string({ error: "Ad soyad gerekli." })
      .trim()
      .min(1, { error: "Ad soyad gerekli.", abort: true })
      .min(L.nameMin, `Ad soyad en az ${L.nameMin} karakter olmalı.`)
      .max(L.nameMax, `Ad soyad en fazla ${L.nameMax} karakter olabilir.`)
      .refine((s) => !CONTROL_CHARS_RE.test(s), "Ad soyad geçersiz karakter içeriyor."),
    phone: z
      .string({ error: "Telefon gerekli." })
      .trim()
      .min(1, { error: "Telefon gerekli.", abort: true })
      .transform((s, ctx) => {
        const n = normalizeWhatsapp(s);
        if (!n) {
          ctx.addIssue({
            code: "custom",
            message:
              "Geçerli bir telefon numarası girin (ör. 0532 123 45 67 veya +44 7700 900123).",
          });
          return z.NEVER;
        }
        return n;
      }),
    email: z.preprocess(
      blank,
      z
        .email("Geçerli bir e-posta adresi girin.")
        .max(L.emailMax, "E-posta adresi çok uzun.")
        .transform((s) => s.toLowerCase())
        .optional(),
    ),
    note: z.preprocess(
      (v) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim() || undefined : v),
      z
        .string()
        .max(L.noteMax, `Not en fazla ${L.noteMax} karakter olabilir.`)
        .refine((s) => !CONTROL_CHARS_RE.test(s), "Not geçersiz karakter içeriyor.")
        .optional(),
    ),
    consent: z.literal(true, {
      error: "Talebinizi iletebilmemiz için bilgilendirmeyi onaylayın.",
    }),
    /** Tuzak alan: gerçek kullanıcı görmez ve doldurmaz. */
    website: z.string().max(0).optional(),
    /** Formun açıldığı an (ms); çok hızlı gönderim bot sayılır. */
    openedAt: z.coerce.number().int().optional(),
  })
  .refine((v) => v.checkOut > v.checkIn, {
    path: ["checkIn"],
    message: "Çıkış tarihi girişten sonra olmalı.",
  });

export type ReservationRequestInput = z.input<typeof reservationRequestInput>;

const FIELD_KEYS = new Set(["name", "phone", "email", "note", "guests", "consent", "checkIn"]);

function fieldErrorsOf(err: z.ZodError): RequestFieldErrors {
  const out: RequestFieldErrors = {};
  for (const i of err.issues) {
    const k = String(i.path[0] ?? "");
    const key = (k === "checkOut" ? "checkIn" : k) as keyof RequestFieldErrors;
    if (FIELD_KEYS.has(key) && !out[key]) out[key] = i.message;
  }
  return out;
}

const fail = (
  code: RequestErrorCode,
  extra?: { message?: string; fieldErrors?: RequestFieldErrors },
) =>
  ({
    ok: false as const,
    code,
    message: extra?.message ?? MSG[code],
    ...(extra?.fieldErrors ? { fieldErrors: extra.fieldErrors } : {}),
  }) satisfies RequestResult;

export type RequestDeps = {
  today?: string;
  now?: number;
  /** Bildirim e-postası; yoksa gönderilmez. */
  email?: { transport: EmailTransport; brand: string; appUrl: string } | null;
};

/** Talebi doğrular, sunucuda yeniden fiyatlar ve kaydeder. Hiçbir hata ayrıntısı dışarı sızmaz. */
export async function submitReservationRequest(
  db: PublicDb,
  input: unknown,
  deps: RequestDeps = {},
): Promise<RequestResult> {
  const parsed = reservationRequestInput.safeParse(input);
  if (!parsed.success) {
    const fe = fieldErrorsOf(parsed.error);
    // Tuzak alan / zaman: bota ayrıntı verilmez.
    return fail("invalid", Object.keys(fe).length > 0 ? { fieldErrors: fe } : undefined);
  }
  const v = parsed.data;
  const now = deps.now ?? Date.now();
  if (v.website || (v.openedAt !== undefined && now - v.openedAt < L.minFillMs)) {
    return fail("invalid");
  }

  const today = deps.today ?? istanbulToday();
  let villa;
  try {
    villa = await getPublicVilla(db, null, v.slug, today);
  } catch (err) {
    log.error("reservation_request_failed", { stage: "read", err });
    return fail("server_error");
  }
  if (!villa) return fail("not_found");
  if (v.guests > villa.maxGuests) {
    return fail("guests", {
      fieldErrors: { guests: `Bu villa en fazla ${villa.maxGuests} kişi kabul ediyor.` },
    });
  }

  // Müsaitlik + minimum gece + fiyat: misafirin gördüğü hesaplamanın AYNISI, sunucuda.
  const e = evaluateStay(
    { checkIn: v.checkIn, checkOut: v.checkOut },
    villa.busy,
    villa.window,
    villa.rates,
  );
  if (e.state === "invalid") {
    return e.reason === "busy"
      ? fail("dates_unavailable")
      : fail("dates_invalid", { message: STAY_INVALID_MESSAGES[e.reason] });
  }
  if (e.state === "min-nights") {
    return fail("min_nights", {
      message: `${formatStay(e.checkIn, e.checkOut)} için en az ${e.required} gece konaklama gerekir.`,
    });
  }
  if (e.state !== "quote" && e.state !== "unpriced") return fail("dates_invalid");
  const totalMinor = e.state === "quote" ? e.quote.totalMinor : null;
  const currency = e.state === "quote" ? e.quote.currency : null;

  const id = uuidv7();
  let emails: string[] = [];
  try {
    const rows = await db.transaction(async (tx) => {
      // Oturumsuz bağlam: kullanıcı/işletme ayarı boş. Yazma yalnız definer fonksiyonla.
      await tx.execute(sql`select set_config('app.user_id', '', true),
                                  set_config('app.workspace_id', '', true)`);
      return tx.execute<{ reservation_id: string; notify_emails: string[] }>(sql`
        select reservation_id, notify_emails from app_public_reservation_request(
          ${id}::uuid, ${villa.slug}, ${v.checkIn}::date, ${v.checkOut}::date, ${v.guests}::int,
          ${v.name}, ${v.phone}, ${v.email ?? null}, ${v.note ?? null},
          ${totalMinor}::bigint, ${currency})`);
    });
    emails = rows.rows[0]?.notify_emails ?? [];
  } catch (err) {
    const pg = pgErrorInfo(err);
    if (pg.code === PG.EXCLUSION_VIOLATION) return fail("dates_unavailable");
    switch (pg.message) {
      case "public_request_rate_limited":
        return fail("rate_limited");
      case "public_request_not_found":
        return fail("not_found");
      case "public_request_guests":
        return fail("guests", { fieldErrors: { guests: MSG.guests } });
      case "public_request_dates":
        return fail("dates_invalid");
    }
    if (pg.code === PG.CHECK_VIOLATION) return fail("invalid");
    // Ayrıntı yalnız log'a; kişisel veri yazılmaz (logger hassas anahtarları da maskeler).
    log.error("reservation_request_failed", { stage: "write", code: pg.code ?? null });
    return fail("server_error");
  }

  log.info("reservation_request_created", { reservation: id, recipients: emails.length });
  if (deps.email && emails.length > 0) notifyHosts(deps.email, emails, id, villa.name, v);

  return {
    ok: true,
    reference: requestReference(id),
    checkIn: v.checkIn,
    checkOut: v.checkOut,
    guests: v.guests,
    totalMinor,
    currency,
  };
}

/** Bildirim arka planda gönderilir: yanıtı geciktirmez, hata talebi bozmaz. */
function notifyHosts(
  cfg: NonNullable<RequestDeps["email"]>,
  to: string[],
  id: string,
  villaName: string,
  v: { checkIn: string; checkOut: string; guests: number },
) {
  const msg = reservationRequestEmail({
    brand: cfg.brand,
    villaName,
    checkIn: v.checkIn,
    checkOut: v.checkOut,
    guests: v.guests,
    reference: requestReference(id),
    url: new URL(`/rezervasyonlar/${id}`, cfg.appUrl).toString(),
  });
  for (const address of to) {
    void cfg.transport
      .send({
        to: address,
        ...msg,
        category: "reservation.request",
        idempotencyKey: `reservation-request-${id}-${address}`,
      })
      .catch((err: unknown) =>
        log.error("reservation_request_email_failed", { reservation: id, err }),
      );
  }
}
