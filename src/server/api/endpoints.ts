/**
 * Acente API'si — uç nokta gövdeleri. Yanıtlar yalnız aşağıda açıkça kurulan alanları içerir:
 * hesap adı/sınırı, villa kimliği/adı ve dolu tarih aralıkları. Veritabanı satırı olduğu gibi
 * dönmez.
 */
import type { ApiContext, ApiResult } from "./handler";
import { isUuid, parseAvailabilityQuery, parseListQuery } from "./http";
import { getBusyRanges, getProperty, listProperties } from "./service";

/** GET /api/v1/me */
export async function meEndpoint(ctx: ApiContext): Promise<ApiResult> {
  if ([...ctx.url.searchParams.keys()].length > 0) {
    return { error: "invalid_request", message: "This endpoint takes no parameters." };
  }
  return {
    body: {
      id: ctx.client.id,
      name: ctx.client.name,
      rate_limit: { limit: ctx.rate.limit, window_seconds: 60 },
    },
  };
}

/** GET /api/v1/properties?limit=&cursor= */
export async function propertiesEndpoint(ctx: ApiContext): Promise<ApiResult> {
  const q = parseListQuery(ctx.url);
  if (!q.ok) return { error: "invalid_request", message: q.message };
  const rows = await listProperties(ctx.db, ctx.keyHash, q.value);
  const data = rows.map((p) => ({ id: p.id, name: p.name }));
  const last = data.at(-1);
  return {
    body: { data, next_cursor: data.length === q.value.limit && last ? last.id : null },
  };
}

/** GET /api/v1/properties/{id} */
export async function propertyEndpoint(ctx: ApiContext, rawId: string): Promise<ApiResult> {
  if ([...ctx.url.searchParams.keys()].length > 0) {
    return { error: "invalid_request", message: "This endpoint takes no parameters." };
  }
  if (!isUuid(rawId)) return { error: "not_found" };
  const p = await getProperty(ctx.db, ctx.keyHash, rawId.toLowerCase());
  if (!p) return { error: "not_found" };
  return { body: { id: p.id, name: p.name } };
}

/**
 * GET /api/v1/properties/{id}/availability?from=&to=
 * busy_dates: [start_date, end_date) — end_date çıkış günüdür, dolu DEĞİLDİR (yeni giriş
 * yapılabilir). Aralıklar birleştirilmiş ve [from, to) penceresine kırpılmıştır.
 */
export async function availabilityEndpoint(ctx: ApiContext, rawId: string): Promise<ApiResult> {
  if (!isUuid(rawId)) return { error: "not_found" };
  const q = parseAvailabilityQuery(ctx.url, ctx.today);
  if (!q.ok) return { error: "invalid_request", message: q.message };
  const id = rawId.toLowerCase();
  const busy = await getBusyRanges(ctx.db, ctx.keyHash, id, q.value);
  return {
    body: {
      property_id: id,
      from: q.value.from,
      to: q.value.to,
      busy_dates: busy.map((b) => ({ start_date: b.start_date, end_date: b.end_date })),
    },
  };
}
