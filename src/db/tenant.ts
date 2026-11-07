import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { AppError, notFound } from "@/lib/errors";

/**
 * Tenant bağlamı. Her tenant sorgusu bir transaction içinde çalışır; `app.user_id` ve
 * `app.workspace_id` yalnız o transaction için ayarlanır (set_config(..., true)) ve transaction
 * sonunda otomatik silinir, havuzdaki bağlantıya sızmaz. Değerler parametre olarak bağlanır.
 * RLS politikaları bunları app_current_user_id() / app_current_workspace_id() ile okur ve
 * üyeliği app_current_member_role() ile ayrıca doğrular (drizzle/0006_tenancy_security.sql).
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

export type MemberRole = "owner" | "manager" | "staff";

export type TenantContext = { userId: string; workspaceId: string; role: MemberRole };

async function setUserContext(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
}

async function setWorkspaceContext(tx: Tx, workspaceId: string): Promise<void> {
  await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
}

/**
 * Yalnız kullanıcı bağlamı (app.user_id): workspace seçimi öncesi işlemler — kendi
 * üyeliklerini listelemek, yeni workspace oluşturmak. RLS bu bağlamda kullanıcıya yalnız
 * kendi üyeliklerini ve üye olduğu workspace'leri gösterir.
 */
export async function withUser<T>(
  db: AnyDb,
  userId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  assertUuid(userId, "userId");
  return db.transaction(async (tx) => {
    await setUserContext(tx, userId);
    return fn(tx);
  });
}

/**
 * Tenant bağlamı. Tek transaction içinde:
 *   1. app.user_id ayarlanır;
 *   2. kullanıcının bu workspace'e üyeliği ve workspace'in aktif olduğu doğrulanır
 *      (RLS bu aşamada yalnız kullanıcının kendi üyeliklerini gösterir);
 *   3. ancak ondan sonra app.workspace_id ayarlanır.
 * Üye değilse, workspace yoksa veya askıdaysa aynı NOT_FOUND hatası döner (varlık sızmaz).
 * RLS ayrıca her sorguda üyeliği yeniden denetler (app_current_member_role()).
 */
export async function withTenant<T>(
  db: AnyDb,
  context: { userId: string; workspaceId: string },
  fn: (tx: Tx, ctx: TenantContext) => Promise<T>,
): Promise<T> {
  const { userId, workspaceId } = context;
  assertUuid(userId, "userId");
  assertUuid(workspaceId, "workspaceId");
  return db.transaction(async (tx) => {
    await setUserContext(tx, userId);
    const res = await tx.execute<{ role: MemberRole; status: string }>(sql`
      select m.role, w.status
        from workspace_members m
        join workspaces w on w.id = m.workspace_id
       where m.workspace_id = ${workspaceId} and m.user_id = ${userId}`);
    const row = res.rows[0];
    if (!row || row.status !== "active") throw notFound("İşletme bulunamadı.");
    await setWorkspaceContext(tx, workspaceId);
    return fn(tx, { userId, workspaceId, role: row.role });
  });
}

/**
 * YALNIZ TESTLER VE ALTYAPI İÇİN: üyelik doğrulaması yapmadan app.workspace_id ayarlar.
 * RLS ilkel davranışını sınamak için vardır; uygulama kodunda withTenant kullanılır.
 */
export async function withTenantContextUnchecked<T>(
  db: AnyDb,
  workspaceId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  assertUuid(workspaceId, "workspaceId");
  return db.transaction(async (tx) => {
    await setWorkspaceContext(tx, workspaceId);
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
