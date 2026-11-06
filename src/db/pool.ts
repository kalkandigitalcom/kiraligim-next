import { Pool, type PoolConfig } from "pg";

/** Ortak pg havuzu ayarları; uygulama, migration ve testler aynı varsayılanları kullanır. */
export function createPool(connectionString: string, overrides: PoolConfig = {}): Pool {
  return new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Takılan sorguları sınırla; uzun işler worker'da çalışacak.
    statement_timeout: 15_000,
    idle_in_transaction_session_timeout: 30_000,
    application_name: "kiraligim-web",
    ...overrides,
  });
}
