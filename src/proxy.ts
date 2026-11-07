import { type NextRequest, NextResponse } from "next/server";

import { getEnv } from "@/lib/env";
import { hostMapFromUrls, resolveSurface, wwwRedirectOrigin } from "@/lib/hosts";
import { logger } from "@/lib/logger";
import { buildCsp, createNonce, hstsHeader } from "@/lib/security-headers";
import { mediaOriginForCsp } from "@/server/storage/env";

/**
 * Her sayfa isteğinde:
 * 1. Host başlığına göre yüzeyi seçer ve isteği ilgili klasöre yeniden yazar
 *    (app.* → /host, admin.* → /admin, kök alan → /site). `www.` kök alana 308 ile yönlenir.
 *    Tanımsız host → 404 (log'a host adıyla yazılır; yanlış APP_URL/ADMIN_URL teşhisi için).
 * 2. İstek başına CSP nonce üretir; HSTS ve indeksleme başlıklarını ekler.
 * /api/* yeniden yazılmaz: Coolify sağlık kontrolü konteynere doğrudan localhost ile gelir.
 */
export function proxy(request: NextRequest) {
  const env = getEnv();
  const hostHeader = request.headers.get("host");
  const hostMap = hostMapFromUrls(env);

  const redirectOrigin = wwwRedirectOrigin(hostHeader, hostMap, env.PUBLIC_URL);
  if (redirectOrigin) {
    const target = new URL(request.nextUrl.pathname + request.nextUrl.search, redirectOrigin);
    return NextResponse.redirect(target, 308);
  }

  const surface = resolveSurface(hostHeader, hostMap);

  if (!surface) {
    logger.info("unknown_host", { host: hostHeader?.slice(0, 255) ?? null });
    return new NextResponse("Not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex" },
    });
  }

  const isHttps =
    request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  const nonce = createNonce();
  const mediaOrigin = mediaOriginForCsp(process.env);
  const csp = buildCsp(nonce, {
    isDev: process.env.NODE_ENV === "development",
    isHttps,
    imgOrigins: mediaOrigin ? [mediaOrigin] : [],
  });

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
