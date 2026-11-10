/**
 * Yönetici şifresi: scrypt (N=2^15, r=8, p=1, 64 bayt), rastgele 16 bayt tuz.
 * Biçim: scrypt$N$r$p$tuz$özet (base64url). Saf modül.
 */
import { randomBytes, scrypt as scryptCb, type ScryptOptions, timingSafeEqual } from "node:crypto";

const scrypt = (pw: string, salt: Buffer, len: number, o: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCb(pw, salt, len, o, (err, key) => (err ? reject(err) : resolve(key))),
  );

const N = 2 ** 15;
const R = 8;
const P = 1;
const LEN = 64;
const MAXMEM = 64 * 1024 * 1024;

export const ADMIN_PASSWORD_MIN = 12;
export const ADMIN_PASSWORD_MAX = 128;

export function adminPasswordProblem(pw: string): string | null {
  if (pw.length < ADMIN_PASSWORD_MIN) return `Şifre en az ${ADMIN_PASSWORD_MIN} karakter olmalı.`;
  if (pw.length > ADMIN_PASSWORD_MAX)
    return `Şifre en fazla ${ADMIN_PASSWORD_MAX} karakter olabilir.`;
  return null;
}

export async function hashAdminPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, LEN, { N, r: R, p: P, maxmem: MAXMEM });
  return ["scrypt", N, R, P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyAdminPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  if (pw.length > ADMIN_PASSWORD_MAX) return false;
  const key = await scrypt(pw, Buffer.from(salt, "base64url"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAXMEM,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Var olmayan hesapta da aynı süre harcanır (hesap varlığı süreden anlaşılmasın). */
let dummy: Promise<string> | null = null;
export async function burnPasswordTime(pw: string): Promise<void> {
  dummy ??= hashAdminPassword("kiraligim-dummy-password");
  await verifyAdminPassword(pw.slice(0, ADMIN_PASSWORD_MAX), await dummy);
}
