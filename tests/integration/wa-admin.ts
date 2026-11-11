import { randomBytes } from "node:crypto";

import type { Client } from "pg";
import { uuidv7 } from "uuidv7";

/**
 * Aşama 2 test yardımcıları: Super Admin WhatsApp fonksiyonları (drizzle/0044) GERÇEK app_admin
 * rolüyle çağrılır (süper kullanıcı bağlantısında transaction içinde SET LOCAL ROLE app_admin;
 * app_admin LOGIN yapılmaz, NOLOGIN durumu korunur).
 */
export async function createTestAdmin(admin: Client, label = "wa"): Promise<string> {
  const id = uuidv7();
  await admin.query(
    `insert into admin_users (id, email, name, password_hash, totp_secret_enc)
     values ($1, $2, $3, 'scrypt$test', 'v1:test')`,
    [id, `${label}.${randomBytes(4).toString("hex")}@kiraligim.test`, `Admin ${label}`],
  );
  return id;
}

/** app_admin olarak tek sorgu; ilk satırın `out` kolonu (yoksa tüm satırlar) döner. */
export async function asAppAdmin<T = string>(
  admin: Client,
  text: string,
  values: unknown[] = [],
): Promise<T> {
  await admin.query("begin");
  try {
    await admin.query("set local role app_admin");
    const r = await admin.query(text, values);
    await admin.query("commit");
    const first = r.rows[0] as Record<string, unknown> | undefined;
    return (first && "out" in first ? first.out : r.rows) as T;
  } catch (e) {
    await admin.query("rollback");
    throw e;
  }
}

export const adminLink = (
  admin: Client,
  adminId: string,
  groupId: string,
  workspaceId: string,
  propertyId: string,
) =>
  asAppAdmin<string>(admin, "select public.app_wa_admin_link_group($1, $2, $3, $4) as out", [
    adminId,
    groupId,
    workspaceId,
    propertyId,
  ]);

export const adminSetActive = (admin: Client, adminId: string, groupId: string, active: boolean) =>
  asAppAdmin<string>(admin, "select public.app_wa_admin_set_active($1, $2, $3) as out", [
    adminId,
    groupId,
    active,
  ]);

export const adminSetProperty = (
  admin: Client,
  adminId: string,
  groupId: string,
  propertyId: string,
) =>
  asAppAdmin<string>(admin, "select public.app_wa_admin_set_property($1, $2, $3) as out", [
    adminId,
    groupId,
    propertyId,
  ]);

export const adminUnlink = (admin: Client, adminId: string, groupId: string) =>
  asAppAdmin<string>(admin, "select public.app_wa_admin_unlink_group($1, $2) as out", [
    adminId,
    groupId,
  ]);

export const adminArchive = (admin: Client, adminId: string, groupId: string, archive: boolean) =>
  asAppAdmin<string>(admin, "select public.app_wa_admin_archive_group($1, $2, $3) as out", [
    adminId,
    groupId,
    archive,
  ]);

/** B aşaması: numarayı engeller (groupId null: bütün gruplarda). */
export const adminBlockSender = (
  admin: Client,
  adminId: string,
  phone: string,
  groupId: string | null,
) =>
  asAppAdmin<string>(admin, "select public.app_wa_admin_block_sender($1, $2, $3) as out", [
    adminId,
    phone,
    groupId,
  ]);

export const adminUnblockSender = (admin: Client, adminId: string, blockId: string) =>
  asAppAdmin<string>(admin, "select public.app_wa_admin_unblock_sender($1, $2) as out", [
    adminId,
    blockId,
  ]);
