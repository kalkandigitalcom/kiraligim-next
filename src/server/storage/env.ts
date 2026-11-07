import { z } from "zod";

import { APP_ENVS, type AppEnv } from "@/lib/env";

import type { StorageDriver } from "./types";

/**
 * Depolama ortam değişkenleri. İlk kullanımda okunur (build sırasında sır gerekmez); eksikse
 * uygulama açılır ama fotoğraf yükleme "yapılandırılmadı" (503) döner — sahte başarı yok.
 * Hata mesajlarında değerler değil yalnız değişken adları ve kurallar yer alır.
 *
 * Varsayılan sürücü: production/development → r2, local → filesystem, test → memory.
 * production ve development YALNIZ r2 kullanabilir (konteyner diski kalıcı değildir).
 * Emniyet kemeri: production bucket'ı "-prod", diğer ortamlar "-dev" ile biter
 * (kiraligim-media-prod / kiraligim-media-dev); yanlış ortama yazma engellenir.
 */
export type StorageConfig =
  | {
      driver: "r2";
      r2: {
        accountId: string;
        accessKeyId: string;
        secretAccessKey: string;
        bucket: string;
        publicBaseUrl: string;
      };
    }
  | { driver: "filesystem"; localDir: string }
  | { driver: "memory" };

export type StorageConfigResult =
  | { ok: true; config: StorageConfig }
  | { ok: false; driver: StorageDriver | null; issues: string[] };

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const baseSchema = z.object({
  APP_ENV: z.enum(APP_ENVS),
  STORAGE_DRIVER: z.preprocess(emptyToUndefined, z.enum(["r2", "filesystem", "memory"]).optional()),
  STORAGE_LOCAL_DIR: z.preprocess(emptyToUndefined, z.string().max(512).optional()),
});

const required = { error: "tanımlı değil" } as const;

const r2Schema = z.object({
  R2_ACCOUNT_ID: z
    .string(required)
    .regex(/^[0-9a-f]{32}$/, "32 karakterlik hesap kimliği (hex) olmalı"),
  R2_ACCESS_KEY_ID: z
    .string(required)
    .regex(/^[A-Za-z0-9]{16,128}$/, "geçerli bir erişim anahtarı değil"),
  R2_SECRET_ACCESS_KEY: z
    .string(required)
    .regex(/^[A-Za-z0-9+/=_-]{32,256}$/, "geçerli bir gizli anahtar değil"),
  R2_BUCKET: z
    .string(required)
    .regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, "geçerli bir bucket adı değil (küçük harf, -)"),
  R2_PUBLIC_BASE_URL: z
    .url({ protocol: /^https$/, abort: true, error: "https adresi olmalı" })
    .refine((v) => {
      try {
        const u = new URL(v);
        return (u.pathname === "/" || u.pathname === "") && !u.search && !u.hash && !u.username;
      } catch {
        return false;
      }
    }, "yalnız kök adres olmalı (https://img.ornek.com; yol, sorgu veya kullanıcı yok)"),
});

export const defaultDriver = (appEnv: AppEnv): StorageDriver =>
  appEnv === "test" ? "memory" : appEnv === "local" ? "filesystem" : "r2";

const expectedBucketSuffix = (appEnv: AppEnv) => (appEnv === "production" ? "-prod" : "-dev");

export function parseStorageConfig(
  source: Record<string, string | undefined>,
): StorageConfigResult {
  const base = baseSchema.safeParse(source);
  if (!base.success) {
    return {
      ok: false,
      driver: null,
      issues: base.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }
  const { APP_ENV, STORAGE_DRIVER, STORAGE_LOCAL_DIR } = base.data;
  const driver = STORAGE_DRIVER ?? defaultDriver(APP_ENV);

  if ((APP_ENV === "production" || APP_ENV === "development") && driver !== "r2") {
    return {
      ok: false,
      driver,
      issues: [`STORAGE_DRIVER: APP_ENV=${APP_ENV} iken yalnız r2 kullanılabilir`],
    };
  }
  if (driver === "memory") {
    if (APP_ENV !== "test") {
      return { ok: false, driver, issues: ["STORAGE_DRIVER: memory yalnız testlerde kullanılır"] };
    }
    return { ok: true, config: { driver: "memory" } };
  }
  if (driver === "filesystem") {
    return {
      ok: true,
      config: { driver: "filesystem", localDir: STORAGE_LOCAL_DIR ?? ".storage" },
    };
  }

  const r2 = r2Schema.safeParse(
    Object.fromEntries(
      Object.entries(source).map(([k, v]) => [
        k,
        typeof v === "string" && v.trim() !== "" ? v.trim() : undefined,
      ]),
    ),
  );
  if (!r2.success) {
    return {
      ok: false,
      driver,
      issues: r2.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }
  const suffix = expectedBucketSuffix(APP_ENV);
  if (!r2.data.R2_BUCKET.endsWith(suffix)) {
    return {
      ok: false,
      driver,
      issues: [`R2_BUCKET: APP_ENV=${APP_ENV} iken bucket adı "${suffix}" ile bitmeli`],
    };
  }
  return {
    ok: true,
    config: {
      driver: "r2",
      r2: {
        accountId: r2.data.R2_ACCOUNT_ID,
        accessKeyId: r2.data.R2_ACCESS_KEY_ID,
        secretAccessKey: r2.data.R2_SECRET_ACCESS_KEY,
        bucket: r2.data.R2_BUCKET,
        publicBaseUrl: new URL(r2.data.R2_PUBLIC_BASE_URL).origin,
      },
    },
  };
}

/**
 * CSP img-src için medya kökeni. Proxy her istekte çağırır: hata fırlatmaz, sır okumaz,
 * yalnız geçerli bir https kökeni döndürür (aksi halde null → CSP değişmez).
 */
export function mediaOriginForCsp(source: Record<string, string | undefined>): string | null {
  const raw = source.R2_PUBLIC_BASE_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    return u.origin;
  } catch {
    return null;
  }
}
