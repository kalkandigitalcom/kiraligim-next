"use server";

import { redirect, unstable_rethrow } from "next/navigation";

import { type ActionResult, ok, toActionError } from "@/lib/result";
import { formatLinkCode, verifyMessage, waMeLink } from "@/lib/whatsapp-meta";
import {
  createPhoneChallenge,
  getConnectionStatus,
  getPhoneChallengeState,
  removeMyPhone,
} from "@/server/whatsapp/service";
import { withPanelTenant } from "@/server/workspaces/panel-tenant";

/**
 * WhatsApp Asistanı işletme paneli server action'ları: yalnız numara doğrulama. Grup eşleştirme,
 * villa değişikliği, pasife alma ve bağlantı kaldırma YALNIZ Super Admin panelindedir (Aşama 2).
 * Kullanıcı ve işletme yalnız oturumdan (withPanelTenant → withTenant). Telefon, kod ve mesaj
 * içeriği log'a yazılmaz.
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
