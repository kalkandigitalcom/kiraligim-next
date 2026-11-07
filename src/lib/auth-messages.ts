/**
 * Better Auth hata kodlarını Türkçe, kullanıcıya gösterilebilir mesajlara çevirir.
 * Bilinmeyen hatalarda ayrıntı sızdırmayan genel bir mesaj döner.
 */
export type AuthErrorLike = { code?: string | undefined; status?: number | undefined } | null;

const MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "E-posta adresi veya şifre hatalı.",
  INVALID_EMAIL: "Geçerli bir e-posta adresi girin.",
  INVALID_PASSWORD: "Şifre hatalı.",
  PASSWORD_TOO_SHORT: "Şifre en az 10 karakter olmalı.",
  PASSWORD_TOO_LONG: "Şifre en fazla 128 karakter olabilir.",
  EMAIL_NOT_VERIFIED: "E-posta adresinizi henüz doğrulamadınız.",
  INVALID_TOKEN: "Bağlantı geçersiz veya süresi dolmuş.",
  TOKEN_EXPIRED: "Bağlantının süresi dolmuş.",
  EMAIL_PASSWORD_SIGN_UP_DISABLED: "Yeni hesap kaydı şu an kapalı.",
  AUTH_UNAVAILABLE: "Giriş sistemi geçici olarak kullanılamıyor. Lütfen daha sonra tekrar deneyin.",
  INVALID_ORIGIN: "Güvenlik denetimi başarısız oldu. Sayfayı yenileyip tekrar deneyin.",
  MISSING_OR_NULL_ORIGIN: "Güvenlik denetimi başarısız oldu. Sayfayı yenileyip tekrar deneyin.",
};

export const GENERIC_AUTH_ERROR = "İşlem tamamlanamadı. Lütfen tekrar deneyin.";

export function authErrorMessage(error: AuthErrorLike): string {
  if (!error) return GENERIC_AUTH_ERROR;
  if (error.status === 429)
    return "Çok fazla deneme yapıldı. Lütfen biraz bekleyip tekrar deneyin.";
  if (error.code && MESSAGES[error.code]) return MESSAGES[error.code]!;
  if (error.status === 503) return MESSAGES.AUTH_UNAVAILABLE!;
  return GENERIC_AUTH_ERROR;
}

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;
