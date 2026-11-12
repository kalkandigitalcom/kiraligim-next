/**
 * Acente API'si 2. aşama, 5. adım — webhook'lar (drizzle/0060, 0061).
 *
 * Yapılandırma (acentenin API anahtarıyla):
 *  - Adres yalnız HTTPS; kullanıcı bilgisi, özel port, parça (#) yok; doğrudan yerel/özel IP veya
 *    yerel ağ adı reddedilir. DNS denetimi kayıtta değil, HER GÖNDERİMDE yapılır (rebinding).
 *  - Sır `whsec_` + 32 rastgele bayt; uygulamada AES-256-GCM ile şifrelenir
 *    (API_WEBHOOK_SECRET_KEY, veritabanında yok). Düz sır yalnız oluşturma ve yenileme yanıtında
 *    bir kez gösterilir; veritabanına ve log'a yazılmaz.
 *
 * Gönderim (işlemci süreci, app_api_claim_deliveries / app_api_finish_delivery):
 *  - Ad bir kez çözülür; DÖNEN TÜM adresler genel olmalıdır. Bağlantı doğrulanan adrese sabitlenir
 *    (özel lookup), sertifika/SNI asıl ad için doğrulanır. Yönlendirme izlenmez (3xx = başarısız),
 *    10 sn zaman aşımı, yanıt gövdesi okunmadan atılır.
 *  - İmza: Kiraligim-Signature: v1=<hex HMAC-SHA256(sır, "<timestamp>.<gövde>")>;
 *    Kiraligim-Timestamp (unix sn) ve Kiraligim-Event-Id (yeniden denemelerde aynı) başlıkları.
 *  - Log'a yalnız sayılar ve hata kodları yazılır (adres, gövde, sır, yanıt yazılmaz).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

import { sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { pgErrorInfo } from "@/db/pg-error";
import { decryptSecret, encryptSecret, parseSecretKey } from "@/server/admin/crypto";
import { isBlockedHost, isPublicAddress, type Resolver } from "@/server/ical/fetch";

import { ApiUnauthorized } from "./service";

export const WEBHOOK_URL_MAX = 2048;
export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_EVENT_TYPE = "calendar.changed";
export const WEBHOOK_HEADERS = {
  eventId: "kiraligim-event-id",
  timestamp: "kiraligim-timestamp",
  signature: "kiraligim-signature",
} as const;

// ---------------------------------------------------------------------------------------------
// Sır ve imza
// ---------------------------------------------------------------------------------------------

/** API_WEBHOOK_SECRET_KEY (base64, 32 bayt). Yoksa/bozuksa null: webhook özellikleri kapalı. */
export const webhookKey = (): Buffer | null => parseSecretKey(process.env.API_WEBHOOK_SECRET_KEY);

export const newWebhookSecret = (): string => `whsec_${randomBytes(32).toString("base64url")}`;

export const encryptWebhookSecret = (secret: string, key: Buffer): string =>
  encryptSecret(secret, key);

export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex")}`;
}

/** Acente tarafındaki doğrulamanın başvuru uygulaması (dokümantasyon ve testler). */
export function verifyWebhookSignature(
  secret: string,
  header: string | null,
  timestamp: string | null,
  body: string,
  opts: { nowSeconds?: number; toleranceSeconds?: number } = {},
): boolean {
  if (!header || !timestamp || !/^\d{1,12}$/.test(timestamp)) return false;
  const ts = Number(timestamp);
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > (opts.toleranceSeconds ?? 300)) return false;
  const expected = Buffer.from(signWebhook(secret, ts, body));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// ---------------------------------------------------------------------------------------------
// Adres doğrulama (kayıt)
// ---------------------------------------------------------------------------------------------

export function validateWebhookUrl(raw: unknown): { ok: true; url: string } | { ok: false } {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > WEBHOOK_URL_MAX) {
    return { ok: false };
  }
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) return { ok: false };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false };
  }
  if (u.protocol !== "https:") return { ok: false };
  if (u.username || u.password) return { ok: false };
  if (u.port !== "" && u.port !== "443") return { ok: false };
  if (u.hash || raw.includes("#")) return { ok: false };
  const host = u.hostname;
  if (!host || isBlockedHost(host)) return { ok: false };
  const bare = host.replace(/^\[|\]$/g, "");
  // Tek etiketli adlar (intranet) kabul edilmez; IP değişmezi genel olmalıdır (isBlockedHost).
  if (!net.isIP(bare) && !bare.replace(/\.$/, "").includes(".")) return { ok: false };
  const href = u.href;
  if (href.length > WEBHOOK_URL_MAX || !/^https:\/\/[^/@\s]+(\/\S*)?$/.test(href)) {
    return { ok: false };
  }
  return { ok: true, url: href };
}

// ---------------------------------------------------------------------------------------------
// Yapılandırma (veritabanı)
// ---------------------------------------------------------------------------------------------

export type WebhookView = {
  url: string;
  created_at: string;
  updated_at: string;
  secret_rotated_at: string | null;
};

type WebhookRow = {
  url: string;
  created_at: Date | string;
  updated_at: Date | string;
  secret_rotated_at: Date | string | null;
};

const iso = (v: Date | string) => new Date(v).toISOString();
const view = (r: WebhookRow): WebhookView => ({
  url: r.url,
  created_at: iso(r.created_at),
  updated_at: iso(r.updated_at),
  secret_rotated_at: r.secret_rotated_at ? iso(r.secret_rotated_at) : null,
});

function mapError(err: unknown): never {
  if (pgErrorInfo(err).code === "28000") throw new ApiUnauthorized();
  throw err;
}

export async function getWebhook(db: Database, keyHash: string): Promise<WebhookView | null> {
  try {
    const r = await db.execute<WebhookRow>(
      sql`select * from public.app_api_webhook_get(${keyHash})`,
    );
    return r.rows[0] ? view(r.rows[0]) : null;
  } catch (err) {
    mapError(err);
  }
}

export async function putWebhook(
  db: Database,
  keyHash: string,
  url: string,
  secretEnc: string,
): Promise<{ created: boolean; webhook: WebhookView }> {
  try {
    const r = await db.execute<WebhookRow & { outcome: "created" | "updated" }>(
      sql`select * from public.app_api_webhook_put(${keyHash}, ${url}, ${secretEnc})`,
    );
    const row = r.rows[0]!;
    return { created: row.outcome === "created", webhook: view(row) };
  } catch (err) {
    mapError(err);
  }
}

export async function rotateWebhookSecret(
  db: Database,
  keyHash: string,
  secretEnc: string,
): Promise<string | null> {
  try {
    const r = await db.execute<{ outcome: string; secret_rotated_at: Date | string | null }>(
      sql`select * from public.app_api_webhook_rotate(${keyHash}, ${secretEnc})`,
    );
    const row = r.rows[0];
    return row?.outcome === "rotated" && row.secret_rotated_at ? iso(row.secret_rotated_at) : null;
  } catch (err) {
    mapError(err);
  }
}

export async function deleteWebhook(db: Database, keyHash: string): Promise<boolean> {
  try {
    const r = await db.execute<{ outcome: string }>(
      sql`select public.app_api_webhook_delete(${keyHash}) as outcome`,
    );
    return r.rows[0]?.outcome === "deleted";
  } catch (err) {
    mapError(err);
  }
}

// ---------------------------------------------------------------------------------------------
// SSRF korumalı gönderim
// ---------------------------------------------------------------------------------------------

export type SendErrorCode =
  "invalid_url" | "dns" | "blocked_address" | "timeout" | "network" | "redirect" | "http_status";

export type SendResult =
  { ok: true; status: number } | { ok: false; code: SendErrorCode; status?: number };

export type SendOptions = {
  resolver?: Resolver;
  /** YALNIZ testte değiştirilir (yerel test sunucusu); uygulama her zaman isPublicAddress kullanır. */
  allowAddress?: (address: string) => boolean;
  /** YALNIZ testte: http:// yerel test sunucusu. */
  allowHttp?: boolean;
  timeoutMs?: number;
  /** YALNIZ testte: kendinden imzalı test sertifikasının CA'sı (doğrulama yine açıktır). */
  ca?: string | Buffer;
};

const defaultResolver: Resolver = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((r) => ({
    address: r.address,
    family: r.family === 6 ? 6 : 4,
  }));

const LOCAL_NAME_RE = /^localhost$|\.(localhost|local|internal|lan|home|corp)$/i;

/**
 * Tek POST. Ad bir kez çözülür, bütün adresler izinli olmalıdır; bağlantı ilk adrese sabitlenir
 * (ikinci DNS sorgusu yapılmaz → DNS rebinding etkisiz).
 */
export async function sendWebhook(
  rawUrl: string,
  headers: Record<string, string>,
  body: string,
  opts: SendOptions = {},
): Promise<SendResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, code: "invalid_url" };
  }
  const allowHttp = opts.allowHttp === true;
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    return { ok: false, code: "invalid_url" };
  }
  if (url.username || url.password) return { ok: false, code: "invalid_url" };
  const allowed = opts.allowAddress ?? isPublicAddress;
  const bare = url.hostname.replace(/^\[|\]$/g, "");

  let target: { address: string; family: 4 | 6 };
  if (net.isIP(bare)) {
    if (!allowed(bare)) return { ok: false, code: "blocked_address" };
    target = { address: bare, family: net.isIP(bare) === 6 ? 6 : 4 };
  } else {
    if (!opts.allowAddress && LOCAL_NAME_RE.test(bare.replace(/\.$/, ""))) {
      return { ok: false, code: "blocked_address" };
    }
    let list: { address: string; family: 4 | 6 }[];
    try {
      list = await (opts.resolver ?? defaultResolver)(bare);
    } catch {
      return { ok: false, code: "dns" };
    }
    if (list.length === 0) return { ok: false, code: "dns" };
    if (list.some((r) => !allowed(r.address))) return { ok: false, code: "blocked_address" };
    target = list[0]!;
  }

  const timeoutMs = opts.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  return new Promise<SendResult>((resolve) => {
    let settled = false;
    const done = (r: SendResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: bare,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
          "user-agent": "Kiraligim-Webhooks/1.0 (+https://kiraligim.com)",
        },
        lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => {
          if (o?.all) cb(null, [{ address: target.address, family: target.family }]);
          else cb(null, target.address, target.family);
        }) as unknown as net.LookupFunction,
        servername: net.isIP(bare) ? undefined : bare,
        agent: false,
        ...(opts.ca ? { ca: opts.ca } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // Gövde okunmaz (kişisel veri / büyük yanıt), bağlantı hemen bırakılır.
        res.resume();
        res.on("error", () => undefined);
        if (status >= 200 && status < 300) done({ ok: true, status });
        else if (status >= 300 && status < 400) done({ ok: false, code: "redirect", status });
        else done({ ok: false, code: "http_status", status });
        req.destroy();
      },
    );
    // Toplam süre sınırı (bağlantı + yanıt başlığı); yavaş sunucu sonsuza dek tutamaz.
    const timer = setTimeout(() => {
      done({ ok: false, code: "timeout" });
      req.destroy();
    }, timeoutMs);
    req.on("error", (err: NodeJS.ErrnoException) => {
      done({
        ok: false,
        code: err.code === "ENOTFOUND" || err.code === "EAI_AGAIN" ? "dns" : "network",
      });
    });
    req.end(body);
  });
}

// ---------------------------------------------------------------------------------------------
// Teslim döngüsü
// ---------------------------------------------------------------------------------------------

type Claimed = {
  id: string;
  lease_token: string;
  attempt: number;
  url: string;
  secret_enc: string;
  body: string;
};

export type DeliverOptions = SendOptions & {
  key?: Buffer | null;
  limit?: number;
  leaseSeconds?: number;
  maxMs?: number;
  now?: () => number;
};

export type DeliverSummary = {
  attempted: number;
  delivered: number;
  retried: number;
  failed: number;
  stale: number;
};

export async function claimDeliveries(
  db: Database,
  limit: number,
  leaseSeconds: number,
): Promise<Claimed[]> {
  const r = await db.execute<Claimed>(
    sql`select * from public.app_api_claim_deliveries(${limit}::integer, ${leaseSeconds}::integer)`,
  );
  return r.rows.map((x) => ({ ...x, attempt: Number(x.attempt) }));
}

export async function finishDelivery(
  db: Database,
  id: string,
  token: string,
  ok: boolean,
  status: number | null,
  error: string | null,
): Promise<"delivered" | "retry" | "failed" | "stale"> {
  const r = await db.execute<{ outcome: "delivered" | "retry" | "failed" | "stale" }>(
    sql`select public.app_api_finish_delivery(${id}::uuid, ${token}::uuid, ${ok}, ${status}::integer, ${error}) as outcome`,
  );
  return r.rows[0]!.outcome;
}

/**
 * Süresi gelmiş teslimleri gönderir. Her turda bağlantı başına en fazla bir teslim alınır (en eski);
 * o bitmeden aynı bağlantının sonraki olayı alınmaz → bağlantı başına sıra korunur. Gönderilip
 * sonuç yazılamazsa kilit süresi dolunca yeniden gönderilir (en az bir kez; olay kimliği aynı).
 */
export async function deliverDue(db: Database, opts: DeliverOptions = {}): Promise<DeliverSummary> {
  const key = opts.key === undefined ? webhookKey() : opts.key;
  const sum: DeliverSummary = { attempted: 0, delivered: 0, retried: 0, failed: 0, stale: 0 };
  if (!key) return sum;
  const limit = opts.limit ?? 10;
  const leaseSeconds = opts.leaseSeconds ?? 60;
  const now = opts.now ?? Date.now;
  const started = now();
  const maxMs = opts.maxMs ?? 20_000;

  for (;;) {
    const batch = await claimDeliveries(db, limit, leaseSeconds);
    if (batch.length === 0) break;
    const results = await Promise.all(
      batch.map(async (d) => {
        const secret = decryptSecret(d.secret_enc, key);
        let res: SendResult;
        if (!secret) {
          res = { ok: false, code: "network" };
        } else {
          const ts = Math.floor(Date.now() / 1000);
          res = await sendWebhook(
            d.url,
            {
              [WEBHOOK_HEADERS.eventId]: d.id,
              [WEBHOOK_HEADERS.timestamp]: String(ts),
              [WEBHOOK_HEADERS.signature]: signWebhook(secret, ts, d.body),
            },
            d.body,
            opts,
          );
        }
        const error = res.ok ? null : secret ? res.code : "secret_unreadable";
        return { d, res, error };
      }),
    );
    for (const { d, res, error } of results) {
      sum.attempted += 1;
      const out = await finishDelivery(db, d.id, d.lease_token, res.ok, res.status ?? null, error);
      if (out === "delivered") sum.delivered += 1;
      else if (out === "retry") sum.retried += 1;
      else if (out === "failed") sum.failed += 1;
      else sum.stale += 1;
    }
    if (now() - started >= maxMs) break;
  }
  return sum;
}

export async function pruneDeliveries(db: Database): Promise<number> {
  const r = await db.execute<{ n: number }>(sql`select public.app_api_prune_deliveries() as n`);
  return Number(r.rows[0]?.n ?? 0);
}
