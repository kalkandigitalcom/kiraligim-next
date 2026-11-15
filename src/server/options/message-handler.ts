/**
 * Opsiyon Aşama 3d — option-maintenance mesaj işleyicisi (runOptionMaintenance'a verilir).
 *
 * Mesaj başına (görev imleçle aldıktan sonra):
 *   1. app_option_message_items (drizzle/0072): worker'ın bu mesaj için kaydettiği öğeler.
 *   2. decideOptionMessage (./decide): saf karar (gönderen, niyet, tarih, süre, iptal nedeni).
 *   3. app_wa_option_apply (drizzle/0069): TEK transaction'da anahtarları, çakışmayı, açık
 *      opsiyonu, süreyi ve hedefi yeniden denetler; işlemi yazar ya da onaya düşürür ve imleci
 *      "done" yapar. İşlem gerekmiyorsa boş liste gönderilir: yalnız imleç kapanır.
 *
 * Mesajın durumu, worker önerisi, takvim, rezervasyon ve WhatsApp tepkisi DEĞİŞMEZ. Hata
 * fırlatılırsa imleç "claimed" kalır; 5 dk sonra en fazla 3 kez yeniden alınır. Log'a mesaj
 * metni yazılmaz (yalnız kimlik, karar türü ve sayılar).
 */
import { sql } from "drizzle-orm";

import type { Logger } from "@/lib/logger";

import { decideOptionMessage, type OptionMessageItem } from "./decide";
import type { OptionMessageHandler } from "./run";

const iso = (v: Date | string | null): string | null =>
  v === null ? null : typeof v === "string" ? v.slice(0, 10) : v.toISOString().slice(0, 10);

export function createOptionMessageHandler(deps: { log?: Logger } = {}): OptionMessageHandler {
  return async (db, m) => {
    const r = await db.execute<{
      item_no: number;
      parser_version: number;
      check_in: Date | string | null;
      check_out: Date | string | null;
      property_id: string | null;
      villa_resolution: string;
      flags: string[] | null;
      sender_role: string;
      sender_verified: boolean;
    }>(sql`select * from public.app_option_message_items(${m.messageId}::uuid)`);
    const items: OptionMessageItem[] = r.rows.map((x) => ({
      itemNo: Number(x.item_no),
      parserVersion: Number(x.parser_version),
      checkIn: iso(x.check_in),
      checkOut: iso(x.check_out),
      propertyId: x.property_id,
      villaResolution: x.villa_resolution,
      flags: x.flags ?? [],
      senderRole: x.sender_role,
      senderVerified: Boolean(x.sender_verified),
    }));
    const decision = decideOptionMessage({
      body: m.body,
      sentAt: m.sentAt,
      items,
      groupPropertyId: m.propertyId,
    });
    const payload = decision.kind === "items" ? decision.items : [];
    const res = await db.execute<{ status: string }>(
      sql`select status from public.app_wa_option_apply(${m.messageId}::uuid, ${JSON.stringify(payload)}::jsonb)`,
    );
    deps.log?.info("option_message_decided", {
      message: m.messageId,
      decision: decision.kind === "items" ? "items" : decision.why,
      operations: res.rows.length,
      applied: res.rows.filter((x) => x.status === "applied").length,
      pending: res.rows.filter((x) => x.status === "pending").length,
    });
  };
}
