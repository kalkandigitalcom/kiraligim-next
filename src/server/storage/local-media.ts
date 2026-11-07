import "server-only";

import type { AppEnv } from "@/lib/env";

import { getStorage, getStorageStatus } from "./index";
import { createFilesystemStorage } from "./filesystem";

/** Yalnız fotoğraf varyantı anahtarları sunulur: w/{uuid}/p/{uuid}/{uuid}/{400|1200|2000}.webp */
export const LOCAL_MEDIA_KEY =
  /^w\/[0-9a-f-]{36}\/p\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/(400|1200|2000)\.webp$/;

const notFound = () =>
  new Response("Not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex" },
  });

export function createLocalMediaHandler(opts: { appUrl: string; appEnv: AppEnv }) {
  const appHost = new URL(opts.appUrl).host.toLowerCase();
  return async (request: Request, segments: string[]): Promise<Response> => {
    if (opts.appEnv === "production") return notFound();
    if (request.headers.get("host")?.trim().toLowerCase() !== appHost) return notFound();
    const status = getStorageStatus();
    if (!status.ok || status.config.driver !== "filesystem" || !getStorage()) return notFound();
    const key = segments.join("/");
    if (!LOCAL_MEDIA_KEY.test(key)) return notFound();
    const data = await createFilesystemStorage(status.config.localDir).read(key);
    if (!data) return notFound();
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        "content-type": "image/webp",
        "content-length": String(data.byteLength),
        "cache-control": "public, max-age=3600",
        "x-content-type-options": "nosniff",
        "x-robots-tag": "noindex",
      },
    });
  };
}
