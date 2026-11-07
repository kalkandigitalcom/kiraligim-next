"use server";

import { redirect } from "next/navigation";

import { getDb } from "@/db/client";
import { GENERIC_ERROR_MESSAGE, isAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/server/auth/session";
import { countMyMemberships, setActiveWorkspaceCookie } from "@/server/workspaces/active";
import { createWorkspace } from "@/server/workspaces/service";

export type CreateWorkspaceState = {
  error?: string;
  fieldErrors?: { name?: string; slug?: string };
  values?: { name: string; slug: string };
};

const text = (data: FormData, key: string) => {
  const v = data.get(key);
  return typeof v === "string" ? v : "";
};

/**
 * İlk işletmeyi oluşturur. Kullanıcı kimliği YALNIZ doğrulanmış oturumdan alınır; formdan
 * kullanıcı veya workspace kimliği kabul edilmez. createWorkspace (withUser) workspace + owner
 * üyeliği + denetim kaydını tek transaction'da yazar.
 */
export async function createWorkspaceAction(
  _prev: CreateWorkspaceState,
  formData: FormData,
): Promise<CreateWorkspaceState> {
  const user = await getSessionUser();
  if (!user) redirect("/giris");

  const values = { name: text(formData, "name"), slug: text(formData, "slug") };

  // Bu sihirbaz yalnız ilk işletme içindir (çift gönderim, geri tuşu, askıdaki işletme).
  if ((await countMyMemberships(user.id)) > 0) redirect("/");

  let workspaceId: string;
  try {
    const ws = await createWorkspace(getDb(), { userId: user.id, ...values });
    workspaceId = ws.id;
  } catch (err) {
    if (isAppError(err) && err.code === "VALIDATION") {
      const fe = err.fieldErrors ?? {};
      const fieldErrors: NonNullable<CreateWorkspaceState["fieldErrors"]> = {};
      if (fe.name?.[0]) fieldErrors.name = fe.name[0];
      if (fe.slug?.[0]) fieldErrors.slug = fe.slug[0];
      return { error: "Lütfen işaretli alanları düzeltin.", fieldErrors, values };
    }
    if (isAppError(err) && err.code === "CONFLICT") {
      return { fieldErrors: { slug: err.message }, values };
    }
    logger.error("workspace_create_failed", { err });
    return { error: GENERIC_ERROR_MESSAGE, values };
  }

  await setActiveWorkspaceCookie(workspaceId);
  redirect("/panel");
}
