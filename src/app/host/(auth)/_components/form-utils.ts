import { PASSWORD_MAX, PASSWORD_MIN } from "@/lib/auth-messages";

/** İstemci tarafı ön denetimler (asıl denetim Better Auth'ta). */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function checkEmail(value: string): string | undefined {
  if (!value.trim()) return "E-posta adresinizi girin.";
  if (!EMAIL_RE.test(value.trim())) return "Geçerli bir e-posta adresi girin.";
  return undefined;
}

export function checkNewPassword(value: string): string | undefined {
  if (value.length < PASSWORD_MIN) return `Şifre en az ${PASSWORD_MIN} karakter olmalı.`;
  if (value.length > PASSWORD_MAX) return `Şifre en fazla ${PASSWORD_MAX} karakter olabilir.`;
  return undefined;
}

export const formText = (data: FormData, key: string) => {
  const v = data.get(key);
  return typeof v === "string" ? v : "";
};
