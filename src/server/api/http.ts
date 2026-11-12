/**
 * Acente API'si — saf yardımcılar: sorgu parametresi doğrulama ve JSON yanıtları.
 * Yanıt gövdeleri yalnız açıkça tanımlanmış alanlardan oluşur; hata mesajları iç ayrıntı
 * (SQL, yığın, tablo adı) içermez.
 */
import { API_LIMITS, type ApiErrorCode } from "@/lib/api-meta";
import { addDays, isIsoDate, nightsBetween } from "@/lib/reservation-meta";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string) => UUID.test(v);

const BASE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex",
} as const;

export const ERROR_STATUS: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  account_disabled: 403,
  not_found: 404,
  invalid_request: 400,
  rate_limited: 429,
  method_not_allowed: 405,
  internal_error: 500,
};

const ERROR_MESSAGES: Record<ApiErrorCode, string> = {
  unauthorized: "Missing or invalid API key.",
  account_disabled: "This API account is disabled.",
  not_found: "Not found.",
  invalid_request: "Invalid request.",
  rate_limited: "Rate limit exceeded. Retry after the reset time.",
  method_not_allowed: "Method not allowed.",
  internal_error: "Service temporarily unavailable.",
};

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, ...headers },
  });
}

export function errorResponse(
  code: ApiErrorCode,
  headers: Record<string, string> = {},
  message?: string,
): Response {
  const extra: Record<string, string> = { ...headers };
  if (code === "unauthorized") extra["www-authenticate"] = 'Bearer realm="kiraligim"';
  if (code === "method_not_allowed") extra.allow = "GET";
  return jsonResponse(
    { error: { code, message: message ?? ERROR_MESSAGES[code] } },
    ERROR_STATUS[code],
    extra,
  );
}

export type RateInfo = { limit: number; remaining: number; resetAt: Date };

export function rateHeaders(r: RateInfo, now: Date = new Date()): Record<string, string> {
  const reset = Math.max(0, Math.ceil((r.resetAt.getTime() - now.getTime()) / 1000));
  return {
    "x-ratelimit-limit": String(r.limit),
    "x-ratelimit-remaining": String(r.remaining),
    "x-ratelimit-reset": String(reset),
  };
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/** /properties: ?limit=1..500 (varsayılan 100), ?cursor=<son villa kimliği>. */
export function parseListQuery(url: URL): Parsed<{ limit: number; after: string | null }> {
  for (const k of url.searchParams.keys()) {
    if (k !== "limit" && k !== "cursor") return { ok: false, message: `Unknown parameter: ${k}` };
  }
  const rawLimit = url.searchParams.get("limit");
  let limit: number = API_LIMITS.pageDefault;
  if (rawLimit !== null) {
    if (!/^\d{1,3}$/.test(rawLimit)) return { ok: false, message: "limit must be 1-500." };
    limit = Number(rawLimit);
    if (limit < 1 || limit > API_LIMITS.pageMax) {
      return { ok: false, message: "limit must be 1-500." };
    }
  }
  const after = url.searchParams.get("cursor");
  if (after !== null && !isUuid(after)) return { ok: false, message: "Invalid cursor." };
  return { ok: true, value: { limit, after: after?.toLowerCase() ?? null } };
}

/**
 * /availability: ?from=YYYY-MM-DD&to=YYYY-MM-DD, [from, to) yarı açık pencere.
 * Varsayılan: bugünden itibaren 90 gün. Sınırlar: from ≥ bugün − 366 gün, to ≤ bugün + 731 gün,
 * en fazla 366 gün.
 */
export function parseAvailabilityQuery(
  url: URL,
  today: string,
): Parsed<{ from: string; to: string }> {
  for (const k of url.searchParams.keys()) {
    if (k !== "from" && k !== "to") return { ok: false, message: `Unknown parameter: ${k}` };
  }
  const rawFrom = url.searchParams.get("from");
  const rawTo = url.searchParams.get("to");
  if (rawFrom !== null && !isIsoDate(rawFrom)) {
    return { ok: false, message: "from must be a date (YYYY-MM-DD)." };
  }
  if (rawTo !== null && !isIsoDate(rawTo)) {
    return { ok: false, message: "to must be a date (YYYY-MM-DD)." };
  }
  const from = rawFrom ?? today;
  const to = rawTo ?? addDays(from, API_LIMITS.availabilityDefaultDays);
  if (to <= from) return { ok: false, message: "to must be after from." };
  if (nightsBetween(from, to) > API_LIMITS.availabilitySpanMaxDays) {
    return { ok: false, message: "The range may span at most 366 days." };
  }
  if (from < addDays(today, -API_LIMITS.availabilityPastDays)) {
    return { ok: false, message: "from is too far in the past (max 12 months)." };
  }
  if (to > addDays(today, API_LIMITS.availabilityFutureDays)) {
    return { ok: false, message: "to is too far in the future (max 24 months)." };
  }
  return { ok: true, value: { from, to } };
}
