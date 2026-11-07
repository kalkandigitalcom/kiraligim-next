import "server-only";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { getHostAuth } from "./host-auth";
import { getAuthStatus } from "./status";

/**
 * Sunucu tarafında oturum. Kullanıcı kimliği YALNIZ Better Auth'un doğruladığı oturum
 * çerezinden gelir; tenant bağlamı (withUser / withTenant) bu kimlikle kurulur.
 * Doğrulanmamış e-posta ile oturum açılamaz (requireEmailVerification); yine de burada da
 * kontrol edilir.
 */
export type SessionUser = { id: string; name: string; email: string };

export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  if (!getAuthStatus().available) return null;
  const session = await getHostAuth().api.getSession({ headers: await headers() });
  const user = session?.user;
  if (!user || !user.emailVerified) return null;
  return { id: user.id, name: user.name, email: user.email };
});

/** Oturum yoksa giriş sayfasına yönlendirir. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/giris");
  return user;
}
