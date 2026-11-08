"use server";

import { redirect, unstable_rethrow } from "next/navigation";

import { type ActionResult, ok, toActionError } from "@/lib/result";
import {
  EMPTY_PROPERTY_VALUES,
  isWizardStep,
  nextStep,
  stepHref,
  wizardFormValues,
} from "@/lib/property-wizard";
import { sanitizeDescription } from "@/server/properties/description";
import { saveWizardStep } from "@/server/properties/property-fields";
import type { StayDetailsFormRaw } from "@/server/properties/public-profile-schema";
import type { PropertyFormRaw } from "@/server/properties/schema";
import { createProperty, setPropertyStatus } from "@/server/properties/service";
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

/** Sihirbaz formlarının ortak değer kümesi: mülk alanları + olanak/konaklama alanları. */
export type WizardValues = PropertyFormRaw & StayDetailsFormRaw;

export type WizardFormState = {
  error?: string;
  /** Alan adı → ilk hata. Liste alanlarında sıra eklenir: "youtubeUrls.2". */
  fieldErrors?: Record<string, string>;
  /** Hata durumunda kullanıcının bu adımda girdiği değerler (kaybolmasın diye geri gönderilir). */
  values?: Partial<WizardValues>;
};

const firstErrors = (fe: Record<string, string[]> | undefined) => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fe ?? {})) if (v[0]) out[k] = v[0];
  return out;
};

/**
 * Forma geri gönderilen değerler. Açıklama HTML'i istemciye dönmeden önce temizlenir: düzenleyici
 * bu değeri yeniden gösterir; temizlenmemiş HTML hiçbir zaman sayfaya yazılmaz.
 */
function echoValues(values: Partial<WizardValues>): Partial<WizardValues> {
  if (typeof values.description !== "string") return values;
  return { ...values, description: sanitizeDescription(values.description)?.html ?? "" };
}

/** Yeni mülk (sihirbazın 1. adımı). Diğer adımların alanları başlangıç değerleriyle oluşur. */
export async function createPropertyAction(
  _prev: WizardFormState,
  formData: FormData,
): Promise<WizardFormState> {
  const values = wizardFormValues("temel", formData) as Partial<WizardValues>;
  const result = await runAction("property.create", () =>
    withPanelTenant((tx, ctx) => createProperty(tx, ctx, { ...EMPTY_PROPERTY_VALUES, ...values })),
  );
  if (!result.ok) {
    return {
      error: result.error.message,
      fieldErrors: firstErrors(result.error.fieldErrors),
      values: echoValues(values),
    };
  }
  redirect(`${stepHref(result.data, "aciklama")}&durum=olusturuldu`);
}

/**
 * Sihirbaz adımı kaydı (owner/manager): yalnız adımın alanları okunur ve `saveWizardStep` ile
 * kaydedilir (tek işlem; yetki, doğrulama ve denetim kaydı serviste). Başarıda sonraki adıma
 * geçilir; hata olursa kullanıcının girdiği değerler forma geri döner.
 */
export async function saveWizardStepAction(
  id: string,
  step: string,
  _prev: WizardFormState,
  formData: FormData,
): Promise<WizardFormState> {
  if (!isWizardStep(step) || step === "kontrol") return { error: "Geçersiz adım." };
  const values = wizardFormValues(step, formData) as Partial<WizardValues>;
  const propertyId = String(id);
  const result = await runAction(`property.wizard_${step}`, () =>
    withPanelTenant((tx, ctx) => saveWizardStep(tx, ctx, propertyId, step, values)),
  );
  if (!result.ok) {
    return {
      error: result.error.message,
      fieldErrors: firstErrors(result.error.fieldErrors),
      values: echoValues(values),
    };
  }
  const next = nextStep(step) ?? "kontrol";
  redirect(
    `${stepHref(propertyId, next)}&durum=${result.data.changed > 0 ? "kaydedildi" : "degisiklik-yok"}`,
  );
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
  redirect(`${stepHref(id, "kontrol")}&durum=${status === "passive" ? "pasif" : "aktif"}`);
}
