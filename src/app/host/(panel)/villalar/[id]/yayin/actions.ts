"use server";

import { redirect, unstable_rethrow } from "next/navigation";

import { type ActionResult, ok, toActionError } from "@/lib/result";
import {
  publishProperty,
  unpublishProperty,
  updatePublicProfile,
} from "@/server/properties/public-profile";
import {
  type PublicProfileFormRaw,
  publicProfileFormValues,
} from "@/server/properties/public-profile-schema";
import { withPanelTenant } from "@/server/workspaces/panel-tenant";

/**
 * Villa sayfası (Yayın sekmesi) server action'ları. Kullanıcı ve işletme yalnız oturumdan
 * (withPanelTenant → withTenant); bağlanan mülk kimliği yetki vermez: RLS başka işletmenin
 * mülkünü göstermez, rol hem serviste hem veritabanı politikasında yeniden denetlenir.
 */
async function runAction<T>(name: string, fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return ok(await fn());
  } catch (err) {
    unstable_rethrow(err);
    return toActionError(err, { action: name });
  }
}

export type PublicProfileFormState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  values?: PublicProfileFormRaw;
};

const firstErrors = (fe: Record<string, string[]> | undefined) => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fe ?? {})) if (v[0]) out[k] = v[0];
  return out;
};

const publishPath = (id: string, durum: string) => `/villalar/${id}/yayin?durum=${durum}`;

export async function updatePublicProfileAction(
  propertyId: string,
  _prev: PublicProfileFormState,
  formData: FormData,
): Promise<PublicProfileFormState> {
  const values = publicProfileFormValues(formData);
  const id = String(propertyId);
  const result = await runAction("property.public_profile_update", () =>
    withPanelTenant((tx, ctx) => updatePublicProfile(tx, ctx, id, values)),
  );
  if (!result.ok) {
    return {
      error: result.error.message,
      fieldErrors: firstErrors(result.error.fieldErrors),
      values,
    };
  }
  redirect(publishPath(id, result.data.changed > 0 ? "kaydedildi" : "degisiklik-yok"));
}

export type PublishState = { error?: string };

export async function publishAction(propertyId: string): Promise<PublishState> {
  const id = String(propertyId);
  const result = await runAction("property.publish", () =>
    withPanelTenant((tx, ctx) => publishProperty(tx, ctx, id)),
  );
  if (!result.ok) return { error: result.error.message };
  redirect(publishPath(id, "yayinlandi"));
}

export async function unpublishAction(propertyId: string): Promise<PublishState> {
  const id = String(propertyId);
  const result = await runAction("property.unpublish", () =>
    withPanelTenant((tx, ctx) => unpublishProperty(tx, ctx, id)),
  );
  if (!result.ok) return { error: result.error.message };
  redirect(publishPath(id, "kaldirildi"));
}
