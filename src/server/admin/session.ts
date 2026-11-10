import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import type { Database } from "@/db/client";
import { getAdminDb } from "@/db/admin-client";
import { getEnv } from "@/lib/env";

import { type AdminIdentity, getAdminSession } from "./auth";
import { type AdminConfig, readAdminConfig } from "./env";

/**
 * Super Admin oturum çerezi: yalnız admin alan adına (host-only, production'da __Host- öneki,
 * Secure, HttpOnly, SameSite=Strict). İşletme panelinin çereziyle hiçbir bağı yoktur.
 */
export const adminCookieNames = (secure: boolean) => ({
  session: secure ? "__Host-kg_admin" : "kg_admin",
  step: secure ? "__Host-kg_admin_step" : "kg_admin_step",
});

export type AdminContext = { config: AdminConfig; db: Database };

/** Yapılandırma yoksa null (panel "yapılandırılmamış" gösterir). */
export function getAdminContext(): AdminContext | null {
  const env = getEnv();
  const r = readAdminConfig(process.env, env.APP_ENV, env.ADMIN_URL);
  if (!r.ok) return null;
  return { config: r.config, db: getAdminDb(r.config.dbUrl) };
}

export function adminConfigProblem(): string | null {
  const env = getEnv();
  const r = readAdminConfig(process.env, env.APP_ENV, env.ADMIN_URL);
  return r.ok ? null : r.reason;
}

export async function getCurrentAdmin(): Promise<AdminIdentity | null> {
  const ctx = getAdminContext();
  if (!ctx) return null;
  const jar = await cookies();
  return getAdminSession(
    ctx.db,
    jar.get(adminCookieNames(ctx.config.secureCookies).session)?.value,
  );
}

/** Sayfa ve işlemlerde: geçerli yönetici oturumu yoksa giriş sayfasına. */
export async function requireAdmin(): Promise<AdminIdentity & { ctx: AdminContext }> {
  const ctx = getAdminContext();
  if (!ctx) redirect("/giris");
  const jar = await cookies();
  const admin = await getAdminSession(
    ctx.db,
    jar.get(adminCookieNames(ctx.config.secureCookies).session)?.value,
  );
  if (!admin) redirect("/giris");
  return { ...admin, ctx };
}
