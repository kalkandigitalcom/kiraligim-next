"use server";

import { redirect, unstable_rethrow } from "next/navigation";

import { parseDurationMinutes } from "@/lib/option-admin";
import { type ActionResult, ok, toActionError } from "@/lib/result";
import { setOwnerDefaultDuration } from "@/server/options/owner";
import { withPanelTenant } from "@/server/workspaces/panel-tenant";

/**
 * İşletmenin varsayılan opsiyon süresi (Faz A). Yalnız işletme sahibi; rol serviste ve veritabanı
 * fonksiyonunda (app_option_owner_set_default) yeniden denetlenir. Boş bırakmak sistem
 * varsayılanına döner.
 */
async function runAction<T>(name: string, fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return ok(await fn());
  } catch (err) {
    unstable_rethrow(err);
    return toActionError(err, { action: name });
  }
}

export type OptionDefaultFormState = { error?: string; fieldError?: string; value?: string };

export async function setOptionDefaultAction(
  _prev: OptionDefaultFormState,
  formData: FormData,
): Promise<OptionDefaultFormState> {
  const raw = formData.get("defaultDuration");
  const value = typeof raw === "string" ? raw : "";
  const minutes = parseDurationMinutes(value);
  if (minutes !== null && Number.isNaN(minutes)) {
    return { fieldError: "Süre 1 saat ile 14 gün arasında olmalı (ör. 24 veya 2g).", value };
  }
  const result = await runAction("option.default_duration_update", () =>
    withPanelTenant((tx, ctx) => setOwnerDefaultDuration(tx, ctx, minutes)),
  );
  if (!result.ok) {
    return {
      error: result.error.fieldErrors?.defaultDuration ? undefined : result.error.message,
      fieldError: result.error.fieldErrors?.defaultDuration?.[0],
      value,
    };
  }
  redirect(`/opsiyonlar?ayar=${result.data.changed ? "kaydedildi" : "degisiklik-yok"}`);
}
