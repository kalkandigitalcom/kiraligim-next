/**
 * Harici iCal adresinden SSRF korumalı indirme. Next.js'e bağımlı değildir (cron betiği de kullanır).
 *
 * Kurallar:
 *  - Yalnız http(s), kullanıcı bilgisi yok, port 80/443 (normalizeIcalUrl).
 *  - Ad, DNS ile çözülür; çözülen adreslerden BİRİ bile özel/yerel/ayrılmış ağdaysa istek yapılmaz
 *    (loopback, RFC 1918, bağlantı-yerel, CGNAT, çok yayın, dokümantasyon, IPv6 ULA/link-local,
 *    IPv4 eşlemeli ve 6to4/Teredo/NAT64 dahil). Bağlantı, doğrulanan adrese sabitlenir
 *    (DNS rebinding'e karşı); TLS'de SNI ve sertifika asıl ad için doğrulanır.
 *  - Yönlendirmeler elle izlenir (en fazla 3) ve her adımda aynı denetim yapılır.
 *  - Toplam süre 15 sn, gövde (açılmış hali) en fazla 2 MB; yalnız 2xx kabul edilir.
 *  - Adres, gövde veya yanıt başlıkları log'a YAZILMAZ (adres erişim anahtarı içerebilir).
 */
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";

import { ICAL_LIMITS, type IcalErrorCode, normalizeIcalUrl } from "@/lib/ical-meta";

export type FetchIcsResult = { ok: true; text: string } | { ok: false; code: IcalErrorCode };

export type IcsFetcher = (url: string) => Promise<FetchIcsResult>;

const BLOCKED = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(addr, prefix, "ipv4");
}
for (const [addr, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED.addSubnet(addr, prefix, "ipv6");
}

/** Genel (internete açık) bir IP mi? */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !BLOCKED.check(address, "ipv4");
  if (family === 6) {
    // IPv4 eşlemeli adres (::ffff:a.b.c.d veya ::ffff:XXXX:XXXX) IPv4 kurallarıyla denetlenir.
    // (Not: BlockList'e ::ffff:0:0/96 kuralı eklenmez; Node tüm IPv4 adreslerini onunla eşler.)
    const dotted = /^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (dotted) return isPublicAddress(dotted[1]!);
    const hex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
    if (hex) {
      const hi = parseInt(hex[1]!, 16);
      const lo = parseInt(hex[2]!, 16);
      return isPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return !BLOCKED.check(address, "ipv6");
  }
  return false;
}

type Resolved = { address: string; family: 4 | 6 };
export type Resolver = (host: string) => Promise<Resolved[]>;

const defaultResolver: Resolver = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((r) => ({
    address: r.address,
    family: r.family === 6 ? 6 : 4,
  }));

class FetchFail extends Error {
  constructor(readonly code: IcalErrorCode) {
    super(code);
  }
}

async function resolveSafe(
  host: string,
  resolver: Resolver,
  allowed: (address: string) => boolean,
): Promise<Resolved> {
  const bare = host.replace(/^\[|\]$/g, "");
  if (net.isIP(bare)) {
    if (!allowed(bare)) throw new FetchFail("blocked_address");
    return { address: bare, family: net.isIP(bare) === 6 ? 6 : 4 };
  }
  if (
    allowed === isPublicAddress &&
    (/^localhost$/i.test(bare) || /\.(localhost|local|internal|lan|home|corp)$/i.test(bare))
  ) {
    throw new FetchFail("blocked_address");
  }
  let list: Resolved[];
  try {
    list = await resolver(bare);
  } catch {
    throw new FetchFail("dns");
  }
  if (list.length === 0) throw new FetchFail("dns");
  if (list.some((r) => !allowed(r.address))) throw new FetchFail("blocked_address");
  return list[0]!;
}

function requestOnce(
  url: URL,
  target: Resolved,
  deadline: number,
): Promise<{ status: number; location: string | null; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const remaining = Math.max(1, deadline - Date.now());
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          "user-agent": "Kiraligim-iCal/1.0 (+https://kiraligim.com)",
          accept: "text/calendar, text/plain;q=0.9, */*;q=0.5",
          "accept-encoding": "gzip, deflate, br",
        },
        // Doğrulanan adrese sabitle (DNS rebinding'e karşı); SNI/sertifika asıl ad için.
        lookup: ((_host: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) => {
          if (opts?.all) cb(null, [{ address: target.address, family: target.family }]);
          else cb(null, target.address, target.family);
        }) as unknown as net.LookupFunction,
        servername: net.isIP(url.hostname) ? undefined : url.hostname,
        timeout: remaining,
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          resolve({ status, location: res.headers.location ?? null, body: Buffer.alloc(0) });
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          resolve({ status, location: null, body: Buffer.alloc(0) });
          return;
        }
        const declared = Number(res.headers["content-length"] ?? 0);
        if (declared > ICAL_LIMITS.maxBytes * 4) {
          res.destroy();
          reject(new FetchFail("too_large"));
          return;
        }
        const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
        const stream =
          enc === "gzip" || enc === "x-gzip"
            ? res.pipe(zlib.createGunzip())
            : enc === "deflate"
              ? res.pipe(zlib.createInflate())
              : enc === "br"
                ? res.pipe(zlib.createBrotliDecompress())
                : res;
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on("data", (c: Buffer) => {
          size += c.length;
          if (size > ICAL_LIMITS.maxBytes) {
            res.destroy();
            stream.destroy();
            reject(new FetchFail("too_large"));
            return;
          }
          chunks.push(c);
        });
        stream.on("end", () => resolve({ status, location: null, body: Buffer.concat(chunks) }));
        stream.on("error", () => reject(new FetchFail("network")));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new FetchFail("timeout"));
    });
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err instanceof FetchFail) reject(err);
      else if (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN") reject(new FetchFail("dns"));
      else if (err.code === "ETIMEDOUT") reject(new FetchFail("timeout"));
      else reject(new FetchFail("network"));
    });
    req.end();
  });
}

/**
 * SSRF korumalı indirici. Testlerde çözümleyici ve (YALNIZ testte, yerel test sunucusu için)
 * adres politikası değiştirilebilir; uygulama her zaman varsayılanları kullanır.
 */
export function createIcsFetcher(
  opts: {
    resolver?: Resolver;
    addressPolicy?: (address: string) => boolean;
    timeoutMs?: number;
  } = {},
): IcsFetcher {
  const resolver = opts.resolver ?? defaultResolver;
  const allowed = opts.addressPolicy ?? isPublicAddress;
  return async (input) => {
    const normalized = normalizeIcalUrl(input);
    if (!normalized) return { ok: false, code: "invalid_url" };
    const deadline = Date.now() + (opts.timeoutMs ?? ICAL_LIMITS.timeoutMs);
    let url = new URL(normalized);
    try {
      for (let hop = 0; hop <= ICAL_LIMITS.maxRedirects; hop++) {
        const target = await resolveSafe(url.hostname, resolver, allowed);
        const res = await requestOnce(url, target, deadline);
        if (res.status >= 300 && res.status < 400) {
          if (!res.location || hop === ICAL_LIMITS.maxRedirects) {
            return { ok: false, code: "http_status" };
          }
          const next = normalizeIcalUrl(new URL(res.location, url).toString());
          if (!next) return { ok: false, code: "invalid_url" };
          url = new URL(next);
          continue;
        }
        if (res.status < 200 || res.status >= 300) return { ok: false, code: "http_status" };
        return { ok: true, text: res.body.toString("utf8") };
      }
      return { ok: false, code: "http_status" };
    } catch (err) {
      if (err instanceof FetchFail) return { ok: false, code: err.code };
      return { ok: false, code: "network" };
    }
  };
}
