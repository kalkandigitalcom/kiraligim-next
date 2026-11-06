import "server-only";

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

import { DB_CASING } from "./casing";
import { createPool } from "./pool";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;

type DbGlobal = { __kiraligimPool?: Pool; __kiraligimDb?: Database };
const g = globalThis as unknown as DbGlobal;

/** Uygulama veritabanı bağlantısı (app_user rolü, RLS uygulanır). Geliştirmede HMR'da tek havuz. */
export function getPool(): Pool {
  if (!g.__kiraligimPool) {
    const pool = createPool(getEnv().DATABASE_URL);
    pool.on("error", (err) => logger.error("pg_pool_error", { err }));
    g.__kiraligimPool = pool;
  }
  return g.__kiraligimPool;
}

export function getDb(): Database {
  g.__kiraligimDb ??= drizzle(getPool(), { schema, casing: DB_CASING });
  return g.__kiraligimDb;
}
