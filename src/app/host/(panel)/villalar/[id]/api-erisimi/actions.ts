"use server";

import { redirect, unstable_rethrow } from "next/navigation";

import { forbidden } from "@/lib/errors";
import { toActionError } from "@/lib/result";
import {
  canManageApiAccess,
  grantPropertyAccess,
  lookupAccessCode,
  revokePropertyAccess,
} from "@/server/api/grants";
import { createMemoryRateLimit } from "@/server/public/memory-rate-limit";
import { withPanelTenant } from "@/server/workspaces/panel-tenant";

/**
 * Villa sayfası "API erişimi" server action'ları. Kullanıcı ve işletme yalnız oturumdan
 * (withPanelTenant → withTenant); villa ve izin kimlikleri yetki vermez — veritabanı fonksiyonları
 * villanın bu işletmeye ait olduğunu ve rolü (owner/manager) yeniden denetler. Erişim kodu URL'ye
 * ve log'a yazılmaz.
 */

export type CodeState = {
  step?: "confirm";
  clientId?: string;
  clientName?: string;
  code?: string;
  error?: string;
};

const pagePath = (propertyId: string, durum: string) =>
  `/villalar/${propertyId}/api-erisimi?durum=${durum}`;

// Kod denemesi kullanıcı başına sınırlı (tahmin denemelerine karşı ek katman).
const lookups = createMemoryRateLimit({ limit: 10, windowMs: 10 * 60_000, maxKeys: 5_000 });

const MESSAGES = {
  format: "Kodu KG-XXXX-XXXX biçiminde girin.",
  invalid_code:
    "Bu kod geçerli değil veya acente hesabı etkin değil. Kodu acenteden yeniden isteyin.",
  too_many: "Çok fazla deneme yapıldı. Birkaç dakika sonra yeniden deneyin.",
  error: "İşlem tamamlanamadı. Yeniden deneyin.",
} as const;

/** 1. adım: kod → acente adı (izin oluşturmaz). */
export async function lookupCodeAction(
  propertyId: string,
  _prev: CodeState,
  data: FormData,
): Promise<CodeState> {
  const code = String(data.get("code") ?? "").slice(0, 40);
  try {
    return await withPanelTenant(async (tx, ctx) => {
      if (!canManageApiAccess(ctx.role)) throw forbidden();
      if (!lookups.take(ctx.userId)) return { error: MESSAGES.too_many };
      const r = await lookupAccessCode(tx, code);
      if (!r.ok) return { error: MESSAGES[r.reason] };
      return { step: "confirm", clientId: r.client.id, clientName: r.client.name, code };
    });
  } catch (err) {
    unstable_rethrow(err);
    const res = toActionError(err, { action: "api.code_lookup", property: String(propertyId) });
    return { error: res.ok ? MESSAGES.error : res.error.message };
  }
}

/** 2. adım: ev sahibi acente adını görüp onaylar → izin. */
export async function confirmGrantAction(
  propertyId: string,
  _prev: CodeState,
  data: FormData,
): Promise<CodeState> {
  const id = String(propertyId);
  const code = String(data.get("code") ?? "").slice(0, 40);
  const clientId = String(data.get("clientId") ?? "");
  if (data.get("confirm") !== "evet") {
    return {
      step: "confirm",
      clientId,
      clientName: String(data.get("clientName") ?? "").slice(0, 100),
      code,
      error: "Onay kutusunu işaretleyin.",
    };
  }
  let outcome: string;
  try {
    outcome = await withPanelTenant(async (tx, ctx) => {
      if (!canManageApiAccess(ctx.role)) throw forbidden();
      return grantPropertyAccess(tx, { propertyId: id, code, clientId });
    });
  } catch (err) {
    unstable_rethrow(err);
    const res = toActionError(err, { action: "api.grant", property: id });
    return { error: res.ok ? MESSAGES.error : res.error.message };
  }
  if (outcome === "invalid_code") return { error: MESSAGES.invalid_code };
  if (outcome === "not_found") return { error: "Villa bulunamadı." };
  redirect(pagePath(id, outcome === "exists" ? "zaten-var" : "verildi"));
}

export type SimpleState = { error?: string };

export async function revokeGrantAction(grantId: string, propertyId: string): Promise<SimpleState> {
  const id = String(propertyId);
  let outcome: string;
  try {
    outcome = await withPanelTenant(async (tx, ctx) => {
      if (!canManageApiAccess(ctx.role)) throw forbidden();
      return revokePropertyAccess(tx, String(grantId));
    });
  } catch (err) {
    unstable_rethrow(err);
    const res = toActionError(err, { action: "api.revoke", property: id });
    return { error: res.ok ? MESSAGES.error : res.error.message };
  }
  if (outcome !== "revoked") return { error: "İzin bulunamadı veya zaten kaldırılmış." };
  redirect(pagePath(id, "kaldirildi"));
}
