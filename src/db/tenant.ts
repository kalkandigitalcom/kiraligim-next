import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { AppError } from "@/lib/errors";

/**
 * Tenant bağlamı. Her tenant sorgusu bir transaction içinde çalışır ve
 * `app.workspace_id` yalnız o transaction için ayarlanır (set_config(..., true)).
 * RLS politikaları bu değeri `current_setting('app.workspace_id', true)::uuid` ile okur.
 * Ayar transaction sonunda otomatik silinir; havuzdaki bağlantıya sızmaz.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = NodePgDatabase<any>;
export type Tx = Parameters<Parameters<AnyDb["transaction"]>[0]>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new AppError("INTERNAL", `${label} geçerli bir UUID değil`, { expose: false });
  }
}

export async function withTenant<T>(
  db: AnyDb,
  workspaceId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  assertUuid(workspaceId, "workspaceId");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
    return fn(tx);
  });
}

/**
 * Super Admin işlemleri. Faz 2'de ayrı `app_admin` rolüyle (DATABASE_ADMIN_URL) kullanılacak;
 * her çağrı denetim kaydı için yöneticinin kimliğini transaction'a yazar.
 */
export async function withPlatformAdmin<T>(
  db: AnyDb,
  adminId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  assertUuid(adminId, "adminId");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.platform_admin_id', ${adminId}, true)`);
    return fn(tx);
  });
}
