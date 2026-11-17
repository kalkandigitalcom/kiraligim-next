/**
 * Opsiyon (kesinleşmemiş rezervasyon) — Aşama 2 / 3a: veri modeli, gölge mod, ayar ve işlem sabitleri.
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
  // Aşama 3 kararı (15 Kasım 2026): müşteri vazgeçti, sahip iptal etti, panelden iptal.
  cancelled: ["customer_declined", "owner_cancelled", "panel_cancel"],
  expired: ["expired"],
} as const;
export type OptionEndReason = (typeof OPTION_END_REASONS)[keyof typeof OPTION_END_REASONS][number];
export const OPTION_END_REASON_LIST = [
  ...OPTION_END_REASONS.converted,
  ...OPTION_END_REASONS.cancelled,
  ...OPTION_END_REASONS.expired,
] as const;

/**
 * Süre nereden geldi: mesajda yazan, işletme varsayılanı, panelde elle, sistem varsayılanı (Faz A,
 * 0075). Süresiz: null.
 */
export const OPTION_EXPIRY_SOURCES = [
  "message",
  "workspace_default",
  "manual",
  "system_default",
] as const;
export type OptionExpirySource = (typeof OPTION_EXPIRY_SOURCES)[number];

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

// ---------------------------------------------------------------------------------------------
// Aşama 3a: otomasyon ayarları ve işlem kayıtları (option_automation_global,
// workspace_option_settings, wa_group_option_settings, option_operations, option_conflict_alerts)
// ---------------------------------------------------------------------------------------------

/**
 * Opsiyon süresi ayarları (dakika). Varsayılan ve seçenekler YALNIZ Super Admin tarafından girilir;
 * hazır liste tohumlanmaz. Sınırlar opsiyon süresi sınırlarıyla aynı (1 saat – 14 gün).
 */
export const OPTION_SETTINGS_LIMITS = {
  minMinutes: OPTION_LIMITS.minHours * 60,
  maxMinutes: OPTION_LIMITS.maxHours * 60,
  maxChoices: 12,
  noteMax: 500,
} as const;

/**
 * Faz A (0075): sistem geneli varsayılan opsiyon süresi (dakika; Super Admin değiştirir). Süre
 * önceliği: mesajda yazan → işletme varsayılanı → sistem varsayılanı. Yazılı süre asla
 * kısaltılmaz; varsayılan girişe taşarsa bitiş giriş anına çekilir, girişe bu kadar dakikadan az
 * kalıyorsa işlem açıklama bekler.
 */
export const OPTION_SYSTEM_DEFAULT_MINUTES = 24 * 60;
export const OPTION_MIN_LEAD_MINUTES = 60;

/** İşlem türü: oluştur, iptal, kesin rezervasyona dönüştür. */
export const OPTION_OPERATION_KINDS = ["create", "cancel", "convert"] as const;
export type OptionOperationKind = (typeof OPTION_OPERATION_KINDS)[number];

/**
 * auto: kural gereği otomatik; needs_approval: Super Admin onayı bekler (eski kayıtlar, iptal ve
 * kesinleştirme); clarify (Faz A, 0075): WhatsApp'tan gelen oluşturma güvenle uygulanamadı,
 * açıklama bekliyor — hiçbir görev uygulamaz, Super Admin onaylayamaz; işletme panelinde listelenir.
 */
export const OPTION_OPERATION_MODES = ["auto", "needs_approval", "clarify"] as const;
export type OptionOperationMode = (typeof OPTION_OPERATION_MODES)[number];

/**
 * pending → approved | rejected; approved → applied | stale | failed. Otomatik uygulanan işlem
 * doğrudan applied (veya failed) olarak yazılır. Son durumlar (applied, rejected, stale, failed)
 * değiştirilemez.
 */
export const OPTION_OPERATION_STATUSES = [
  "pending",
  "approved",
  "applied",
  "rejected",
  "stale",
  "failed",
] as const;
export type OptionOperationStatus = (typeof OPTION_OPERATION_STATUSES)[number];
export const OPTION_OPERATION_FINAL = ["applied", "rejected", "stale", "failed"] as const;

/** İşlemin onaya düşme / başarısızlık nedenleri (kısa kodlar; mesaj içeriği yazılmaz). */
export const OPTION_OPERATION_REASONS = [
  ...SHADOW_REASONS,
  "duration_missing",
  "guest_info_missing",
  "automation_off",
  "property_inactive",
  // Faz A (0075): varsayılan süre girişe kısaltılınca girişe 60 dakikadan az kalıyor.
  "check_in_too_close",
] as const;
export type OptionOperationReason = (typeof OPTION_OPERATION_REASONS)[number];

/** WhatsApp'tan iptal nedeni yalnız bu ikisi olabilir; panel_cancel yalnız Super Admin'den. */
export const OPTION_WHATSAPP_CANCEL_REASONS = ["customer_declined", "owner_cancelled"] as const;

/** Çakışma uyarısının kaynağı: Kiraligim kaydı (rezervasyon / blok) veya harici takvim olayı. */
export const OPTION_ALERT_SOURCES = ["reservation", "external_event"] as const;
export type OptionAlertSource = (typeof OPTION_ALERT_SOURCES)[number];

/** Super Admin panelindeki durum rozeti (WhatsApp'a GÖNDERİLMEZ; K-A / K-B). */
export const OPTION_STATUS_BADGES: Record<OptionStatus, string> = {
  open: "\u{1F7E1}",
  converted: "\u2705",
  cancelled: "\u274C",
  expired: "\u274C",
};
