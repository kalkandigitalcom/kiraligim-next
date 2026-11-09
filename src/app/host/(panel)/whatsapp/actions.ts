"use server";

import { redirect, unstable_rethrow } from "next/navigation";

import { type ActionResult, ok, toActionError } from "@/lib/result";
import { formatLinkCode, linkMessage } from "@/lib/whatsapp-meta";
import {
  createLinkCode,
  getLinkCodeState,
  setGroupSuspended,
  setManagerAuthorized,
  unlinkGroup,
} from "@/server/whatsapp/service";
import { withPanelTenant } from "@/server/workspaces/panel-tenant";

/**
 * WhatsApp Asistanı (A1) server action'ları. Kullanıcı ve işletme yalnız oturumdan
 * (withPanelTenant → withTenant); gönderilen grup/kullanıcı kimliği yetki vermez: RLS başka
 * işletmenin kaydını göstermez, yetki hem serviste hem veritabanı politikalarında denetlenir.
 * Telefon, kod ve mesaj içeriği log'a yazılmaz.
 */
async function runAction<T>(name: string, fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return ok(await fn());
  } catch (err) {
    unstable_rethrow(err);
    return toActionError(err, { action: name });
  }
}

export type SimpleState = { error?: string };

export type LinkCodeFormState = {
  error?: string;
  phoneError?: string;
  phone?: string;
  issued?: { id: string; code: string; message: string; expiresAt: string };
};

export async function createLinkCodeAction(
  _prev: LinkCodeFormState,
  formData: FormData,
): Promise<LinkCodeFormState> {
  const phone = String(formData.get("phone") ?? "");
  const result = await runAction("whatsapp.link_code_create", () =>
    withPanelTenant((tx, ctx) => createLinkCode(tx, ctx, { phone })),
  );
  if (!result.ok) {
    const fe = result.error.fieldErrors?.phone?.[0];
    return fe ? { phoneError: fe, phone } : { error: result.error.message, phone };
  }
  return {
    phone,
    issued: {
      id: result.data.id,
      code: formatLinkCode(result.data.code),
      message: linkMessage(result.data.code),
      expiresAt: result.data.expiresAt.toISOString(),
    },
  };
}

export type LinkCodePoll =
  | { state: "pending" }
  | { state: "used"; groupSubject: string | null }
  | { state: "expired" }
  | { state: "error" };

/** Kod durumunu yoklar (yalnız kodu üreten kişi görebilir). */
export async function pollLinkCodeAction(codeId: string): Promise<LinkCodePoll> {
  const result = await runAction("whatsapp.link_code_poll", () =>
    withPanelTenant((tx) => getLinkCodeState(tx, String(codeId))),
  );
  if (!result.ok) return { state: "error" };
  const s = result.data;
  if (s.state === "used") return { state: "used", groupSubject: s.groupSubject };
  return { state: s.state };
}

export async function setGroupSuspendedAction(
  groupId: string,
  suspended: boolean,
): Promise<SimpleState> {
  const result = await runAction("whatsapp.group_status", () =>
    withPanelTenant((tx, ctx) => setGroupSuspended(tx, ctx, String(groupId), suspended)),
  );
  if (!result.ok) return { error: result.error.message };
  redirect(`/whatsapp?durum=${suspended ? "askiya-alindi" : "etkinlestirildi"}`);
}

export async function unlinkGroupAction(groupId: string): Promise<SimpleState> {
  const result = await runAction("whatsapp.group_unlink", () =>
    withPanelTenant((tx, ctx) => unlinkGroup(tx, ctx, String(groupId))),
  );
  if (!result.ok) return { error: result.error.message };
  redirect("/whatsapp?durum=baglanti-kesildi");
}

export async function setManagerAuthorizedAction(
  userId: string,
  authorized: boolean,
): Promise<SimpleState> {
  const result = await runAction("whatsapp.link_manager", () =>
    withPanelTenant((tx, ctx) => setManagerAuthorized(tx, ctx, String(userId), authorized)),
  );
  if (!result.ok) return { error: result.error.message };
  redirect(`/whatsapp?durum=${authorized ? "yetki-verildi" : "yetki-kaldirildi"}`);
}
