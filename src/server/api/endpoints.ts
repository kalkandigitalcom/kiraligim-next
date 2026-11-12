/**
 * Acente API'si — uç nokta gövdeleri. Yanıtlar yalnız aşağıda açıkça kurulan alanları içerir:
 * hesap adı/sınırı, villa kimliği/adı ve dolu tarih aralıkları. Veritabanı satırı olduğu gibi
 * dönmez.
 */
import { API_EXTERNAL_ID_PATTERN } from "@/lib/api-meta";

import {
  connectProperty,
  disconnect,
  getConnection,
  listConnections,
  readAccountChanges,
  readChanges,
  takeSnapshot,
} from "./connections";
import type { ApiContext, ApiResult } from "./handler";
import {
  isUuid,
  parseAccountChangesQuery,
  parseAvailabilityQuery,
  parseChangesQuery,
  parseConnectionListQuery,
  parseListQuery,
  readJsonBody,
} from "./http";
import { getBusyRanges, getProperty, listProperties } from "./service";
import {
  deleteWebhook,
  encryptWebhookSecret,
  getWebhook,
  newWebhookSecret,
  putWebhook,
  rotateWebhookSecret,
  validateWebhookUrl,
  webhookKey,
} from "./webhooks";

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

// ---------------------------------------------------------------------------------------------
// 2. aşama — takvim bağlantıları
// ---------------------------------------------------------------------------------------------

const CONNECT_FIELDS = new Set(["property_id", "external_property_id"]);

/** POST /api/v1/calendar-connections {property_id, external_property_id} */
export async function connectEndpoint(ctx: ApiContext): Promise<ApiResult> {
  if ([...ctx.url.searchParams.keys()].length > 0) {
    return { error: "invalid_request", message: "This endpoint takes no parameters." };
  }
  const body = await readJsonBody(ctx.request);
  if (!body.ok) return { error: body.code, ...(body.message ? { message: body.message } : {}) };
  for (const k of Object.keys(body.value)) {
    if (!CONNECT_FIELDS.has(k)) return { error: "invalid_request", message: `Unknown field: ${k}` };
  }
  const propertyId = body.value.property_id;
  const external = body.value.external_property_id;
  if (typeof propertyId !== "string" || !isUuid(propertyId)) {
    return { error: "invalid_request", message: "property_id must be a UUID." };
  }
  if (typeof external !== "string" || !API_EXTERNAL_ID_PATTERN.test(external)) {
    return {
      error: "invalid_request",
      message:
        "external_property_id must be 1-100 printable ASCII characters without leading or trailing spaces.",
    };
  }
  const r = await connectProperty(ctx.db, ctx.keyHash, {
    propertyId: propertyId.toLowerCase(),
    externalPropertyId: external,
  });
  if (r.outcome === "created") return { body: r.connection, status: 201 };
  if (r.outcome === "exists") return { body: r.connection };
  return { error: r.outcome };
}

/** GET /api/v1/calendar-connections?limit=&cursor=&status=current|all */
export async function connectionsEndpoint(ctx: ApiContext): Promise<ApiResult> {
  const q = parseConnectionListQuery(ctx.url);
  if (!q.ok) return { error: "invalid_request", message: q.message };
  const data = await listConnections(ctx.db, ctx.keyHash, q.value);
  const last = data.at(-1);
  return {
    body: { data, next_cursor: data.length === q.value.limit && last ? last.id : null },
  };
}

/** GET /api/v1/calendar-connections/{id} */
export async function connectionEndpoint(ctx: ApiContext, rawId: string): Promise<ApiResult> {
  if ([...ctx.url.searchParams.keys()].length > 0) {
    return { error: "invalid_request", message: "This endpoint takes no parameters." };
  }
  if (!isUuid(rawId)) return { error: "not_found" };
  const c = await getConnection(ctx.db, ctx.keyHash, rawId.toLowerCase());
  return c ? { body: c } : { error: "not_found" };
}

/**
 * DELETE /api/v1/calendar-connections/{id} — senkronizasyonu durdurur; acentenin kendi
 * sistemindeki kayıtlara dokunulmaz. Tekrar çağrılırsa bağlantının son hâli döner (idempotent).
 */
export async function disconnectEndpoint(ctx: ApiContext, rawId: string): Promise<ApiResult> {
  if ([...ctx.url.searchParams.keys()].length > 0) {
    return { error: "invalid_request", message: "This endpoint takes no parameters." };
  }
  if (!isUuid(rawId)) return { error: "not_found" };
  const r = await disconnect(ctx.db, ctx.keyHash, rawId.toLowerCase());
  return r ? { body: r.connection } : { error: "not_found" };
}

// ---------------------------------------------------------------------------------------------
// 3. adım — snapshot ve cursor
// ---------------------------------------------------------------------------------------------

/**
 * GET /api/v1/calendar-connections/{id}/snapshot — 12 ay geri / 24 ay ileri dolu aralıklar
 * [start_date, end_date) ve aynı veri anının cursor'ı. Yeniden senkronizasyon için de kullanılır.
 */
export async function snapshotEndpoint(ctx: ApiContext, rawId: string): Promise<ApiResult> {
  if ([...ctx.url.searchParams.keys()].length > 0) {
    return { error: "invalid_request", message: "This endpoint takes no parameters." };
  }
  if (!isUuid(rawId)) return { error: "not_found" };
  const s = await takeSnapshot(ctx.db, ctx.keyHash, rawId.toLowerCase());
  return s ? { body: s } : { error: "not_found" };
}

/** GET /api/v1/calendar-connections/{id}/changes?cursor=&limit= */
export async function changesEndpoint(ctx: ApiContext, rawId: string): Promise<ApiResult> {
  const q = parseChangesQuery(ctx.url);
  if (!q.ok) return { error: "invalid_request", message: q.message };
  if (!isUuid(rawId)) return { error: "not_found" };
  const r = await readChanges(ctx.db, ctx.keyHash, rawId.toLowerCase(), q.value);
  return r.outcome === "ok" ? { body: r.body } : { error: r.outcome };
}

// ---------------------------------------------------------------------------------------------
// 5. adım — hesap geneli değişiklik akışı ve webhook
// ---------------------------------------------------------------------------------------------

/**
 * GET /api/v1/calendar-changes?cursor=&limit= — hesabın etkin bağlantılarındaki değişiklikler.
 * Cursor yoksa şimdiki konumdan başlar (boş liste + cursor). Her bağlantı için yalnız son
 * snapshot'tan sonraki değişiklikler gelir.
 */
export async function accountChangesEndpoint(ctx: ApiContext): Promise<ApiResult> {
  const q = parseAccountChangesQuery(ctx.url);
  if (!q.ok) return { error: "invalid_request", message: q.message };
  const r = await readAccountChanges(ctx.db, ctx.keyHash, q.value);
  return r.outcome === "ok" ? { body: r.body } : { error: r.outcome };
}

const noParams = (ctx: ApiContext): ApiResult | null =>
  [...ctx.url.searchParams.keys()].length > 0
    ? { error: "invalid_request", message: "This endpoint takes no parameters." }
    : null;

/** GET /api/v1/webhook */
export async function webhookGetEndpoint(ctx: ApiContext): Promise<ApiResult> {
  const bad = noParams(ctx);
  if (bad) return bad;
  const w = await getWebhook(ctx.db, ctx.keyHash);
  return w ? { body: w } : { error: "not_found" };
}

/**
 * PUT /api/v1/webhook {url} — oluşturur (201, sır YALNIZ bu yanıtta) ya da adresi değiştirir
 * (200, sır değişmez). Adres https olmalı; yerel/özel ağ adresleri reddedilir.
 */
export async function webhookPutEndpoint(ctx: ApiContext): Promise<ApiResult> {
  const bad = noParams(ctx);
  if (bad) return bad;
  const body = await readJsonBody(ctx.request);
  if (!body.ok) return { error: body.code, ...(body.message ? { message: body.message } : {}) };
  for (const k of Object.keys(body.value)) {
    if (k !== "url") return { error: "invalid_request", message: `Unknown field: ${k}` };
  }
  const v = validateWebhookUrl(body.value.url);
  if (!v.ok) {
    return {
      error: "invalid_request",
      message:
        "url must be an https URL on port 443 without credentials or fragment, pointing to a public host.",
    };
  }
  const key = webhookKey();
  if (!key) return { error: "webhooks_unavailable" };
  const secret = newWebhookSecret();
  const r = await putWebhook(ctx.db, ctx.keyHash, v.url, encryptWebhookSecret(secret, key));
  return r.created ? { body: { ...r.webhook, secret }, status: 201 } : { body: r.webhook };
}

/** DELETE /api/v1/webhook — bekleyen teslimler iptal edilir. */
export async function webhookDeleteEndpoint(ctx: ApiContext): Promise<ApiResult> {
  const bad = noParams(ctx);
  if (bad) return bad;
  return (await deleteWebhook(ctx.db, ctx.keyHash))
    ? { body: { deleted: true } }
    : { error: "not_found" };
}

/** POST /api/v1/webhook/rotate-secret — yeni sır (yalnız bu yanıtta); eskisi hemen geçersiz. */
export async function webhookRotateEndpoint(ctx: ApiContext): Promise<ApiResult> {
  const bad = noParams(ctx);
  if (bad) return bad;
  const key = webhookKey();
  if (!key) return { error: "webhooks_unavailable" };
  const secret = newWebhookSecret();
  const at = await rotateWebhookSecret(ctx.db, ctx.keyHash, encryptWebhookSecret(secret, key));
  return at ? { body: { secret, secret_rotated_at: at } } : { error: "not_found" };
}
