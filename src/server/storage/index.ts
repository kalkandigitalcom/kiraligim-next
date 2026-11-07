import "server-only";

import { logger as rootLogger } from "@/lib/logger";

import { parseStorageConfig, type StorageConfigResult } from "./env";
import { createFilesystemStorage } from "./filesystem";
import { createMemoryStorage } from "./memory";
import { createR2Storage } from "./r2";
import type { ObjectStorage } from "./types";

const log = rootLogger.child({ component: "storage" });

let cachedResult: StorageConfigResult | undefined;
let cachedStorage: ObjectStorage | null | undefined;

/** Yapılandırma durumu (değer içermez; yalnız sürücü ve değişken adları). */
export function getStorageStatus(): StorageConfigResult {
  cachedResult ??= parseStorageConfig(process.env);
  return cachedResult;
}

/** Yapılandırılmamışsa null: çağıran 503 / "yapılandırılmadı" gösterir. */
export function getStorage(): ObjectStorage | null {
  if (cachedStorage !== undefined) return cachedStorage;
  const status = getStorageStatus();
  if (!status.ok) {
    log.warn("storage_not_configured", { driver: status.driver, issues: status.issues });
    cachedStorage = null;
    return null;
  }
  const c = status.config;
  cachedStorage =
    c.driver === "r2"
      ? createR2Storage(c.r2)
      : c.driver === "filesystem"
        ? createFilesystemStorage(c.localDir)
        : createMemoryStorage();
  return cachedStorage;
}

/** Yalnız testler. */
export function setStorageForTests(storage: ObjectStorage | null | undefined): void {
  cachedStorage = storage;
  if (storage === undefined) cachedResult = undefined;
}

export * from "./types";
