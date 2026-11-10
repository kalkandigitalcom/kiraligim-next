import { describe, expect, it } from "vitest";

import {
  decryptSecret,
  encryptSecret,
  parseSecretKey,
  randomToken,
  sha256Hex,
} from "@/server/admin/crypto";
import { readAdminConfig } from "@/server/admin/env";
import {
  adminPasswordProblem,
  hashAdminPassword,
  verifyAdminPassword,
} from "@/server/admin/password";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  otpauthUri,
  totpCode,
  totpStep,
  verifyTotp,
} from "@/server/admin/totp";

/** Super Admin (2.8 minimal): saf kimlik yardımcıları. */
const KEY = Buffer.alloc(32, 7);
const KEY_B64 = KEY.toString("base64");

describe("TOTP (RFC 6238 test vektörleri, SHA-1)", () => {
  // RFC 6238 Ek B: sır "12345678901234567890"; 8 haneli değerlerin son 6 hanesi.
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ])("T=%i → %s", (t, code) => {
    expect(totpCode(secret, totpStep(t * 1000))).toBe(code);
  });

  it("base32 gidiş-dönüş", () => {
    const b = Buffer.from("merhaba dünya 123");
    expect(base32Decode(base32Encode(b))).toEqual(b);
    expect(base32Encode(Buffer.from("12345678901234567890"))).toBe(
      "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    );
  });

  it("±1 adım kabul; daha uzağı ve biçimsiz kod reddedilir", () => {
    const s = generateTotpSecret();
    const now = 1_800_000_000_000;
    const step = totpStep(now);
    expect(verifyTotp(s, totpCode(s, step), now, null)).toBe(step);
    expect(verifyTotp(s, totpCode(s, step - 1), now, null)).toBe(step - 1);
    expect(verifyTotp(s, totpCode(s, step + 1), now, null)).toBe(step + 1);
    expect(verifyTotp(s, totpCode(s, step - 2), now, null)).toBeNull();
    expect(verifyTotp(s, "12345", now, null)).toBeNull();
    expect(verifyTotp(s, "abcdef", now, null)).toBeNull();
    expect(
      verifyTotp(s, `${totpCode(s, step).slice(0, 3)} ${totpCode(s, step).slice(3)}`, now, null),
    ).toBe(step);
  });

  it("aynı adım (veya daha eskisi) ikinci kez kabul edilmez", () => {
    const s = generateTotpSecret();
    const now = 1_800_000_000_000;
    const step = totpStep(now);
    expect(verifyTotp(s, totpCode(s, step), now, step)).toBeNull();
    expect(verifyTotp(s, totpCode(s, step - 1), now, step - 1)).toBeNull();
    expect(verifyTotp(s, totpCode(s, step), now, step - 1)).toBe(step);
  });

  it("otpauth bağlantısı", () => {
    const uri = otpauthUri("Kiralığım Yönetim", "a@b.com", "ABC");
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(uri).toContain("secret=ABC");
    expect(uri).toContain("digits=6");
  });
});

describe("şifre (scrypt)", () => {
  it("doğru şifre kabul, yanlışı ve bozuk özeti reddeder; özet tuzludur", async () => {
    const h1 = await hashAdminPassword("çok-gizli-şifre-123");
    const h2 = await hashAdminPassword("çok-gizli-şifre-123");
    expect(h1).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(h1).not.toBe(h2);
    expect(await verifyAdminPassword("çok-gizli-şifre-123", h1)).toBe(true);
    expect(await verifyAdminPassword("çok-gizli-şifre-124", h1)).toBe(false);
    expect(await verifyAdminPassword("x", "bozuk")).toBe(false);
  });

  it("şifre kuralı: 12–128 karakter", () => {
    expect(adminPasswordProblem("kısa")).not.toBeNull();
    expect(adminPasswordProblem("a".repeat(12))).toBeNull();
    expect(adminPasswordProblem("a".repeat(129))).not.toBeNull();
  });
});

describe("şifreleme ve belirteçler", () => {
  it("AES-256-GCM: doğru anahtarla açılır; yanlış anahtar veya bozuk veri → null", () => {
    const enc = encryptSecret("JBSWY3DPEHPK3PXP", KEY);
    expect(enc).toMatch(/^v1:/);
    expect(enc).not.toContain("JBSWY3DPEHPK3PXP");
    expect(decryptSecret(enc, KEY)).toBe("JBSWY3DPEHPK3PXP");
    expect(decryptSecret(enc, Buffer.alloc(32, 8))).toBeNull();
    expect(decryptSecret(`${enc.slice(0, -2)}AA`, KEY)).toBeNull();
    expect(decryptSecret("v2:x:y:z", KEY)).toBeNull();
  });

  it("anahtar: base64 32 bayt şart", () => {
    expect(parseSecretKey(KEY_B64)).toEqual(KEY);
    expect(parseSecretKey(Buffer.alloc(16).toString("base64"))).toBeNull();
    expect(parseSecretKey(undefined)).toBeNull();
  });

  it("belirteç rastgele ve özetlenebilir", () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(randomToken());
    expect(sha256Hex(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("yapılandırma", () => {
  const base = {
    DATABASE_ADMIN_URL: "postgres://app_admin:x@db:5432/kiraligim_prod",
    ADMIN_SECRET_KEY: KEY_B64,
  };
  it("geçerli production yapılandırması; çerezler güvenli", () => {
    const r = readAdminConfig(base, "production", "https://admin.kiraligim.com");
    expect(r).toMatchObject({ ok: true, config: { secureCookies: true } });
  });
  it.each([
    [{ ...base, DATABASE_ADMIN_URL: undefined }, "tanımlı değil"],
    [{ ...base, DATABASE_ADMIN_URL: "mysql://x" }, "postgres://"],
    [{ ...base, DATABASE_ADMIN_URL: "postgres://app_admin:x@db/kiraligim_dev" }, "_prod"],
    [{ ...base, DATABASE_ADMIN_URL: "postgres://app_user:x@db/kiraligim_prod" }, "app_admin"],
    [{ ...base, ADMIN_SECRET_KEY: "kısa" }, "32 bayt"],
  ])("reddedilir: %o", (source, msg) => {
    const r = readAdminConfig(source, "production", "https://admin.kiraligim.com");
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).toContain(msg);
  });
  it("production'da http admin adresi reddedilir; geliştirmede http çerezleri güvensiz işaretlenir", () => {
    expect(readAdminConfig(base, "production", "http://admin.kiraligim.com").ok).toBe(false);
    const dev = readAdminConfig(
      { ...base, DATABASE_ADMIN_URL: "postgres://app_admin:x@db/kiraligim_dev" },
      "development",
      "http://admin.localhost:3000",
    );
    expect(dev).toMatchObject({ ok: true, config: { secureCookies: false } });
  });
});
