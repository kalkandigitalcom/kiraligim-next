"use server";

import { redirect, unstable_rethrow } from "next/navigation";

import { logger } from "@/lib/logger";
import {
  AdminApiError,
  type AdminApiErrorCode,
  createAccessCode,
  createApiClient,
  createApiKey,
  grantApiAccess,
  revokeApiAccess,
  revokeApiKey,
  setApiClientActive,
} from "@/server/admin/api-clients";
import { requireAdmin } from "@/server/admin/session";

/**
 * Super Admin — API müşterileri işlemleri. Yönetici oturumu (2FA) her işlemde yeniden denetlenir;
 * hesap, anahtar, villa ve izin veritabanında doğrulanır. Sonuç sayfaya kısa kodla döner.
 * Yeni API anahtarı ve erişim kodu YALNIZ işlem dönüşünde (bir kez) ekrana verilir; URL'ye,
 * log'a veya veritabanına açık yazılmaz.
 */
const text = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v : "";
};

type Db = Parameters<typeof setApiClientActive>[0];

function errorCode(err: unknown, action: string): AdminApiErrorCode {
  if (err instanceof AdminApiError) return err.reason;
  logger.error("admin_api_action_error", {
    action,
    kind: err instanceof Error ? err.name : "unknown",
  });
  return "error";
}

async function run(
  target: string,
  fn: (db: Db, adminId: string) => Promise<unknown>,
  ok: string,
  action: string,
) {
  const admin = await requireAdmin();
  let to = `${target}?durum=${ok}`;
  try {
    await fn(admin.ctx.db, admin.adminId);
  } catch (err) {
    unstable_rethrow(err);
    to = `${target}?hata=${errorCode(err, action)}`;
  }
  redirect(to);
}

export async function createClientAction(fd: FormData): Promise<void> {
  const admin = await requireAdmin();
  let to: string;
  try {
    const id = await createApiClient(admin.ctx.db, admin.adminId, text(fd, "name"));
    to = `/api-musterileri/${id}?durum=olusturuldu`;
  } catch (err) {
    unstable_rethrow(err);
    to = `/api-musterileri?hata=${errorCode(err, "client_create")}`;
  }
  redirect(to);
}

export async function setClientActiveAction(clientId: string, active: boolean): Promise<void> {
  await run(
    `/api-musterileri/${clientId}`,
    (db, adminId) => setApiClientActive(db, adminId, clientId, active),
    active ? "etkin" : "pasif",
    "client_status",
  );
}

export async function revokeKeyAction(clientId: string, keyId: string): Promise<void> {
  await run(
    `/api-musterileri/${clientId}`,
    (db, adminId) => revokeApiKey(db, adminId, keyId),
    "anahtar-geri-alindi",
    "key_revoke",
  );
}

export async function grantAction(clientId: string, fd: FormData): Promise<void> {
  await run(
    `/api-musterileri/${clientId}`,
    (db, adminId) => grantApiAccess(db, adminId, clientId, text(fd, "propertyId")),
    "izin-verildi",
    "grant",
  );
}

export async function revokeGrantAction(clientId: string, grantId: string): Promise<void> {
  await run(
    `/api-musterileri/${clientId}`,
    (db, adminId) => revokeApiAccess(db, adminId, grantId),
    "izin-kaldirildi",
    "grant_revoke",
  );
}

/** Bir kez gösterilecek gizli değer (anahtar / kod) dönen işlemler. */
export type SecretState = { secret?: string; error?: string };

export async function createKeyAction(
  clientId: string,
  _prev: SecretState,
  fd: FormData,
): Promise<SecretState> {
  const admin = await requireAdmin();
  try {
    const { key } = await createApiKey(admin.ctx.db, admin.adminId, clientId, text(fd, "label"));
    return { secret: key };
  } catch (err) {
    unstable_rethrow(err);
    const code = errorCode(err, "key_create");
    return { error: code };
  }
}

export async function createAccessCodeAction(
  clientId: string,
  _prev: SecretState,
): Promise<SecretState> {
  const admin = await requireAdmin();
  try {
    return { secret: await createAccessCode(admin.ctx.db, admin.adminId, clientId) };
  } catch (err) {
    unstable_rethrow(err);
    return { error: errorCode(err, "access_code") };
  }
}
