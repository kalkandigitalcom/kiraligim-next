/**
 * Güvenlik başlıkları.
 * - Sabit başlıklar next.config.ts üzerinden tüm yanıtlara eklenir.
 * - CSP istek başına nonce içerdiği için proxy.ts içinde üretilir.
 */

export type HeaderPair = { key: string; value: string };

export function staticSecurityHeaders(): HeaderPair[] {
  return [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
    },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "X-DNS-Prefetch-Control", value: "off" },
  ];
}

/** HSTS yalnız HTTPS üzerinden ve production'da gönderilir. */
export function hstsHeader(appEnv: string, isHttps: boolean): string | null {
  if (!isHttps) return null;
  if (appEnv === "production") return "max-age=63072000; includeSubDomains; preload";
  // Geçici/dev alan adlarında alt alan adlarını kilitlememek için kısa süre ve includeSubDomains yok.
  return "max-age=86400";
}

export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export function buildCsp(nonce: string, opts: { isDev: boolean; isHttps?: boolean }): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${opts.isDev ? " 'unsafe-eval'" : ""}`,
    // Geliştirmede HMR satır içi stil ekler; nonce varken 'unsafe-inline' yok sayıldığı için ayrı.
    opts.isDev ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (opts.isHttps) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}
