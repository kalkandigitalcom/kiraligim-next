"use server";

import { redirect, unstable_rethrow } from "next/navigation";

import { logger } from "@/lib/logger";
import {
  AdminWaError,
  type AdminWaErrorCode,
  archiveAdminGroup,
  blockAdminSender,
  linkAdminGroup,
  setAdminGroupActive,
  setAdminGroupProperty,
  unblockAdminSender,
  unlinkAdminGroup,
} from "@/server/admin/whatsapp";
import { requireAdmin } from "@/server/admin/session";

/**
 * Super Admin grup işlemleri. Yönetici oturumu (2FA) her işlemde yeniden denetlenir; işletme,
 * villa ve grup durumu veritabanında doğrulanır. Sonuç sayfaya yalnız kısa kodla döner.
 */
const text = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v : "";
};

async function run(
  groupId: string,
  fn: (db: Parameters<typeof linkAdminGroup>[0], adminId: string) => Promise<unknown>,
  ok: string,
) {
  const admin = await requireAdmin();
  let target = `/whatsapp/${groupId}?durum=${ok}`;
  try {
    await fn(admin.ctx.db, admin.adminId);
  } catch (err) {
    unstable_rethrow(err);
    let code: AdminWaErrorCode = "error";
    if (err instanceof AdminWaError) code = err.reason;
    else logger.error("admin_wa_action_error", { err });
    target = `/whatsapp/${groupId}?hata=${code}`;
  }
  redirect(target);
}

export async function linkGroupAction(groupId: string, fd: FormData): Promise<void> {
  await run(
    groupId,
    (db, adminId) =>
      linkAdminGroup(db, adminId, {
        groupId,
        workspaceId: text(fd, "workspaceId"),
        propertyId: text(fd, "propertyId"),
      }),
    "eslestirildi",
  );
}

export async function setPropertyAction(groupId: string, fd: FormData): Promise<void> {
  await run(
    groupId,
    (db, adminId) => setAdminGroupProperty(db, adminId, groupId, text(fd, "propertyId")),
    "villa-degisti",
  );
}

export async function setActiveAction(groupId: string, active: boolean): Promise<void> {
  await run(
    groupId,
    (db, adminId) => setAdminGroupActive(db, adminId, groupId, active),
    active ? "aktif" : "pasif",
  );
}

export async function unlinkGroupAction(groupId: string, fd: FormData): Promise<void> {
  if (text(fd, "confirm") !== "evet") redirect(`/whatsapp/${groupId}?hata=confirm_required`);
  await run(groupId, (db, adminId) => unlinkAdminGroup(db, adminId, groupId), "kaldirildi");
}

export async function archiveGroupAction(groupId: string, archive: boolean): Promise<void> {
  await run(
    groupId,
    (db, adminId) => archiveAdminGroup(db, adminId, groupId, archive),
    archive ? "arsivlendi" : "arsivden-cikti",
  );
}

/**
 * B aşaması: numaranın operasyonel komut vermesini engeller. Kapsam: yalnız bu grup ya da bütün
 * gruplar. Numara URL'ye, log'a veya veritabanına açık yazılmaz (yalnız özet ve son 4 hane).
 */
export async function blockSenderAction(groupId: string, fd: FormData): Promise<void> {
  const scope = text(fd, "scope") === "all" ? null : groupId;
  await run(
    groupId,
    (db, adminId) => blockAdminSender(db, adminId, { phone: text(fd, "phone"), groupId: scope }),
    "engellendi",
  );
}

export async function unblockSenderAction(groupId: string, blockId: string): Promise<void> {
  await run(groupId, (db, adminId) => unblockAdminSender(db, adminId, blockId), "engel-kalkti");
}
