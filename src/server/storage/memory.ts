import { assertSafeKey, type ObjectStorage, type PutOptions } from "./types";

export type MemoryObject = { data: Uint8Array; contentType: string; cacheControl?: string };

export type MemoryStorage = ObjectStorage & {
  readonly objects: Map<string, MemoryObject>;
  /** Testler: sonraki put çağrısı (veya n'inci) hata versin. */
  failNextPut(afterSuccessfulPuts?: number): void;
};

/** Yalnız testler: nesneler bellekte tutulur. */
export function createMemoryStorage(baseUrl = "https://img.test.invalid"): MemoryStorage {
  const objects = new Map<string, MemoryObject>();
  let failAfter: number | null = null;
  return {
    driver: "memory",
    objects,
    failNextPut(afterSuccessfulPuts = 0) {
      failAfter = afterSuccessfulPuts;
    },
    async put(key: string, data: Uint8Array, opts: PutOptions) {
      assertSafeKey(key);
      if (failAfter !== null) {
        if (failAfter === 0) {
          failAfter = null;
          throw new Error("memory storage: put failed (test)");
        }
        failAfter--;
      }
      objects.set(key, {
        data: new Uint8Array(data),
        contentType: opts.contentType,
        ...(opts.cacheControl ? { cacheControl: opts.cacheControl } : {}),
      });
    },
    async delete(key: string) {
      assertSafeKey(key);
      objects.delete(key);
    },
    publicUrl(key: string) {
      assertSafeKey(key);
      return `${baseUrl}/${key}`;
    },
  };
}
