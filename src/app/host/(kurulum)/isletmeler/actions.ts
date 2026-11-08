"use server";

import { redirect } from "next/navigation";

import { getDb } from "@/db/client";
import { getSessionUser } from "@/server/auth/session";
import { setActiveWorkspaceCookie } from "@/server/workspaces/active";
import { listMyWorkspaces } from "@/server/workspaces/service";

/**
 * İşletme seçimi. Gönderilen kimlik yalnız kullanıcının KENDİ aktif üyelikleri (RLS altında
 * listMyWorkspaces) içinde varsa tercih olarak kaydedilir; yetki her istekte withTenant'tadır.
 */
export async function selectWorkspaceAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user) redirect("/giris");
  const id = formData.get("workspaceId");
  const mine = await listMyWorkspaces(getDb(), user.id);
  const match = typeof id === "string" ? mine.find((w) => w.id === id) : undefined;
  if (match) await setActiveWorkspaceCookie(match.id);
  redirect(match ? "/panel" : "/isletmeler");
}
