"use server";

import { redirect, unstable_rethrow } from "next/navigation";

import type { FieldErrors } from "@/lib/errors";
import { toActionError } from "@/lib/result";
import { approveProposal, rejectProposal } from "@/server/whatsapp/proposals";
import { withPanelTenant } from "@/server/workspaces/panel-tenant";

/**
 * WhatsApp önerisi kararı (A2d). Kullanıcı ve işletme yalnız oturumdan; yetki (owner/manager),
 * öneri sürümü ve takvim çakışması serviste ve veritabanında denetlenir. Onay tek transaction'da
 * kaydı oluşturur ve öneriyi kapatır; hata olursa hiçbir şey yazılmaz.
 */
export type DecisionState = { error?: string; fieldErrors?: FieldErrors };

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v : undefined;
};

export async function approveProposalAction(
  id: string,
  _prev: DecisionState,
  fd: FormData,
): Promise<DecisionState> {
  let reservationId: string;
  try {
    const r = await withPanelTenant((tx, ctx) =>
      approveProposal(tx, ctx, id, {
        version: str(fd, "version"),
        propertyId: str(fd, "propertyId"),
        checkIn: str(fd, "checkIn"),
        checkOut: str(fd, "checkOut"),
        guestName: str(fd, "guestName"),
        adults: str(fd, "adults"),
        children: str(fd, "children"),
        status: str(fd, "status"),
        note: str(fd, "note"),
      }),
    );
    reservationId = r.reservationId;
  } catch (err) {
    unstable_rethrow(err);
    const res = toActionError(err, { action: "whatsapp.proposal_approve" });
    if (res.ok) return {};
    return {
      error: res.error.message,
      ...(res.error.fieldErrors ? { fieldErrors: res.error.fieldErrors } : {}),
    };
  }
  redirect(`/rezervasyonlar/${reservationId}?durum=olusturuldu`);
}

export async function rejectProposalAction(
  id: string,
  _prev: DecisionState,
  fd: FormData,
): Promise<DecisionState> {
  try {
    await withPanelTenant((tx, ctx) =>
      rejectProposal(tx, ctx, id, { version: str(fd, "version"), note: str(fd, "note") }),
    );
  } catch (err) {
    unstable_rethrow(err);
    const res = toActionError(err, { action: "whatsapp.proposal_reject" });
    return res.ok ? {} : { error: res.error.message };
  }
  redirect("/whatsapp/oneriler?durum=reddedildi");
}
