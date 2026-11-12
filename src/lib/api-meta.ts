/**
 * Kiraligim acente okuma API'si (1. aşama) — paylaşılan sabitler. Sunucu, veritabanı şeması ve
 * testler aynı değerleri kullanır; SQL tarafındaki eşdeğerleri drizzle/0051–0052'dedir.
 *
 * Paylaşılan veri bilinçli olarak en azdır: villa kimliği, villa adı ve dolu tarih aralıkları.
 * Açıklama, fotoğraf, adres/koordinat, fiyat, ev sahibi, misafir, tutar, not ve kaynak kanal
 * bilgisi hiçbir uç noktada dönmez.
 */

export const API_CLIENT_STATUSES = ["active", "disabled"] as const;
export type ApiClientStatus = (typeof API_CLIENT_STATUSES)[number];

export const API_KEY_STATUSES = ["active", "revoked"] as const;
export type ApiKeyStatus = (typeof API_KEY_STATUSES)[number];

export const API_GRANT_STATUSES = ["active", "revoked"] as const;
export type ApiGrantStatus = (typeof API_GRANT_STATUSES)[number];

export const API_LIMITS = {
  /** Anahtar başına dakikalık istek sınırı (varsayılan; hesap bazında saklanır). */
  ratePerMinute: 120,
  /** Bir hesabın aynı anda etkin anahtar sayısı. */
  activeKeysPerClient: 5,
  clientNameMax: 100,
  keyLabelMax: 60,
  /** /properties sayfa boyutu. */
  pageDefault: 100,
  pageMax: 500,
  /** Müsaitlik penceresi: bugünden en fazla 12 ay geri, 24 ay ileri; tek sorguda en fazla 366 gün. */
  availabilityPastDays: 366,
  availabilityFutureDays: 731,
  availabilitySpanMaxDays: 366,
  availabilityDefaultDays: 90,
  /** Super Admin kullanım ekranı: son N gün. */
  usageDays: 30,
} as const;

/**
 * API anahtarı: "kg_live_" + 8 karakterlik açık önek + "_" + 43 karakterlik gizli kısım
 * (32 bayt, base64url). Veritabanında yalnız SHA-256 özeti ve açık önek saklanır.
 */
export const API_KEY_PATTERN = /^kg_live_[a-z2-7]{8}_[A-Za-z0-9_-]{43}$/;
export const API_KEY_PREFIX_PATTERN = /^[a-z2-7]{8}$/;

/**
 * Acente erişim kodu: "KG-XXXX-XXXX" (karışan harfler yok: 0/O, 1/I/L, U). Ev sahibi villa
 * sayfasında girer; yalnız SHA-256 özeti saklanır. Kod yalnız sahiplik kanıtı DEĞİLDİR: ev sahibi
 * acente adını görüp onaylamadan izin oluşmaz.
 */
export const API_ACCESS_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
export const API_ACCESS_CODE_PATTERN = /^KG-[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}$/;

/** Kullanıcının yazdığı kodu standart biçime getirir (boşluk/küçük harf/tire hoşgörüsü). */
export function normalizeAccessCode(input: string): string | null {
  const raw = input.toUpperCase().replace(/[\s-]/g, "").replace(/^KG/, "");
  if (raw.length !== 8) return null;
  const code = `KG-${raw.slice(0, 4)}-${raw.slice(4)}`;
  return API_ACCESS_CODE_PATTERN.test(code) ? code : null;
}

export const API_ERROR_CODES = [
  "unauthorized",
  "account_disabled",
  "not_found",
  "invalid_request",
  "rate_limited",
  "method_not_allowed",
  "internal_error",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];
