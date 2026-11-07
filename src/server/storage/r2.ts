import { createHash } from "node:crypto";

import { AwsClient } from "aws4fetch";

import { assertSafeKey, type ObjectStorage, StorageError } from "./types";

/**
 * Cloudflare R2 (S3 uyumlu API, imzalama: aws4fetch / SigV4). SDK yok, doğrudan fetch.
 * Erişim anahtarı yalnız bu bucket için "Object Read & Write" yetkili olmalıdır.
 * Anahtar, imza ve yanıt gövdesi asla log'a / hata mesajına yazılmaz; yalnız durum kodu.
 */
export type R2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Herkese açık CDN kökü, ör. https://img.kiraligim.com (sonunda / yok). */
  publicBaseUrl: string;
  timeoutMs?: number;
  fetchImpl?: (request: Request) => Promise<Response>;
};

const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");

export function createR2Storage(config: R2Config): ObjectStorage {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: "auto",
    retries: 0,
  });
  const endpoint = `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}`;
  const publicBase = config.publicBaseUrl.replace(/\/+$/, "");
  const doFetch = config.fetchImpl ?? ((r: Request) => fetch(r));
  const timeoutMs = config.timeoutMs ?? 20_000;

  async function send(op: "put" | "delete", key: string, init: RequestInit): Promise<Response> {
    assertSafeKey(key);
    const signed = await client.sign(`${endpoint}/${encodeKey(key)}`, init);
    let res: Response;
    try {
      res = await doFetch(new Request(signed, { signal: AbortSignal.timeout(timeoutMs) }));
    } catch (err) {
      const reason = err instanceof Error && err.name === "TimeoutError" ? "zaman aşımı" : "ağ";
      throw new StorageError(op, `R2 isteği başarısız (${reason})`);
    }
    // Gövde (hata XML'i) okunup atılır; içeriği mesajlara taşınmaz.
    await res.arrayBuffer().catch(() => undefined);
    return res;
  }

  return {
    driver: "r2",
    async put(key, data, opts) {
      const res = await send("put", key, {
        method: "PUT",
        body: new Uint8Array(data),
        headers: {
          "content-type": opts.contentType,
          "content-length": String(data.byteLength),
          // İmzalı gövde özeti: R2 içeriği özetle doğrular (aws4fetch Uint8Array'i özetlemez).
          "x-amz-content-sha256": createHash("sha256").update(data).digest("hex"),
          ...(opts.cacheControl ? { "cache-control": opts.cacheControl } : {}),
        },
      });
      if (!res.ok)
        throw new StorageError("put", `R2 yükleme reddedildi (${res.status})`, res.status);
    },
    async delete(key) {
      const res = await send("delete", key, { method: "DELETE" });
      // S3: olmayan nesne de 204 döner; 404'ü de başarılı sayarız.
      if (!res.ok && res.status !== 404) {
        throw new StorageError("delete", `R2 silme reddedildi (${res.status})`, res.status);
      }
    },
    publicUrl(key) {
      assertSafeKey(key);
      return `${publicBase}/${encodeKey(key)}`;
    },
  };
}
