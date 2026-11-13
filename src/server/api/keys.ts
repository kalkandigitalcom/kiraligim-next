/**
 * API anahtarı üretimi/özetleme (saf; Next.js'e bağımlı değil).
 *
 * Anahtar: "kg_live_" + 8 karakter açık önek (base32 küçük harf) + "_" + 43 karakter gizli kısım
 * (32 bayt rastgele, base64url). Veritabanına yalnız SHA-256 özeti ve açık önek gider; anahtarın
 * kendisi yalnız oluşturulduğu anda bir kez gösterilir.
 */
import { createHash, randomBytes } from "node:crypto";

import { API_KEY_PATTERN } from "@/lib/api-meta";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** 256'nın böleni olan alfabelerde sapmasız; diğerlerinde reddetme örneklemesi. */
function randomChars(alphabet: string, length: number): string {
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b >= limit) continue;
      out += alphabet[b % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export type NewApiKey = { key: string; prefix: string; hash: string };

export function generateApiKey(): NewApiKey {
  const prefix = randomChars(BASE32, 8);
  const key = `kg_live_${prefix}_${randomBytes(32).toString("base64url")}`;
  return { key, prefix, hash: hashApiKey(key) };
}

export const hashApiKey = (key: string): string => sha256Hex(key);

/**
 * "Authorization: Bearer <anahtar>" başlığından anahtarı alır. Biçim dışı her değer null (veritabanı
 * hiç sorgulanmaz). Anahtar sorgu dizgisinden veya başka başlıktan kabul edilmez.
 */
export function bearerKey(header: string | null): string | null {
  if (!header || header.length > 200) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  const key = m?.[1];
  return key && API_KEY_PATTERN.test(key) ? key : null;
}
