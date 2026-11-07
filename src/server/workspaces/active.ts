import "server-only";

import { sql } from "drizzle-orm";
import { cookies } from "next/headers";

import { getDb } from "@/db/client";
import { withUser } from "@/db/tenant";
import { getEnv } from "@/lib/env";

import { listMyWorkspaces, type WorkspaceSummary } from "./service";

/**
 * Seçili işletme. Çerez yalnız bir TERCİHTİR, yetki vermez: değer her istekte kullanıcının aktif
 * üyelikleri (listMyWorkspaces, RLS altında) içinde aranır; panel sorguları ayrıca withTenant ile
 * üyeliği ve aktif durumu yeniden doğrular. Listede olmayan değer yok sayılır.
 */
const isProduction = () => getEnv().APP_ENV === "production";
const cookieName = () => (isProduction() ? "__Host-kg.isletme" : "kg.isletme");

export type ActiveWorkspace =
  | { kind: "none" }
  /** Üyelikleri var ama hiçbiri aktif değil (askıya alınmış): yeni işletme açtırılmaz. */
  | { kind: "suspended" }
  | { kind: "choose"; workspaces: WorkspaceSummary[] }
  | { kind: "selected"; workspace: WorkspaceSummary };

export async function resolveActiveWorkspace(userId: string): Promise<ActiveWorkspace> {
  const workspaces = await listMyWorkspaces(getDb(), userId);
  if (workspaces.length === 0) {
    return (await countMyMemberships(userId)) > 0 ? { kind: "suspended" } : { kind: "none" };
  }
  const preferred = (await cookies()).get(cookieName())?.value;
  const match = workspaces.find((w) => w.id === preferred);
  if (match) return { kind: "selected", workspace: match };
  if (workspaces.length === 1) return { kind: "selected", workspace: workspaces[0]! };
  return { kind: "choose", workspaces };
}

/** Kullanıcının durumdan bağımsız üyelik sayısı (RLS: bağlamsız yalnız kendi üyelikleri). */
export async function countMyMemberships(userId: string): Promise<number> {
  return withUser(getDb(), userId, async (tx) => {
    const r = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from workspace_members`,
    );
    return r.rows[0]?.n ?? 0;
  });
}

/** Yalnız server action / route handler içinden çağrılır. */
export async function setActiveWorkspaceCookie(workspaceId: string): Promise<void> {
  (await cookies()).set(cookieName(), workspaceId, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    path: "/",
    maxAge: 60 * 60 * 24 * 180,
  });
}
