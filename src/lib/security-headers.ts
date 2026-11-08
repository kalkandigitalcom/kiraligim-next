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

/**
 * `imgOrigins`: ek görsel kökenleri (ör. fotoğraf CDN'i https://img.kiraligim.com). Yalnız
 * https kökenleri (yol / joker yok) kabul edilir; diğerleri sessizce atlanır.
 */
export function buildCsp(
  nonce: string,
  opts: { isDev: boolean; isHttps?: boolean; imgOrigins?: readonly string[] },
): string {
  const imgExtra = (opts.imgOrigins ?? []).filter((o) => /^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(o));
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${opts.isDev ? " 'unsafe-eval'" : ""}`,
    // Geliştirmede HMR satır içi stil ekler; nonce varken 'unsafe-inline' yok sayıldığı için ayrı.
    opts.isDev ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`,
    ["img-src 'self' blob: data:", ...imgExtra].join(" "),
    "font-src 'self'",
    "connect-src 'self'",
    // Yalnız villa sayfasındaki Google Haritalar gömmesi (src/lib/map-embed.ts tüm adresleri
    // https://www.google.com/maps… biçimine çevirir; iframe misafir tıklayınca yüklenir).
    "frame-src https://www.google.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (opts.isHttps) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}
