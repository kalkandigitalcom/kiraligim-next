import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { DB_CASING } from "@/db/casing";
import * as schema from "@/db/schema";
import { createMemoryTransport } from "@/lib/email/transports";
import { parseAuthEnv } from "@/server/auth/env";
import type { HostAuthDeps } from "@/server/auth/host-auth";

/**
 * Bağlanmayan bir havuz: yapılandırma ve SQL üretimi testleri veritabanına gitmez.
 * Yanlışlıkla sorgu atılırsa 1 numaralı porta bağlanmaya çalışıp hemen hata verir.
 */
export function offlineDb() {
  const pool = new Pool({ connectionString: "postgres://x:x@127.0.0.1:1/offline_test", max: 1 });
  return drizzle(pool, { schema, casing: DB_CASING });
}

export function testAuthDeps(overrides: Partial<HostAuthDeps> = {}): HostAuthDeps {
  return {
    env: { APP_ENV: "test", APP_URL: "http://app.localhost:3000" },
    authEnv: parseAuthEnv("test", { BETTER_AUTH_SECRET: "t".repeat(40) }),
    db: offlineDb(),
    email: createMemoryTransport(),
    brandName: "Kiralığım",
    rateLimitEnabled: false,
    ...overrides,
  };
}
