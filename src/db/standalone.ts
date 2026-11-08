import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolConfig } from "pg";

import { DB_CASING } from "./casing";
import type { Database } from "./client";
import { createPool } from "./pool";
import * as schema from "./schema";

/**
 * Next.js dışında çalışan komutlar (ör. dist/ical-sync.js) için veritabanı: uygulamayla aynı
 * havuz ayarları, şema ve adlandırma. "server-only" içermez. Bağlantı adresini çağıran verir
 * (DATABASE_URL, app_user — RLS uygulanır); iş bitince end() çağrılmalıdır.
 */
export function createStandaloneDb(
  connectionString: string,
  overrides: PoolConfig = {},
): { db: Database; end: () => Promise<void> } {
  const pool = createPool(connectionString, overrides);
  return { db: drizzle(pool, { schema, casing: DB_CASING }), end: () => pool.end() };
}
