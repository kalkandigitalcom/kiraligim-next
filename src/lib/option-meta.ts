/**
 * Opsiyon (kesinleşmemiş rezervasyon) — Aşama 2: veri modeli ve gölge mod sabitleri.
 * Bağımlılıksız: şema, veritabanı fonksiyonları, worker ve testler aynı değerleri kullanır.
 *
 * DEĞİŞMEZ: opsiyon yalnız Kiraligim içinde izlenir. reservation_options hiçbir doluluk
 * sorgusuna, çakışma kısıtına, iCal / API / webhook akışına bağlanmaz; yalnız kesinleşmeden doğan
 * KESİN kayıt (reservations) dış sistemlere yansır.
 */

/** open → (converted | cancelled | expired). Son durumlar değiştirilemez. */
export const OPTION_STATUSES = ["open", "converted", "cancelled", "expired"] as const;
export type OptionStatus = (typeof OPTION_STATUSES)[number];

export const OPTION_SOURCES = ["whatsapp", "panel"] as const;
export type OptionSource = (typeof OPTION_SOURCES)[number];

/** Sona eriş nedeni; durumla uyumu veritabanı denetler (reservation_options_end_state). */
export const OPTION_END_REASONS = {
  converted: ["payment_received", "confirmed_in_panel"],
  cancelled: ["customer_withdrew", "cancelled_by_owner", "cancelled_in_panel"],
  expired: ["expired"],
} as const;
export type OptionEndReason = (typeof OPTION_END_REASONS)[keyof typeof OPTION_END_REASONS][number];
export const OPTION_END_REASON_LIST = [
  ...OPTION_END_REASONS.converted,
  ...OPTION_END_REASONS.cancelled,
  ...OPTION_END_REASONS.expired,
] as const;

/** Süre nereden geldi: mesajda yazan, işletme varsayılanı, panelde elle. Süresiz: null. */
export const OPTION_EXPIRY_SOURCES = ["message", "workspace_default", "manual"] as const;

/** Geçmiş (append-only) olay türleri; tetikleyici yazar. */
export const OPTION_EVENTS = ["created", "updated", "converted", "cancelled", "expired"] as const;

export const OPTION_LIMITS = {
  /** Opsiyon süresi sınırları (saat). */
  minHours: 1,
  maxHours: 14 * 24,
  guestNameMax: 120,
  noteMax: 500,
  waMessageIdMax: 128,
} as const;

// ---------------------------------------------------------------------------------------------
// Gölge mod (wa_option_shadow_decisions)
// ---------------------------------------------------------------------------------------------

/** Mesajın opsiyon işlemi adayı: oluşturma, kesinleştirme, iptal; anlaşılamayan: unknown. */
export const SHADOW_INTENTS = ["create", "convert", "cancel", "unknown"] as const;
export type ShadowIntent = (typeof SHADOW_INTENTS)[number];

/**
 * apply: opsiyon özelliği açık olsaydı otomatik uygulanabilirdi (YALNIZ kayıt; hiçbir şey
 * uygulanmaz). ask: belirsiz / riskli, yöneticiye sorulurdu. ignore: işlem yok (soru, olumsuz).
 */
export const SHADOW_DECISIONS = ["apply", "ask", "ignore"] as const;
export type ShadowDecision = (typeof SHADOW_DECISIONS)[number];

/** Karar nedenleri (kısa kodlar; mesaj içeriği yazılmaz). */
export const SHADOW_REASONS = [
  // Ayrıştırıcı / metin (worker)
  "question",
  "negated",
  "hedged",
  "intent_conflict",
  "intent_unclear",
  "date_missing",
  "date_unclear",
  "date_past",
  "multiple_ranges",
  "villa_unclear",
  "duration_unclear",
  "duration_out_of_bounds",
  "duration_after_check_in",
  // Veritabanı denetimi (app_wa_store_option_shadow)
  "calendar_conflict",
  "option_overlap",
  "no_open_option",
  "multiple_open_options",
  "option_not_open",
  "option_expired",
  "dateless_target_pending",
  "group_without_villa",
] as const;
export type ShadowReason = (typeof SHADOW_REASONS)[number];

/** Gölge modun merkezi ayarı: yalnız "on" açar; tanımsız / başka her değer KAPALI. */
export const OPTION_SHADOW_ENV = "WA_OPTION_SHADOW";
export function optionShadowEnabled(env: Record<string, string | undefined>): boolean {
  return env[OPTION_SHADOW_ENV] === "on";
}
