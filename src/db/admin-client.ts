import "server-only";

import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import { logger } from "@/lib/logger";

import { DB_CASING } from "./casing";
import type { Database } from "./client";
import { createPool } from "./pool";
import * as schema from "./schema";

/**
 * Super Admin veritabanı bağlantısı (app_admin rolü, DATABASE_ADMIN_URL). Yalnız admin yüzeyi
 * kullanır; işletme paneli (app_user) bu havuzu kullanmaz. Geliştirmede HMR'da tek havuz.
 */
type AdminDbGlobal = { __kiraligimAdminPool?: Pool; __kiraligimAdminDb?: Database; __url?: string };
const g = globalThis as unknown as AdminDbGlobal;

export function getAdminDb(url: string): Database {
  if (!g.__kiraligimAdminDb || g.__url !== url) {
    const pool = createPool(url, { max: 3, application_name: "kiraligim-admin" });
    pool.on("error", (err) => logger.error("pg_admin_pool_error", { err }));
    g.__kiraligimAdminPool = pool;
    g.__kiraligimAdminDb = drizzle(pool, { schema, casing: DB_CASING });
    g.__url = url;
  }
  return g.__kiraligimAdminDb;
}
