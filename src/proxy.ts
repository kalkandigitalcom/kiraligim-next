import { type NextRequest, NextResponse } from "next/server";

import { getEnv } from "@/lib/env";
import { hostMapFromUrls, resolveSurface } from "@/lib/hosts";
import { buildCsp, createNonce, hstsHeader } from "@/lib/security-headers";

/**
 * Her sayfa isteğinde:
 * 1. Host başlığına göre yüzeyi seçer ve isteği ilgili klasöre yeniden yazar
 *    (app.* → /host, admin.* → /admin, kök alan → /site). Tanımsız host → 404.
 * 2. İstek başına CSP nonce üretir; HSTS ve indeksleme başlıklarını ekler.
 * /api/* yeniden yazılmaz: Coolify sağlık kontrolü konteynere doğrudan localhost ile gelir.
 */
export function proxy(request: NextRequest) {
  const env = getEnv();
  const surface = resolveSurface(request.headers.get("host"), hostMapFromUrls(env));

  if (!surface) {
    return new NextResponse("Not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex" },
    });
  }

  const isHttps =
    request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  const nonce = createNonce();
  const csp = buildCsp(nonce, { isDev: process.env.NODE_ENV === "development", isHttps });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("x-surface", surface);
  requestHeaders.set("content-security-policy", csp);

  const url = request.nextUrl.clone();
  url.pathname = `/${surface}${request.nextUrl.pathname === "/" ? "" : request.nextUrl.pathname}`;

  const response = NextResponse.rewrite(url, { request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);

  const hsts = hstsHeader(env.APP_ENV, isHttps);
  if (hsts) response.headers.set("strict-transport-security", hsts);

  // Panel ve geliştirme ortamı arama motorlarına kapalı.
  if (surface !== "site" || env.APP_ENV !== "production") {
    response.headers.set("x-robots-tag", "noindex, nofollow");
  }
  if (surface !== "site") response.headers.set("cache-control", "private, no-store");

  return response;
}

export const config = {
  matcher: [
    // Prefetch istekleri de yeniden yazılmalı; bu yüzden hariç tutulmaz.
    // Dosya uzantılı istekler (public/ altındaki fontlar, ikonlar) ve Next.js varlıkları hariç.
    "/((?!api/|_next/static|_next/image|.*\\.[a-zA-Z0-9]+$).*)",
  ],
};
