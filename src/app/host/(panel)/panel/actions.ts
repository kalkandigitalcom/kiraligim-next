"use server";

import { redirect, unstable_rethrow } from "next/navigation";

import { type ActionResult, ok, toActionError } from "@/lib/result";
import { updateWorkspaceWhatsapp } from "@/server/workspaces/contact";
import { withPanelTenant } from "@/server/workspaces/panel-tenant";

/** İşletme WhatsApp numarası (yalnız owner; rol serviste ve veritabanı politikasında denetlenir). */
async function runAction<T>(name: string, fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return ok(await fn());
  } catch (err) {
    unstable_rethrow(err);
    return toActionError(err, { action: name });
  }
}

export type WhatsappFormState = { error?: string; fieldError?: string; value?: string };

export async function updateWhatsappAction(
  _prev: WhatsappFormState,
  formData: FormData,
): Promise<WhatsappFormState> {
  const raw = formData.get("whatsapp");
  const value = typeof raw === "string" ? raw : "";
  const result = await runAction("workspace.contact_update", () =>
    withPanelTenant((tx, ctx) => updateWorkspaceWhatsapp(tx, ctx, value)),
  );
  if (!result.ok) {
    return {
      error: result.error.fieldErrors?.whatsapp ? undefined : result.error.message,
      fieldError: result.error.fieldErrors?.whatsapp?.[0],
      value,
    };
  }
  redirect(`/panel?iletisim=${result.data.changed ? "kaydedildi" : "degisiklik-yok"}#iletisim`);
}
