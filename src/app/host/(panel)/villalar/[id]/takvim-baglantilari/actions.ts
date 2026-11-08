"use server";

import { redirect, unstable_rethrow } from "next/navigation";

import { getDb } from "@/db/client";
import { forbidden, notFound } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { type ActionResult, ok, toActionError } from "@/lib/result";
import {
  addSource,
  canManageIcal,
  deleteSource,
  getSource,
  rotateExport,
  setSourceActive,
  updateSource,
} from "@/server/ical/service";
import { claimSource, type ClaimOutcome, type SyncResult, syncClaimed } from "@/server/ical/sync";
import { withPanelTenant } from "@/server/workspaces/panel-tenant";

/**
 * Harici takvimler (iCal) server action'ları. Kullanıcı ve işletme yalnız oturumdan
 * (withPanelTenant → withTenant); bağlanan mülk/kaynak kimliği yetki vermez: RLS başka işletmenin
 * kaydını göstermez, rol hem serviste hem veritabanı politikalarında yeniden denetlenir.
 * Kaynak adresi log'a yazılmaz.
 */
async function runAction<T>(name: string, fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return ok(await fn());
  } catch (err) {
    unstable_rethrow(err);
    return toActionError(err, { action: name });
  }
}

const pagePath = (propertyId: string, durum: string) =>
  `/villalar/${propertyId}/takvim-baglantilari?durum=${durum}`;

export type SourceField = "name" | "url" | "isActive";
export type SourceFormState = {
  error?: string;
  fieldErrors?: Partial<Record<SourceField, string>>;
  values?: { name: string; url: string; isActive: boolean };
};

const formValues = (data: FormData) => ({
  name: String(data.get("name") ?? ""),
  url: String(data.get("url") ?? ""),
  isActive: data.get("isActive") === "on",
});

const firstErrors = (fe: Record<string, string[]> | undefined) => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fe ?? {})) if (v[0]) out[k] = v[0];
  return out;
};

/**
 * Tek kaynağı hemen senkron eder: kilit (RLS ile doğrulanmış kaynak) → indir/ayrıştır (transaction
 * dışında) → uygula. Dönüş, sayfadaki bildirim koduna çevrilir.
 */
async function syncNow(
  sourceId: string,
): Promise<{ propertyId: string; outcome: ClaimOutcome | SyncResult["outcome"] }> {
  const claimed = await withPanelTenant(async (tx, ctx) => {
    if (!canManageIcal(ctx.role)) throw forbidden();
    const src = await getSource(tx, ctx, sourceId);
    if (!src) throw notFound("Takvim kaynağı bulunamadı.");
    return { propertyId: src.propertyId, ...(await claimSource(tx, sourceId)) };
  });
  if (claimed.outcome !== "claimed" || !claimed.claim) {
    return { propertyId: claimed.propertyId, outcome: claimed.outcome };
  }
  const result = await syncClaimed(getDb(), claimed.claim, "manual", { log: logger });
  return { propertyId: claimed.propertyId, outcome: result.outcome };
}

const SYNC_NOTICE: Record<string, string> = {
  ok: "senkron-tamam",
  error: "senkron-hata",
  lock_lost: "senkron-suruyor",
  locked: "senkron-suruyor",
  too_soon: "senkron-bekle",
  inactive: "senkron-pasif",
  not_found: "senkron-hata",
};

export async function addSourceAction(
  propertyId: string,
  _prev: SourceFormState,
  formData: FormData,
): Promise<SourceFormState> {
  const values = formValues(formData);
  const id = String(propertyId);
  const result = await runAction("ical.source_add", () =>
    withPanelTenant((tx, ctx) => addSource(tx, ctx, id, values)),
  );
  if (!result.ok) {
    return {
      error: result.error.message,
      fieldErrors: firstErrors(result.error.fieldErrors),
      values,
    };
  }
  // İlk senkron hemen denenir; başarısız olsa da kaynak eklenmiştir (durum listede görünür).
  let durum = "eklendi";
  if (values.isActive) {
    const synced = await runAction("ical.source_sync", () => syncNow(result.data));
    durum = synced.ok && synced.data.outcome === "ok" ? "eklendi-senkron" : "eklendi-hata";
  }
  redirect(pagePath(id, durum));
}

export async function updateSourceAction(
  sourceId: string,
  propertyId: string,
  _prev: SourceFormState,
  formData: FormData,
): Promise<SourceFormState> {
  const values = formValues(formData);
  const result = await runAction("ical.source_update", () =>
    withPanelTenant((tx, ctx) => updateSource(tx, ctx, String(sourceId), values)),
  );
  if (!result.ok) {
    return {
      error: result.error.message,
      fieldErrors: firstErrors(result.error.fieldErrors),
      values,
    };
  }
  redirect(
    pagePath(String(propertyId), result.data.changed > 0 ? "guncellendi" : "degisiklik-yok"),
  );
}

export type SimpleState = { error?: string };

export async function toggleSourceAction(
  sourceId: string,
  propertyId: string,
  active: boolean,
): Promise<SimpleState> {
  const result = await runAction("ical.source_toggle", () =>
    withPanelTenant((tx, ctx) => setSourceActive(tx, ctx, String(sourceId), active === true)),
  );
  if (!result.ok) return { error: result.error.message };
  redirect(pagePath(String(propertyId), active ? "etkinlestirildi" : "pasiflestirildi"));
}

export async function deleteSourceAction(
  sourceId: string,
  propertyId: string,
): Promise<SimpleState> {
  const result = await runAction("ical.source_delete", () =>
    withPanelTenant((tx, ctx) => deleteSource(tx, ctx, String(sourceId))),
  );
  if (!result.ok) return { error: result.error.message };
  redirect(pagePath(String(propertyId), "silindi"));
}

export async function syncSourceAction(sourceId: string, propertyId: string): Promise<SimpleState> {
  const result = await runAction("ical.source_sync", () => syncNow(String(sourceId)));
  if (!result.ok) return { error: result.error.message };
  redirect(pagePath(String(propertyId), SYNC_NOTICE[result.data.outcome] ?? "senkron-hata"));
}

export async function rotateExportAction(propertyId: string): Promise<SimpleState> {
  const id = String(propertyId);
  const result = await runAction("ical.export_rotate", () =>
    withPanelTenant((tx, ctx) => rotateExport(tx, ctx, id)),
  );
  if (!result.ok) return { error: result.error.message };
  redirect(pagePath(id, "baglanti-yenilendi"));
}
