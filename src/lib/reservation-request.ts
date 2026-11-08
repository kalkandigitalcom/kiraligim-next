/**
 * Villa sayfasından rezervasyon talebi (F3): sabitler ve saf yardımcılar. Bağımlılıksız: talep
 * formu (tarayıcı), Zod şeması, sunucu servisi ve testler aynı değerleri kullanır.
 *
 * Talep mevcut `reservations` tablosuna "beklemede" ve kaynak "web" olarak yazılır
 * (drizzle/0027). Fiyat ve müsaitlik sunucuda yeniden hesaplanır; istemcinin gönderdiği tutar
 * hiçbir zaman kullanılmaz (formda tutar alanı yoktur).
 */

export const REQUEST_LIMITS = {
  nameMin: 2,
  nameMax: 120,
  emailMax: 254,
  noteMax: 1000,
  /** Kişi sayısı varsayılanı (villa kapasitesiyle sınırlanır). */
  defaultGuests: 2,
  /** Form açıldıktan sonra bu süreden önce gelen gönderim bot sayılır (ms). */
  minFillMs: 2500,
} as const;

/** Veritabanı fonksiyonundaki spam sınırlarıyla aynı (drizzle/0027). */
export const REQUEST_DB_LIMITS = { perHour: 5, openPending: 10 } as const;

/** Varsayılan kişi sayısı: 2, villa kapasitesini aşmadan. */
export const defaultGuests = (maxGuests: number) =>
  Math.max(1, Math.min(REQUEST_LIMITS.defaultGuests, maxGuests));

/** Kişi sayısını [1, kapasite] aralığına sıkıştırır. */
export const clampGuests = (n: number, maxGuests: number) =>
  Math.max(1, Math.min(Math.round(n), Math.max(1, maxGuests)));

export type RequestErrorCode =
  | "invalid"
  | "not_found"
  | "dates_unavailable"
  | "dates_invalid"
  | "min_nights"
  | "guests"
  | "rate_limited"
  | "server_error";

/** Misafire gösterilen hata metinleri: veritabanı/sunucu ayrıntısı içermez. */
export const REQUEST_ERROR_MESSAGES: Record<RequestErrorCode, string> = {
  invalid: "Lütfen işaretli alanları kontrol edin.",
  not_found: "Bu villa şu anda talep kabul etmiyor. WhatsApp'tan ev sahibine ulaşabilirsiniz.",
  dates_unavailable:
    "Seçtiğiniz tarihler artık müsait değil. Takvim güncellendi; lütfen başka tarihler seçin.",
  dates_invalid: "Seçilen tarihler geçerli değil. Lütfen takvimden yeniden seçin.",
  min_nights: "Bu tarihler için minimum konaklama süresi karşılanmıyor.",
  guests: "Kişi sayısı villanın kapasitesini aşıyor.",
  rate_limited:
    "Şu anda çok fazla talep alındı. Lütfen biraz sonra tekrar deneyin ya da WhatsApp'tan yazın.",
  server_error:
    "Talebiniz şu anda gönderilemedi. Bilgileriniz duruyor; lütfen tekrar deneyin ya da WhatsApp'tan yazın.",
};

export type RequestFieldErrors = Partial<
  Record<"name" | "phone" | "email" | "note" | "guests" | "consent" | "checkIn", string>
>;

export type RequestResult =
  | {
      ok: true;
      reference: string;
      checkIn: string;
      checkOut: string;
      guests: number;
      totalMinor: number | null;
      currency: string | null;
    }
  | {
      ok: false;
      code: RequestErrorCode;
      message: string;
      fieldErrors?: RequestFieldErrors;
    };
