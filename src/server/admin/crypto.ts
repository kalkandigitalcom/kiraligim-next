/**
 * Super Admin: küçük kriptografi yardımcıları (saf; Next.js'e bağımlı değil — komut satırı aracı da
 * kullanır). Belirteçler yalnız SHA-256 özetiyle saklanır; TOTP sırrı AES-256-GCM ile şifrelenir
 * (anahtar ADMIN_SECRET_KEY, veritabanında yok).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** 32 bayt rastgele, URL güvenli (çerez değeri). */
export const randomToken = (): string => randomBytes(32).toString("base64url");

export const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** ADMIN_SECRET_KEY: base64 kodlu tam 32 bayt (openssl rand -base64 32). */
export function parseSecretKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  const key = Buffer.from(raw.trim(), "base64");
  return key.length === 32 ? key : null;
}

export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(
    ":",
  );
}

/** Yanlış anahtar veya bozulmuş veri → null (hata ayrıntısı sızdırılmaz). */
export function decryptSecret(enc: string, key: Buffer): string | null {
  const [v, iv, tag, ct] = enc.split(":");
  if (v !== "v1" || !iv || !tag || !ct) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
