/**
 * Acente API'si — ortak istek akışı (her uç nokta):
 *
 *  1. "Authorization: Bearer kg_live_…" başlığı; biçim dışıysa veritabanına gidilmeden 401.
 *  2. app_api_begin: anahtar (yalnız özet) + hesap durumu + anahtar başına dakikalık sınır
 *     (veritabanında, örnekler arası ortak) + günlük kullanım. 401 / 403 / 429.
 *  3. Uç noktanın işi: her veritabanı fonksiyonu anahtarı, hesabı ve villa iznini yeniden denetler.
 *  4. Hata gövdeleri sabit metinlidir; iç ayrıntı dönmez. Anahtar, özet veya IP log'a yazılmaz.
 *
 * Başarısız kimlik denemeleri ayrıca süreç içinde IP özeti başına sınırlanır (veritabanı yükünü
 * azaltan ek katman; asıl sınır veritabanındadır). İstemci IP'si giriş sınırıyla AYNI kuralla
 * çözülür: AUTH_IP_HEADER + AUTH_TRUSTED_PROXIES ve Better Auth'un çözümleyicisi
 * (getIPFromHeader; docs/deployment.md → "Deneme sınırı (rate limit) ve istemci IP'si").
 * İstemcinin eklediği sahte x-forwarded-for değerlerine güvenilmez.
 */
import { createHash } from "node:crypto";

import { getIPFromHeader } from "@better-auth/core/utils/ip";

import type { Database } from "@/db/client";
import { pgErrorInfo } from "@/db/pg-error";
import { logger } from "@/lib/logger";
import { istanbulToday } from "@/lib/reservation-meta";
import { authEnvSchema } from "@/server/auth/env";
import { createMemoryRateLimit } from "@/server/public/memory-rate-limit";

import { bearerKey, hashApiKey } from "./keys";
import { errorResponse, jsonResponse, type RateInfo, rateHeaders } from "./http";
import { ApiInvalid, ApiNotFound, ApiUnauthorized, beginRequest, noteError } from "./service";

export type ApiContext = {
  db: Database;
  keyHash: string;
  client: { id: string; name: string };
  rate: RateInfo;
  today: string;
  url: URL;
  /** Yazma uç noktaları gövdeyi okur (readJsonBody); GET uç noktaları kullanmaz. */
  request: Request;
};

/** Uç noktanın sonucu: gövde (200; oluşturmada 201) ya da hata kodu. */
export type ApiResult =
  | { body: unknown; status?: 200 | 201 }
  | {
      error:
        | "not_found"
        | "invalid_request"
        | "already_connected"
        | "external_id_in_use"
        | "payload_too_large"
        | "unsupported_media_type"
        | "invalid_cursor"
        | "cursor_expired"
        | "webhooks_unavailable";
      message?: string;
    };

const failedAuth = createMemoryRateLimit({ limit: 30, windowMs: 60_000, maxKeys: 5_000 });

/** İstemci IP'si yapılandırması (giriş sınırıyla aynı ortam değişkenleri). */
export type ApiIpConfig = { header: string; trustedProxies: string[] };

const ipConfigSchema = authEnvSchema.pick({ AUTH_IP_HEADER: true, AUTH_TRUSTED_PROXIES: true });
let ipConfigCache: ApiIpConfig | undefined;

/**
 * Yalnız iki IP değişkeni okunur (kimlik ortamının tamamı değil): API, e-posta vb. kimlik
 * ayarlarına bağımlı olmaz. Geçersiz değer Better Auth'ta olduğu gibi açılışta hataya yol açar.
 */
function apiIpConfig(): ApiIpConfig {
  if (!ipConfigCache) {
    const e = ipConfigSchema.parse(process.env);
    ipConfigCache = { header: e.AUTH_IP_HEADER, trustedProxies: e.AUTH_TRUSTED_PROXIES };
  }
  return ipConfigCache;
}

/**
 * Başarısız deneme sınırının anahtarı: istemci IP'sinin özeti. Kural Better Auth'unkiyle aynı:
 *  - güvenilen vekil listesi boşken başlıkta yalnız TEK geçerli IP kabul edilir (zincir reddedilir);
 *  - liste doluyken zincir sağdan okunur, güvenilen adresler atlanır, ilk güvenilmeyen adres alınır;
 *  - IPv6 /64'e indirgenir.
 * IP çözülemezse tüm bu istekler tek ortak kovaya düşer (Better Auth'taki "no-trusted-ip" gibi);
 * sınır yalnız BAŞARISIZ denemelere uygulandığından geçerli anahtarlı istekler etkilenmez.
 */
export function clientFingerprint(request: Request, config: ApiIpConfig = apiIpConfig()): string {
  const raw = request.headers.get(config.header);
  const ip = raw
    ? getIPFromHeader(raw, {
        ...(config.trustedProxies.length > 0 ? { trustedProxies: config.trustedProxies } : {}),
      })
    : null;
  return createHash("sha256")
    .update(`api-ip:${ip ?? "no-trusted-ip"}`)
    .digest("hex")
    .slice(0, 32);
}

export async function handleApiRequest(
  request: Request,
  db: Database,
  route: string,
  run: (ctx: ApiContext) => Promise<ApiResult>,
  opts: { now?: Date; ipConfig?: ApiIpConfig } = {},
): Promise<Response> {
  const now = opts.now ?? new Date();
  const unauthorized = () => {
    if (!failedAuth.take(clientFingerprint(request, opts.ipConfig), now.getTime())) {
      return errorResponse("rate_limited", { "retry-after": "60" });
    }
    return errorResponse("unauthorized");
  };

  const key = bearerKey(request.headers.get("authorization"));
  if (!key) return unauthorized();
  const keyHash = hashApiKey(key);

  let rate: RateInfo | null = null;
  try {
    const begin = await beginRequest(db, keyHash);
    if (begin.outcome === "unauthorized") return unauthorized();
    if (begin.outcome === "account_disabled") return errorResponse("account_disabled");
    rate = { limit: begin.limit, remaining: begin.remaining, resetAt: begin.resetAt };
    if (begin.outcome === "rate_limited") {
      const headers = rateHeaders(rate, now);
      return errorResponse("rate_limited", {
        ...headers,
        "retry-after": headers["x-ratelimit-reset"] ?? "60",
      });
    }
    const ctx: ApiContext = {
      db,
      keyHash,
      client: begin.client,
      rate,
      today: istanbulToday(now),
      url: new URL(request.url),
      request,
    };
    const result = await run(ctx);
    if ("error" in result) {
      await noteError(db, keyHash).catch(() => undefined);
      return errorResponse(result.error, rateHeaders(rate, now), result.message);
    }
    return jsonResponse(result.body, result.status ?? 200, rateHeaders(rate, now));
  } catch (err) {
    const headers = rate ? rateHeaders(rate, now) : {};
    if (err instanceof ApiUnauthorized) return errorResponse("unauthorized", headers);
    if (err instanceof ApiNotFound || err instanceof ApiInvalid) {
      await noteError(db, keyHash).catch(() => undefined);
      return errorResponse(err instanceof ApiNotFound ? "not_found" : "invalid_request", headers);
    }
    // Sorgu parametreleri (anahtar özeti) hata mesajında olabileceğinden yalnız kod ve tür yazılır.
    logger.error("api_request_failed", {
      route,
      code: pgErrorInfo(err).code ?? null,
      kind: err instanceof Error ? err.name : typeof err,
    });
    return errorResponse("internal_error", headers);
  }
}

/** GET dışındaki yöntemler: 405 (JSON). */
export const methodNotAllowed = async (): Promise<Response> => errorResponse("method_not_allowed");

/** İzinli yöntemleri "Allow" başlığında bildiren 405 (2. aşama yazma uç noktaları). */
export const methodNotAllowedFor = (allow: string) => async (): Promise<Response> =>
  errorResponse("method_not_allowed", { allow });
