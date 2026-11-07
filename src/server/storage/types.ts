/**
 * Nesne depolama arayüzü. Sürücüler: r2 (Cloudflare R2, S3 uyumlu API), filesystem (yalnız yerel
 * geliştirme), memory (testler). Anahtarlar (key) yalnız uygulama tarafından üretilir; yine de her
 * sürücü anahtarı `assertSafeKey` ile doğrular (yol geçişi, boş bölüm, beklenmeyen karakter yok).
 */
export type StorageDriver = "r2" | "filesystem" | "memory";

export type PutOptions = {
  contentType: string;
  cacheControl?: string;
};

export interface ObjectStorage {
  readonly driver: StorageDriver;
  put(key: string, data: Uint8Array, opts: PutOptions): Promise<void>;
  /** Nesne yoksa da başarılı sayılır (idempotent). */
  delete(key: string): Promise<void>;
  /** Herkese açık adres (R2: CDN alan adı; yerel: /api/medya/...). */
  publicUrl(key: string): string;
}

export class StorageError extends Error {
  constructor(
    readonly operation: "put" | "delete" | "get",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

/** Değişmeyen nesneler (her fotoğrafın anahtarı benzersizdir, üzerine yazılmaz). */
export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

const SAFE_KEY = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;

export function isSafeKey(key: string): boolean {
  return (
    key.length > 0 &&
    key.length <= 512 &&
    SAFE_KEY.test(key) &&
    !key.split("/").some((part) => part === "." || part === ".." || part.includes(".."))
  );
}

export function assertSafeKey(key: string): void {
  if (!isSafeKey(key)) throw new StorageError("put", "Geçersiz depolama anahtarı");
}
