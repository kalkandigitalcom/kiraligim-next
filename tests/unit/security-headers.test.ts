import { describe, expect, it } from "vitest";

import { buildCsp, createNonce, hstsHeader, staticSecurityHeaders } from "@/lib/security-headers";

describe("CSP", () => {
  it("production'da unsafe-eval ve unsafe-inline içermez", () => {
    const csp = buildCsp("abc", { isDev: false, isHttps: true });
    expect(csp).toContain("upgrade-insecure-requests");
    expect(csp).toContain("'nonce-abc'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("unsafe-inline");
  });

  it("nonce her çağrıda farklı ve yeterince uzun", () => {
    const a = createNonce();
    const b = createNonce();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(22);
  });
});

describe("HSTS", () => {
  it("http'de gönderilmez", () => expect(hstsHeader("production", false)).toBeNull());
  it("production'da uzun süreli", () =>
    expect(hstsHeader("production", true)).toContain("max-age=63072000"));
  it("dev'de alt alan adlarını kilitlemez", () =>
    expect(hstsHeader("development", true)).not.toContain("includeSubDomains"));
});

it("sabit başlıklar clickjacking ve MIME sniffing'i engeller", () => {
  const keys = Object.fromEntries(staticSecurityHeaders().map((h) => [h.key, h.value]));
  expect(keys["X-Frame-Options"]).toBe("DENY");
  expect(keys["X-Content-Type-Options"]).toBe("nosniff");
});
