import { describe, expect, it } from "vitest";

import { AuthEnvError, isValidCidr, parseAuthEnv } from "@/server/auth/env";
import { buildHostAuthOptions, createHostAuth } from "@/server/auth/host-auth";

import { testAuthDeps } from "./helpers/auth-deps";

const SECRET = "s".repeat(40);

describe("parseAuthEnv", () => {
  it("test ortamında varsayılanlar güvenli: kayıt kapalı, e-posta bellekte", () => {
    const e = parseAuthEnv("test", { BETTER_AUTH_SECRET: SECRET });
    expect(e.AUTH_SIGNUP_ENABLED).toBe(false);
    expect(e.EMAIL_TRANSPORT).toBe("memory");
    expect(e.AUTH_IP_HEADER).toBe("x-forwarded-for");
    expect(e.AUTH_TRUSTED_PROXIES).toEqual([]);
  });

  it("yerelde e-postalar log'a yazılır, gönderilmez", () => {
    expect(parseAuthEnv("local", { BETTER_AUTH_SECRET: SECRET }).EMAIL_TRANSPORT).toBe("log");
  });

  it("kısa veya örnek gizli anahtarı reddeder", () => {
    expect(() => parseAuthEnv("test", { BETTER_AUTH_SECRET: "kisa" })).toThrow(/32/);
    expect(() => parseAuthEnv("test", {})).toThrow(AuthEnvError);
  });

  it("production'da yalnız Resend; anahtar ve gönderen zorunlu", () => {
    expect(() => parseAuthEnv("production", { BETTER_AUTH_SECRET: SECRET })).toThrow(
      /EMAIL_TRANSPORT/,
    );
    expect(() =>
      parseAuthEnv("production", { BETTER_AUTH_SECRET: SECRET, EMAIL_TRANSPORT: "log" }),
    ).toThrow(/yalnız resend/);
    expect(() =>
      parseAuthEnv("production", { BETTER_AUTH_SECRET: SECRET, EMAIL_TRANSPORT: "resend" }),
    ).toThrow(/RESEND_API_KEY/);
    expect(() =>
      parseAuthEnv("production", {
        BETTER_AUTH_SECRET: SECRET,
        EMAIL_TRANSPORT: "resend",
        RESEND_API_KEY: "re_test",
      }),
    ).toThrow(/EMAIL_FROM/);
    const ok = parseAuthEnv("production", {
      BETTER_AUTH_SECRET: SECRET,
      EMAIL_TRANSPORT: "resend",
      RESEND_API_KEY: "re_test",
      EMAIL_FROM: "Kiralığım <bildirim@kiraligim.com>",
    });
    expect(ok.EMAIL_TRANSPORT).toBe("resend");
  });

  it("bellek gönderimi test dışında kullanılamaz", () => {
    expect(() =>
      parseAuthEnv("development", { BETTER_AUTH_SECRET: SECRET, EMAIL_TRANSPORT: "memory" }),
    ).toThrow(/memory/);
  });

  it("güvenilen vekil listesi IP/CIDR olmalı", () => {
    expect(isValidCidr("173.245.48.0/20")).toBe(true);
    expect(isValidCidr("2400:cb00::/32")).toBe(true);
    expect(isValidCidr("10.0.0.1")).toBe(true);
    expect(isValidCidr("10.0.0.0/33")).toBe(false);
    expect(isValidCidr("cloudflare")).toBe(false);
    expect(
      parseAuthEnv("test", {
        BETTER_AUTH_SECRET: SECRET,
        AUTH_TRUSTED_PROXIES: "173.245.48.0/20, 10.0.0.0/8",
      }).AUTH_TRUSTED_PROXIES,
    ).toEqual(["173.245.48.0/20", "10.0.0.0/8"]);
    expect(() =>
      parseAuthEnv("test", { BETTER_AUTH_SECRET: SECRET, AUTH_TRUSTED_PROXIES: "abc" }),
    ).toThrow(/CIDR/);
  });
});

describe("ev sahibi Better Auth yapılandırması", () => {
  const options = buildHostAuthOptions(testAuthDeps());

  it("public kayıt varsayılan olarak kapalı; e-posta doğrulaması zorunlu", () => {
    expect(options.emailAndPassword.disableSignUp).toBe(true);
    expect(options.emailAndPassword.requireEmailVerification).toBe(true);
    expect(options.emailAndPassword.autoSignIn).toBe(false);
    expect(options.emailAndPassword.minPasswordLength).toBeGreaterThanOrEqual(10);
  });

  it("yalnız APP_URL güvenilir köken; çerez alt alan adlarıyla paylaşılmaz", () => {
    expect(options.baseURL).toBe("http://app.localhost:3000");
    expect(options.trustedOrigins).toEqual(["http://app.localhost:3000"]);
    expect(options.advanced.crossSubDomainCookies.enabled).toBe(false);
    expect(options.advanced.cookiePrefix).toBe("kg");
    expect(options.advanced.defaultCookieAttributes).toEqual({ httpOnly: true, sameSite: "lax" });
    expect(options.advanced.disableOriginCheck).toBe(false);
    expect("disableCSRFCheck" in options.advanced).toBe(false);
  });

  it("production'da çerezler Secure", () => {
    const prod = buildHostAuthOptions(
      testAuthDeps({ env: { APP_ENV: "production", APP_URL: "https://app.kiraligim.com" } }),
    );
    expect(prod.advanced.useSecureCookies).toBe(true);
    expect(options.advanced.useSecureCookies).toBe(false);
  });

  it("deneme sınırı veritabanında, belirteçler özetlenmiş, telemetri kapalı", () => {
    expect(buildHostAuthOptions(testAuthDeps({ rateLimitEnabled: undefined })).rateLimit).toEqual({
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
    });
    expect(options.verification.storeIdentifier).toBe("hashed");
    expect(options.telemetry.enabled).toBe(false);
    expect(options.user.deleteUser.enabled).toBe(false);
    expect(options.account.accountLinking.enabled).toBe(false);
  });

  it("kimlikler UUID v7", () => {
    const id = options.advanced.database.generateId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("istemci IP başlığı ve güvenilen vekiller env'den gelir", () => {
    const deps = testAuthDeps();
    const o = buildHostAuthOptions({
      ...deps,
      authEnv: { ...deps.authEnv, AUTH_IP_HEADER: "cf-connecting-ip", AUTH_TRUSTED_PROXIES: [] },
    });
    expect(o.advanced.ipAddress).toEqual({ ipAddressHeaders: ["cf-connecting-ip"] });
  });

  it("kayıt kapalıyken sign-up isteği veritabanına gitmeden reddedilir", async () => {
    const auth = createHostAuth(testAuthDeps());
    const res = await auth.handler(
      new Request("http://app.localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://app.localhost:3000" },
        body: JSON.stringify({ email: "a@b.com", password: "cokgizli-parola-1", name: "A" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/sign ?up/i);
  });

  it("çerezli istek başka kökenden gelirse reddedilir (CSRF)", async () => {
    const auth = createHostAuth(testAuthDeps());
    const res = await auth.handler(
      new Request("http://app.localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
          cookie: "kg.session_token=x",
        },
        body: JSON.stringify({ email: "a@b.com", password: "x" }),
      }),
    );
    expect(res.status).toBe(403);
  });
});
