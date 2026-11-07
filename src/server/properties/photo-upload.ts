import "server-only";

import { uuidv7 } from "uuidv7";

import type { Database } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { AppError, GENERIC_ERROR_MESSAGE } from "@/lib/errors";
import { type Logger, logger as rootLogger } from "@/lib/logger";
import { PHOTO_LIMITS, type PhotoWidth } from "@/lib/photo-meta";
import { ImageRejectedError, processImage } from "@/server/media/image";
import { type createJobQueue, imageQueue, QueueBusyError } from "@/server/media/queue";
import { IMMUTABLE_CACHE_CONTROL, type ObjectStorage } from "@/server/storage/types";

import { photoSources } from "./photo-urls";
import { insertPhoto, photoPrefix, precheckPhotoUpload, variantKey } from "./photos";
import { isUuid } from "./service";

/**
 * POST /api/mulkler/{id}/fotograflar — tek fotoğraf yükleme. Gövde: ham dosya baytları
 * (multipart değil), Content-Type: image/jpeg | image/png | image/webp | application/octet-stream.
 *
 * Sıra (her adım bir öncekini geçemeyen isteği durdurur):
 *  1. Host yalnız app.<alan-adı>; Origin aynı köken (CSRF); Sec-Fetch-Site varsa same-origin.
 *  2. Depolama yapılandırılmamışsa 503 (sahte başarı yok).
 *  3. Oturum (401) ve aktif işletme (409) — kimlik YALNIZ doğrulanmış oturumdan.
 *  4. Mülk kimliği, Content-Length / Content-Type ön denetimi (413 / 415).
 *  5. Kısa transaction: rol, mülk (RLS) ve 80 sınırı (403 / 404 / 402).
 *  6. Gövde akış halinde okunur, 15 MB aşılırsa kesilir (413).
 *  7. Görsel kuyrukta işlenir (aynı anda 1, en fazla 3 bekleyen; doluysa 503 + Retry-After).
 *     Biçim dosya baytlarından belirlenir; uzantı / Content-Type'a güvenilmez (422).
 *  8. 3 WebP varyantı depolamaya yazılır (orijinal hiçbir yere yazılmaz).
 *  9. Kısa transaction: kayıt + denetim; sınır tetikleyicide kilit altında yeniden denetlenir.
 *     8 veya 9 başarısız olursa yüklenen nesneler silinir (en iyi çaba).
 */
export type UploadActor =
  | { kind: "ok"; userId: string; workspaceId: string }
  | { kind: "unauthenticated" }
  | { kind: "no_workspace" };

export type PhotoUploadDeps = {
  appUrl: string;
  db: Database;
  getStorage: () => ObjectStorage | null;
  resolveActor: () => Promise<UploadActor>;
  queue?: ReturnType<typeof createJobQueue>;
  process?: typeof processImage;
  newId?: () => string;
  log?: Logger;
  maxInputBytes?: number;
};

const ACCEPTED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/octet-stream",
]);

const json = (status: number, body: Record<string, unknown>, extra: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
      ...extra,
    },
  });

const fail = (status: number, code: string, message: string, extra?: HeadersInit) =>
  json(status, { ok: false, code, message }, extra);

/** Gövdeyi en fazla `max` bayta kadar okur; aşarsa akışı iptal eder. */
export async function readBodyCapped(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<Uint8Array | "too_large" | "empty"> {
  if (!body) return "empty";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return "too_large";
    }
    chunks.push(value);
  }
  if (total === 0) return "empty";
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export function createPhotoUploadHandler(deps: PhotoUploadDeps) {
  const app = new URL(deps.appUrl);
  const appHost = app.host.toLowerCase();
  const appOrigin = app.origin;
  const queue = deps.queue ?? imageQueue;
  const process = deps.process ?? processImage;
  const newId = deps.newId ?? uuidv7;
  const log = (deps.log ?? rootLogger).child({ component: "photo_upload" });
  const maxInput = deps.maxInputBytes ?? PHOTO_LIMITS.maxInputBytes;
  const tooLargeMessage = `Dosya en fazla ${Math.round(maxInput / (1024 * 1024))} MB olabilir.`;

  return async (request: Request, propertyId: string): Promise<Response> => {
    // 1. Host ve köken
    if (request.headers.get("host")?.trim().toLowerCase() !== appHost) {
      return fail(404, "NOT_FOUND", "Bulunamadı.");
    }
    const fetchSite = request.headers.get("sec-fetch-site");
    if (request.headers.get("origin") !== appOrigin || (fetchSite && fetchSite !== "same-origin")) {
      return fail(403, "FORBIDDEN", "İstek reddedildi.");
    }

    // 2. Depolama
    const storage = deps.getStorage();
    if (!storage) {
      return fail(
        503,
        "STORAGE_UNAVAILABLE",
        "Fotoğraf depolama henüz yapılandırılmadı. Lütfen daha sonra tekrar deneyin.",
      );
    }

    // 3. Oturum ve işletme
    const actor = await deps.resolveActor();
    if (actor.kind === "unauthenticated") {
      return fail(401, "UNAUTHORIZED", "Oturumunuz sona ermiş. Lütfen yeniden giriş yapın.");
    }
    if (actor.kind === "no_workspace") {
      return fail(409, "NO_WORKSPACE", "Önce bir işletme seçin.");
    }

    // 4. Ön denetimler
    if (!isUuid(propertyId)) return fail(404, "NOT_FOUND", "Mülk bulunamadı.");
    const contentType = (request.headers.get("content-type") ?? "").split(";")[0]!.trim();
    if (!ACCEPTED_CONTENT_TYPES.has(contentType.toLowerCase())) {
      return fail(
        415,
        "UNSUPPORTED_FORMAT",
        "Yalnız JPG, JPEG, PNG ve WebP fotoğraflar yüklenebilir.",
      );
    }
    const declared = Number(request.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared > maxInput) {
      return fail(413, "TOO_LARGE", tooLargeMessage);
    }

    const ctxInput = { userId: actor.userId, workspaceId: actor.workspaceId };
    try {
      // 5. Rol, mülk, sınır
      await withTenant(deps.db, ctxInput, (tx, ctx) => precheckPhotoUpload(tx, ctx, propertyId));

      // 6. Gövde
      const body = await readBodyCapped(request.body, maxInput);
      if (body === "too_large") return fail(413, "TOO_LARGE", tooLargeMessage);
      if (body === "empty") return fail(400, "EMPTY", "Dosya boş.");

      // 7. İşleme
      const processed = await queue.run(() => process(body));

      // 8. Depolama
      const photoId = newId();
      const prefix = photoPrefix(actor.workspaceId, propertyId, photoId);
      const uploaded: string[] = [];
      const cleanup = async () => {
        const results = await Promise.allSettled(uploaded.map((k) => storage.delete(k)));
        const failed = results.filter((r) => r.status === "rejected").length;
        if (failed > 0) log.warn("photo_cleanup_failed", { prefix, failed });
      };
      try {
        for (const v of processed.variants) {
          const key = variantKey(prefix, v.width);
          await storage.put(key, v.data, {
            contentType: "image/webp",
            cacheControl: IMMUTABLE_CACHE_CONTROL,
          });
          uploaded.push(key);
        }
      } catch (err) {
        log.error("photo_storage_failed", { prefix, err });
        await cleanup();
        return fail(
          502,
          "STORAGE_FAILED",
          "Fotoğraf depolamaya yüklenemedi. Lütfen tekrar deneyin.",
        );
      }

      // 9. Kayıt
      const bytes = Object.fromEntries(
        processed.variants.map((v) => [v.width, v.data.byteLength]),
      ) as Record<PhotoWidth, number>;
      let saved: { sortOrder: number; isCover: boolean };
      try {
        saved = await withTenant(deps.db, ctxInput, (tx, ctx) =>
          insertPhoto(tx, ctx, {
            id: photoId,
            propertyId,
            storagePrefix: prefix,
            width: processed.width,
            height: processed.height,
            quality: processed.quality,
            bytes,
          }),
        );
      } catch (err) {
        await cleanup();
        throw err;
      }
      log.info("photo_uploaded", { property: propertyId, photo: photoId });
      return json(201, {
        ok: true,
        photo: {
          id: photoId,
          width: processed.width,
          height: processed.height,
          sortOrder: saved.sortOrder,
          isCover: saved.isCover,
          sources: photoSources(storage, prefix),
        },
      });
    } catch (err) {
      if (err instanceof ImageRejectedError) {
        return fail(422, "IMAGE_REJECTED", err.message);
      }
      if (err instanceof QueueBusyError) {
        return fail(503, "BUSY", err.message, { "retry-after": "5" });
      }
      if (err instanceof AppError && err.expose) {
        // withTenant üyelik reddi → işletme yok/askıda: 404 ile aynı.
        return fail(err.status, err.code, err.message);
      }
      log.error("photo_upload_failed", { err });
      return fail(500, "INTERNAL", GENERIC_ERROR_MESSAGE);
    }
  };
}
