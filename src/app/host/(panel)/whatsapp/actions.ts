"use server";

import { redirect, unstable_rethrow } from "next/navigation";

import { type ActionResult, ok, toActionError } from "@/lib/result";
import { formatLinkCode, verifyMessage, waMeLink } from "@/lib/whatsapp-meta";
import {
  claimGroup,
  createPhoneChallenge,
  getConnectionStatus,
  getPhoneChallengeState,
  removeMyPhone,
  setGroupProperty,
  setGroupSuspended,
  setManagerAuthorized,
  unlinkGroup,
} from "@/server/whatsapp/service";
import { withPanelTenant } from "@/server/workspaces/panel-tenant";

/**
 * WhatsApp Asistanı (A1.1) server action'ları. Kullanıcı ve işletme yalnız oturumdan
 * (withPanelTenant → withTenant); gönderilen grup/villa/kullanıcı kimliği yetki vermez: RLS başka
 * işletmenin kaydını göstermez, yetki ve numara eşleşmesi hem serviste hem veritabanında denetlenir.
 * Telefon, kod ve mesaj içeriği log'a yazılmaz. Gruplara kod yazılmaz.
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

/* ── Numara doğrulama ───────────────────────────────────────────────────── */

export type PhoneChallengeFormState = {
  error?: string;
  issued?: {
    id: string;
    code: string;
    message: string;
    /** wa.me bağlantısı; asistan numarası bilinmiyorsa null (mesaj elle gönderilir). */
    link: string | null;
    expiresAt: string;
  };
};

export async function createPhoneChallengeAction(
  _prev: PhoneChallengeFormState,
): Promise<PhoneChallengeFormState> {
  const result = await runAction("whatsapp.phone_challenge_create", () =>
    withPanelTenant(async (tx, ctx) => ({
      issued: await createPhoneChallenge(tx, ctx),
      accountPn: (await getConnectionStatus(tx)).accountPn,
    })),
  );
  if (!result.ok) return { error: result.error.message };
  const { issued, accountPn } = result.data;
  const message = verifyMessage(issued.code);
  return {
    issued: {
      id: issued.id,
      code: formatLinkCode(issued.code),
      message,
      link: waMeLink(accountPn, message),
      expiresAt: issued.expiresAt.toISOString(),
    },
  };
}

export type PhoneChallengePoll =
  | { state: "pending" }
  | { state: "used"; masked: string | null }
  | { state: "expired" }
  | { state: "error" };

/** Kod durumunu yoklar (yalnız kodu üreten kişi görebilir). */
export async function pollPhoneChallengeAction(challengeId: string): Promise<PhoneChallengePoll> {
  const result = await runAction("whatsapp.phone_challenge_poll", () =>
    withPanelTenant((tx) => getPhoneChallengeState(tx, String(challengeId))),
  );
  if (!result.ok) return { state: "error" };
  const s = result.data;
  if (s.state === "used") return { state: "used", masked: s.masked };
  return { state: s.state };
}

export async function removeMyPhoneAction(): Promise<SimpleState> {
  const result = await runAction("whatsapp.phone_remove", () =>
    withPanelTenant((tx, ctx) => removeMyPhone(tx, ctx)),
  );
  if (!result.ok) return { error: result.error.message };
  redirect("/whatsapp?durum=numara-kaldirildi");
}

/* ── Eşleştirme ─────────────────────────────────────────────────────────── */

export type ClaimFormState = { error?: string; propertyError?: string };

export async function claimGroupAction(
  _prev: ClaimFormState,
  formData: FormData,
): Promise<ClaimFormState> {
  const input = {
    groupId: String(formData.get("groupId") ?? ""),
    propertyId: String(formData.get("propertyId") ?? ""),
  };
  const result = await runAction("whatsapp.group_claim", () =>
    withPanelTenant((tx, ctx) => claimGroup(tx, ctx, input)),
  );
  if (!result.ok) {
    const fe = result.error.fieldErrors?.propertyId?.[0];
    return fe ? { propertyError: fe } : { error: result.error.message };
  }
  redirect("/whatsapp?durum=eslestirildi");
}

export async function setGroupPropertyAction(
  groupId: string,
  _prev: ClaimFormState,
  formData: FormData,
): Promise<ClaimFormState> {
  const propertyId = String(formData.get("propertyId") ?? "");
  const result = await runAction("whatsapp.group_property", () =>
    withPanelTenant((tx, ctx) => setGroupProperty(tx, ctx, String(groupId), propertyId)),
  );
  if (!result.ok) {
    const fe = result.error.fieldErrors?.propertyId?.[0];
    return fe ? { propertyError: fe } : { error: result.error.message };
  }
  redirect("/whatsapp?durum=villa-degisti");
}

/* ── Grup durumu ve yetkiler ────────────────────────────────────────────── */

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
