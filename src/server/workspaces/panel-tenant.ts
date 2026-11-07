import "server-only";

import { redirect } from "next/navigation";

import { getDb } from "@/db/client";
import { type TenantContext, type Tx, withTenant } from "@/db/tenant";
import { isAppError } from "@/lib/errors";
import { requireUser, type SessionUser } from "@/server/auth/session";

import { resolveActiveWorkspace } from "./active";
import type { WorkspaceSummary } from "./service";

export type PanelInfo = { user: SessionUser; workspace: WorkspaceSummary };

/**
 * Panel sayfaları ve server action'lar için tenant bağlamı. Kullanıcı kimliği yalnız doğrulanmış
 * oturumdan, işletme ise kullanıcının aktif üyelikleri arasından seçilir; withTenant üyeliği ve
 * aktif durumu veritabanında yeniden doğrular. İstemciden gelen işletme kimliği kullanılmaz.
 *
 * Oturum yoksa /giris'e, işletme yoksa sihirbaza, seçim gerekiyorsa /isletmeler'e yönlendirir.
 * withTenant üyeliği reddederse (araya giren askı / çıkarılma) ana sayfaya yönlendirir.
 */
export async function withPanelTenant<T>(
  fn: (tx: Tx, ctx: TenantContext, info: PanelInfo) => Promise<T>,
): Promise<T> {
  const user = await requireUser();
  const active = await resolveActiveWorkspace(user.id);
  if (active.kind === "none") redirect("/isletme-olustur");
  if (active.kind !== "selected") redirect("/isletmeler");
  const workspace = active.workspace;
  let denied = false;
  let result: T | undefined;
  try {
    result = await withTenant(getDb(), { userId: user.id, workspaceId: workspace.id }, (tx, ctx) =>
      fn(tx, ctx, { user, workspace }),
    );
  } catch (err) {
    // Yalnız withTenant'ın üyelik reddi; fn içindeki hatalar olduğu gibi yükselir.
    if (isAppError(err) && err.code === "NOT_FOUND" && err.message === "İşletme bulunamadı.") {
      denied = true;
    } else {
      throw err;
    }
  }
  if (denied) redirect("/");
  return result as T;
}
