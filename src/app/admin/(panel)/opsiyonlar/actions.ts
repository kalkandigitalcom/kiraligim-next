"use server";

import { redirect, unstable_rethrow } from "next/navigation";

import { logger } from "@/lib/logger";
import {
  isUuid,
  parseCount,
  parseDurationChoices,
  parseDurationMinutes,
  parseGuestName,
  parseIsoDate,
  parseNote,
} from "@/lib/option-admin";
import {
  acknowledgeAlert,
  AdminOptionError,
  type AdminOptionErrorCode,
  cancelOption,
  decideOperation,
  getOptionSettings,
  setOptionGlobal,
  setOptionWorkspace,
  setSystemDefaultDuration,
} from "@/server/admin/options";
import { requireAdmin } from "@/server/admin/session";

/**
 * Super Admin — opsiyon işlemleri. Yönetici oturumu (2FA) HER işlemde yeniden denetlenir; asıl
 * denetimi (yetki, sürüm kilidi, durum, takvim parmak izi) veritabanı fonksiyonları yapar ve denetim
 * kaydını onlar yazar. Sonuç sayfaya kısa kodla döner; form içeriği URL'ye veya log'a yazılmaz.
 */
const text = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v : "";
};

const version = (fd: FormData) => {
  const n = Number(text(fd, "version"));
  return Number.isInteger(n) && n > 0 ? n : 0;
};

function errorCode(err: unknown, action: string): AdminOptionErrorCode {
  if (err instanceof AdminOptionError) return err.reason;
  logger.error("admin_option_action_error", {
    action,
    kind: err instanceof Error ? err.name : "unknown",
  });
  return "error";
}

type Db = Parameters<typeof cancelOption>[0];

async function run(
  target: string,
  fn: (db: Db, adminId: string) => Promise<string>,
  notices: Record<string, string>,
  action: string,
) {
  const admin = await requireAdmin();
  let to: string;
  try {
    const out = await fn(admin.ctx.db, admin.adminId);
    to = `${target}${target.includes("?") ? "&" : "?"}durum=${notices[out] ?? out}`;
  } catch (err) {
    unstable_rethrow(err);
    to = `${target}${target.includes("?") ? "&" : "?"}hata=${errorCode(err, action)}`;
  }
  redirect(to);
}

const fail = (target: string, code: AdminOptionErrorCode): never =>
  redirect(`${target}${target.includes("?") ? "&" : "?"}hata=${code}`);

// ---------------------------------------------------------------------------------------------
// Onay / ret
// ---------------------------------------------------------------------------------------------
export async function decideAction(operationId: string, fd: FormData): Promise<void> {
  const target = `/opsiyonlar/islem/${isUuid(operationId) ? operationId : ""}`;
  const approve = text(fd, "decision") === "approve";
  if (!approve && text(fd, "decision") !== "reject") fail(target, "invalid");
  const note = parseNote(fd.get("note"));
  if (note === undefined) fail(target, "note_invalid");
  let checkIn: string | null = null;
  let checkOut: string | null = null;
  let minutes: number | null = null;
  let guestName: string | null = null;
  let adults: number | null = null;
  let children: number | null = null;
  if (approve) {
    const a = text(fd, "checkIn");
    const b = text(fd, "checkOut");
    if (a || b) {
      checkIn = parseIsoDate(a);
      checkOut = parseIsoDate(b);
      if (!checkIn || !checkOut || checkOut <= checkIn) fail(target, "dates_invalid");
    }
    minutes = parseDurationMinutes(fd.get("duration"));
    if (minutes !== null && Number.isNaN(minutes)) fail(target, "duration_invalid");
    const g = parseGuestName(fd.get("guestName"));
    if (g === undefined) fail(target, "invalid");
    guestName = g ?? null;
    adults = parseCount(fd.get("adults"), 50);
    children = parseCount(fd.get("children"), 50);
    if ((adults !== null && (Number.isNaN(adults) || adults < 1)) || Number.isNaN(children ?? 0)) {
      fail(target, "guests_invalid");
    }
  }
  await run(
    target,
    (db, adminId) =>
      decideOperation(db, adminId, {
        operationId,
        version: version(fd),
        approve,
        note: note ?? null,
        checkIn,
        checkOut,
        expiresMinutes: minutes,
        guestName,
        adults,
        children,
      }),
    { approved: "onaylandi", rejected: "reddedildi" },
    approve ? "operation_approve" : "operation_reject",
  );
}

// ---------------------------------------------------------------------------------------------
// Panelden iptal
// ---------------------------------------------------------------------------------------------
export async function cancelOptionAction(optionId: string, fd: FormData): Promise<void> {
  const target = `/opsiyonlar/${isUuid(optionId) ? optionId : ""}`;
  if (text(fd, "confirm") !== "evet") fail(target, "confirm_required");
  const note = parseNote(fd.get("note"));
  if (note === undefined) fail(target, "note_invalid");
  await run(
    target,
    (db, adminId) => cancelOption(db, adminId, optionId, version(fd), note ?? null),
    { cancelled: "iptal-edildi" },
    "option_cancel",
  );
}

// ---------------------------------------------------------------------------------------------
// Çakışma uyarısı
// ---------------------------------------------------------------------------------------------
export async function acknowledgeAlertAction(alertId: string, back: string): Promise<void> {
  // Yalnız panel içi dönüş adresleri (açık yönlendirme yok).
  const target = /^\/opsiyonlar(\/[0-9a-f-]{36})?(\?sekme=uyarilar)?$/.test(back)
    ? back
    : "/opsiyonlar?sekme=uyarilar";
  await run(
    target,
    (db, adminId) => acknowledgeAlert(db, adminId, alertId),
    { acknowledged: "goruldu", already: "zaten-goruldu" },
    "alert_ack",
  );
}

// ---------------------------------------------------------------------------------------------
// Ayarlar ve kill switch
// ---------------------------------------------------------------------------------------------
const SETTINGS = "/opsiyonlar/ayarlar";
const SETTING_NOTICES = { changed: "ayar-kaydedildi", unchanged: "ayar-ayni" };

export async function setGlobalAction(enabled: boolean, fd: FormData): Promise<void> {
  // Açmak (kill switch'i kaldırmak) ayrıca onay ister; kapatmak her zaman serbest.
  if (enabled && text(fd, "confirm") !== "evet") fail(SETTINGS, "confirm_required");
  await run(
    SETTINGS,
    (db, adminId) => setOptionGlobal(db, adminId, enabled),
    SETTING_NOTICES,
    "global",
  );
}

/** Faz A (0075): sistem geneli varsayılan opsiyon süresi. */
export async function setSystemDefaultAction(fd: FormData): Promise<void> {
  const minutes = parseDurationMinutes(fd.get("systemDefault"));
  if (minutes === null || Number.isNaN(minutes)) fail(SETTINGS, "duration_invalid");
  await run(
    SETTINGS,
    (db, adminId) => setSystemDefaultDuration(db, adminId, minutes as number),
    SETTING_NOTICES,
    "system_default",
  );
}

export async function setWorkspaceAction(workspaceId: string, fd: FormData): Promise<void> {
  // Tek ortak opsiyon sistemi (0074): işletme başına otomasyon anahtarı yok; burada yalnız
  // işletmenin varsayılan süresi ve süre seçenekleri kaydedilir. Eski anahtar değeri (artık
  // kullanılmayan sütun) olduğu gibi korunur.
  const def = parseDurationMinutes(fd.get("defaultDuration"));
  if (def !== null && Number.isNaN(def)) fail(SETTINGS, "duration_invalid");
  const choices = parseDurationChoices(fd.get("choices"));
  if (choices === null) fail(SETTINGS, "choices_invalid");
  await run(
    SETTINGS,
    async (db, adminId) =>
      setOptionWorkspace(db, adminId, {
        workspaceId,
        enabled:
          (await getOptionSettings(db, adminId)).workspaces.get(workspaceId)?.enabled ?? false,
        defaultMinutes: def,
        choices: choices ?? [],
      }),
    SETTING_NOTICES,
    "workspace",
  );
}
