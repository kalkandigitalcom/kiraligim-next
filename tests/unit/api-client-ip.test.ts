/**
 * Acente API'si — başarısız kimlik denemesi sınırının istemci IP'si (güvenlik denetimi Ö1).
 * Kural giriş sınırıyla aynıdır (AUTH_IP_HEADER + AUTH_TRUSTED_PROXIES, Better Auth'un
 * getIPFromHeader çözümleyicisi): istemcinin eklediği sahte x-forwarded-for değerleri sınırı
 * atlatamaz.
 */
import { describe, expect, it } from "vitest";

import type { Database } from "@/db/client";
import { type ApiIpConfig, clientFingerprint, handleApiRequest } from "@/server/api/handler";

const req = (headers: Record<string, string>) =>
  new Request("https://app.kiraligim.test/api/v1/me", { headers });
const fp = (headers: Record<string, string>, config: ApiIpConfig) =>
  clientFingerprint(req(headers), config);

const NO_PROXY: ApiIpConfig = { header: "x-forwarded-for", trustedProxies: [] };
const TRAEFIK: ApiIpConfig = { header: "x-forwarded-for", trustedProxies: ["10.0.0.0/8"] };
const CLOUDFLARE: ApiIpConfig = { header: "cf-connecting-ip", trustedProxies: [] };
const UNRESOLVED = fp({}, NO_PROXY);

describe("güvenilen vekil listesi boş: yalnız tek değerli başlık", () => {
  it("tek geçerli IP kabul edilir; farklı IP farklı kova", () => {
    const a = fp({ "x-forwarded-for": "203.0.113.5" }, NO_PROXY);
    expect(a).not.toBe(UNRESOLVED);
    expect(a).not.toBe(fp({ "x-forwarded-for": "203.0.113.6" }, NO_PROXY));
  });

  it("zincir (istemcinin eklediği değer) reddedilir: sahte sol değer yeni kova açmaz", () => {
    const spoofs = ["1.1.1.1, 203.0.113.5", "2.2.2.2, 203.0.113.5", "evil, 203.0.113.5"];
    for (const v of spoofs) expect(fp({ "x-forwarded-for": v }, NO_PROXY)).toBe(UNRESOLVED);
  });

  it("geçersiz değer ve x-real-ip kullanılmaz", () => {
    expect(fp({ "x-forwarded-for": "not-an-ip" }, NO_PROXY)).toBe(UNRESOLVED);
    expect(fp({ "x-real-ip": "203.0.113.5" }, NO_PROXY)).toBe(UNRESOLVED);
  });
});

describe("güvenilen vekil listesi dolu: zincir sağdan okunur", () => {
  it("ilk güvenilmeyen adres istemcidir; soldaki sahte değerler etkisiz", () => {
    const real = fp({ "x-forwarded-for": "203.0.113.5" }, NO_PROXY);
    for (const v of [
      "203.0.113.5, 10.0.0.2",
      "1.1.1.1, 203.0.113.5, 10.0.0.2",
      "9.9.9.9, 8.8.8.8, 203.0.113.5, 10.1.2.3, 10.0.0.2",
    ]) {
      expect(fp({ "x-forwarded-for": v }, TRAEFIK), v).toBe(real);
    }
  });

  it("zincirin tamamı güvenilen vekilse IP çözülemez", () => {
    expect(fp({ "x-forwarded-for": "10.0.0.3, 10.0.0.2" }, TRAEFIK)).toBe(UNRESOLVED);
  });
});

describe("başlık seçimi ve IPv6", () => {
  it("AUTH_IP_HEADER=cf-connecting-ip: yalnız o başlık okunur", () => {
    const cf = fp({ "cf-connecting-ip": "203.0.113.5", "x-forwarded-for": "1.1.1.1" }, CLOUDFLARE);
    expect(cf).toBe(fp({ "x-forwarded-for": "203.0.113.5" }, NO_PROXY));
    expect(fp({ "x-forwarded-for": "203.0.113.5" }, CLOUDFLARE)).toBe(UNRESOLVED);
  });

  it("IPv6 /64'e indirgenir (aynı ağ aynı kova)", () => {
    expect(fp({ "x-forwarded-for": "2001:db8:1:2::1" }, NO_PROXY)).toBe(
      fp({ "x-forwarded-for": "2001:db8:1:2:ffff::9" }, NO_PROXY),
    );
  });

  it("varsayılan yapılandırma ortamdan okunur (AUTH_IP_HEADER varsayılanı x-forwarded-for)", () => {
    expect(clientFingerprint(req({ "x-forwarded-for": "203.0.113.5" }))).toBe(
      fp({ "x-forwarded-for": "203.0.113.5" }, NO_PROXY),
    );
  });
});

describe("başarısız deneme sınırı (30/dk, IP başına) sahte başlıkla atlatılamaz", () => {
  // Biçim dışı anahtar: veritabanına hiç gidilmez.
  const db = {} as Database;
  const run = async () => ({ body: {} });
  const attempt = (xff: string, now: Date) =>
    handleApiRequest(
      new Request("https://app.kiraligim.test/api/v1/me", {
        headers: { authorization: "Bearer yanlis", "x-forwarded-for": xff },
      }),
      db,
      "test",
      run,
      { now, ipConfig: TRAEFIK },
    );

  it("her istekte farklı sahte sol değer: 31. istek 429; başka gerçek IP etkilenmez", async () => {
    const now = new Date("2026-11-12T10:00:00Z");
    for (let i = 0; i < 30; i++) {
      const r = await attempt(`${i}.${i}.${i}.${i}, 198.51.100.7, 10.0.0.2`, now);
      expect(r.status).toBe(401);
    }
    const limited = await attempt("77.77.77.77, 198.51.100.7, 10.0.0.2", now);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect((await attempt("198.51.100.8, 10.0.0.2", now)).status).toBe(401);
    // Pencere dolunca yeniden 401.
    expect((await attempt("198.51.100.7, 10.0.0.2", new Date(now.getTime() + 61_000))).status).toBe(
      401,
    );
  });
});
