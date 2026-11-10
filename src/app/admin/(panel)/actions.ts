"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { revokeAdminSession } from "@/server/admin/auth";
import { adminCookieNames, getAdminContext } from "@/server/admin/session";

export async function adminLogoutAction(): Promise<void> {
  const ctx = getAdminContext();
  if (ctx) {
    const name = adminCookieNames(ctx.config.secureCookies).session;
    const jar = await cookies();
    await revokeAdminSession(ctx.db, jar.get(name)?.value);
    jar.delete(name);
  }
  redirect("/giris?durum=cikis");
}
