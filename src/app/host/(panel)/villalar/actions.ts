"use server";

import { redirect, unstable_rethrow } from "next/navigation";

import { type ActionResult, ok, toActionError } from "@/lib/result";
import { type PropertyField, propertyFormValues } from "@/server/properties/schema";
import { createProperty, setPropertyStatus, updateProperty } from "@/server/properties/service";
import { withPanelTenant } from "@/server/workspaces/panel-tenant";

/**
 * Mülk server action'ları. Kullanıcı ve işletme yalnız oturumdan (withPanelTenant → withTenant);
 * formdan yalnız mülk alanları ve hedef mülk kimliği alınır. Hedef kimlik yetki vermez: RLS
 * başka işletmenin mülkünü göstermez, rol ve limit veritabanında yeniden denetlenir.
 */

/**
 * runAction ile aynı, ancak Next.js'in kendi yönlendirme/notFound hatalarını yutmaz
 * (withPanelTenant oturum veya işletme yoksa redirect() çağırır).
 */
async function runAction<T>(name: string, fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return ok(await fn());
  } catch (err) {
    unstable_rethrow(err);
    return toActionError(err, { action: name });
  }
}

export type PropertyFormState = {
  error?: string;
  fieldErrors?: Partial<Record<PropertyField, string>>;
  values?: Record<PropertyField, string>;
  saved?: boolean;
};

const firstErrors = (fe: Record<string, string[]> | undefined) => {
  const out: Partial<Record<PropertyField, string>> = {};
  for (const [k, v] of Object.entries(fe ?? {})) if (v[0]) out[k as PropertyField] = v[0];
  return out;
};

export async function createPropertyAction(
  _prev: PropertyFormState,
  formData: FormData,
): Promise<PropertyFormState> {
  const values = propertyFormValues(formData);
  const result = await runAction("property.create", () =>
    withPanelTenant((tx, ctx) => createProperty(tx, ctx, values)),
  );
  if (!result.ok) {
    return {
      error: result.error.message,
      fieldErrors: firstErrors(result.error.fieldErrors),
      values,
    };
  }
  redirect(`/villalar/${result.data}?durum=olusturuldu`);
}

export async function updatePropertyAction(
  id: string,
  _prev: PropertyFormState,
  formData: FormData,
): Promise<PropertyFormState> {
  const values = propertyFormValues(formData);
  const result = await runAction("property.update", () =>
    withPanelTenant((tx, ctx) => updateProperty(tx, ctx, id, values)),
  );
  if (!result.ok) {
    return {
      error: result.error.message,
      fieldErrors: firstErrors(result.error.fieldErrors),
      values,
    };
  }
  return { saved: true, values };
}

export type StatusFormState = { error?: string };

export async function setPropertyStatusAction(
  id: string,
  _prev: StatusFormState,
  formData: FormData,
): Promise<StatusFormState> {
  const status = formData.get("status");
  const result = await runAction("property.status", () =>
    withPanelTenant((tx, ctx) => setPropertyStatus(tx, ctx, id, status)),
  );
  if (!result.ok) return { error: result.error.message };
  redirect(`/villalar/${id}?durum=${status === "passive" ? "pasif" : "aktif"}`);
}
