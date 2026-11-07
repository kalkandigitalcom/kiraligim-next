import { Pool, type PoolConfig, types } from "pg";

// DATE (OID 1082) saat dilimsiz takvim günüdür: JavaScript Date'e çevrilirse sunucunun saat
// dilimine göre bir gün kayabilir. Bu yüzden "YYYY-MM-DD" metni olarak bırakılır
// (rezervasyon tarihleri; bkz. src/lib/reservation-meta.ts). timestamptz etkilenmez.
types.setTypeParser(types.builtins.DATE, (v) => v);

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
