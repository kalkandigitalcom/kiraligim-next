import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { assertSafeKey, isSafeKey, type ObjectStorage, StorageError } from "./types";

/**
 * YALNIZ YEREL GELİŞTİRME: nesneler `rootDir` altında dosya olarak tutulur ve
 * /api/medya/<anahtar> üzerinden sunulur (production'da bu sürücü ve route kapalıdır).
 */
export const LOCAL_MEDIA_PREFIX = "/api/medya";

export function resolveInside(rootDir: string, key: string): string {
  if (!isSafeKey(key)) throw new StorageError("get", "Geçersiz depolama anahtarı");
  const root = path.resolve(rootDir);
  const full = path.resolve(root, ...key.split("/"));
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new StorageError("get", "Geçersiz depolama anahtarı");
  }
  return full;
}

export function createFilesystemStorage(rootDir: string): ObjectStorage & {
  read(key: string): Promise<Uint8Array | null>;
} {
  return {
    driver: "filesystem",
    async put(key, data) {
      assertSafeKey(key);
      const file = resolveInside(rootDir, key);
      await mkdir(path.dirname(file), { recursive: true });
      // flag "wx": var olan nesnenin üzerine yazılmaz.
      await writeFile(file, data, { flag: "wx" });
    },
    async delete(key) {
      assertSafeKey(key);
      await rm(resolveInside(rootDir, key), { force: true });
    },
    publicUrl(key) {
      assertSafeKey(key);
      return `${LOCAL_MEDIA_PREFIX}/${key}`;
    },
    async read(key) {
      try {
        return await readFile(resolveInside(rootDir, key));
      } catch {
        return null;
      }
    },
  };
}
