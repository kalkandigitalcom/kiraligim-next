"use server";

import { redirect, unstable_rethrow } from "next/navigation";

import { type ActionResult, ok, toActionError } from "@/lib/result";
import { type RateField, rateFormValues } from "@/server/rates/schema";
import { createRate, deleteRate, updateRate } from "@/server/rates/service";
import { withPanelTenant } from "@/server/workspaces/panel-tenant";

/**
 * Fiyat dönemi server action'ları. Kullanıcı ve işletme yalnız oturumdan (withPanelTenant →
 * withTenant); bağlanan mülk/dönem kimliği yetki vermez: RLS başka işletmenin kaydını göstermez,
 * rol hem serviste hem veritabanı politikalarında yeniden denetlenir.
 */
async function runAction<T>(name: string, fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return ok(await fn());
  } catch (err) {
    unstable_rethrow(err);
    return toActionError(err, { action: name });
  }
}

export type RateFormState = {
  error?: string;
  fieldErrors?: Partial<Record<RateField, string>>;
  values?: Record<RateField, string>;
};

const firstErrors = (fe: Record<string, string[]> | undefined) => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fe ?? {})) if (v[0]) out[k] = v[0];
  return out;
};

/** Sonuç sayfası; ?kayit (dönem kimliği) yeni formu sıfırlar ve satırı vurgular. */
const pricesPath = (propertyId: string, durum: string, rateId?: string) =>
  `/villalar/${propertyId}/fiyatlar?durum=${durum}${rateId ? `&kayit=${rateId}` : ""}`;

export async function createRateAction(
  propertyId: string,
  _prev: RateFormState,
  formData: FormData,
): Promise<RateFormState> {
  const values = rateFormValues(formData);
  const result = await runAction("property.rate_create", () =>
    withPanelTenant((tx, ctx) => createRate(tx, ctx, String(propertyId), values)),
  );
  if (!result.ok) {
    return {
      error: result.error.message,
      fieldErrors: firstErrors(result.error.fieldErrors),
      values,
    };
  }
  redirect(pricesPath(String(propertyId), "eklendi", result.data));
}

export async function updateRateAction(
  rateId: string,
  _prev: RateFormState,
  formData: FormData,
): Promise<RateFormState> {
  const values = rateFormValues(formData);
  const result = await runAction("property.rate_update", () =>
    withPanelTenant((tx, ctx) => updateRate(tx, ctx, String(rateId), values)),
  );
  if (!result.ok) {
    return {
      error: result.error.message,
      fieldErrors: firstErrors(result.error.fieldErrors),
      values,
    };
  }
  redirect(
    pricesPath(
      result.data.propertyId,
      result.data.changed > 0 ? "guncellendi" : "degisiklik-yok",
      String(rateId),
    ),
  );
}

export type DeleteRateState = { error?: string };

export async function deleteRateAction(rateId: string): Promise<DeleteRateState> {
  const result = await runAction("property.rate_delete", () =>
    withPanelTenant((tx, ctx) => deleteRate(tx, ctx, String(rateId))),
  );
  if (!result.ok) return { error: result.error.message };
  redirect(pricesPath(result.data.propertyId, "silindi"));
}
