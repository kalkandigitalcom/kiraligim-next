/**
 * WhatsApp Asistanı — Aşama 2: bağlı gruptaki açık "aç / müsait yap" talimatının takvim BLOKLARINI
 * kaldırması (kapalı tarihleri yeniden müsait yapma).
 *
 * Worker (dist/wa-calendar.js) öneriyi kaydettikten SONRA, yalnız uygunluk kuralını
 * (calendar/auto-close-rule.ts → autoOpenCandidate) geçen açma önerileri için çağırır. Next.js'e
 * ve "server-only"e bağımlı DEĞİLDİR. Talimatı grubun Super Admin tarafından engellenmemiş herhangi
 * bir katılımcısı verebilir (B aşaması); işlem işletme SAHİBİ adına yapılır.
 *
 * Kapsam (yalnız takvim blokları):
 *  - Hedef: grubun villasında, istenen [giriş, çıkış) aralığıyla çakışan aktif BLOKLAR
 *    (kind = 'block'). Elle veya WhatsApp'tan oluşturulmuş olması fark etmez.
 *  - Rezervasyonlar (gerçek misafir; direct/phone/airbnb/booking/web/whatsapp kaynaklı) ve harici
 *    takvim (iCal) olayları HİÇ değiştirilmez; başka villanın kayıtlarına dokunulmaz.
 *  - Aralıkta TAMAMEN kalan bütün bloklar kaldırılır. Bir blok aralıkla yalnız KISMEN çakışıyorsa
 *    hiçbir şey yapılmaz ("partial"; blok bölme bu aşamada yok). Kaldırılacak blok yoksa hiçbir şey
 *    yapılmaz ("no_target").
 *  - Aralıkta gerçek bir rezervasyon veya harici takvim (iCal) doluluğu da varsa hiçbir blok
 *    kaldırılmaz ("occupied"): tarihler zaten tamamen müsait olamaz; ✅ yanıltıcı olurdu (⚠️).
 *
 * Güvenlik ve bütünlük:
 *  - Blok, mevcut rezervasyon servisiyle (cancelReservation: rol denetimi, FOR UPDATE, iptal
 *    kalıcılığı, denetim kaydı) ve sahibin oturum bağlamında (withTenant) kaldırılır.
 *  - Kilit sırası: GRUP (FOR SHARE, 0045) → ÖNERİ (FOR UPDATE) → hedef bloklar (FOR UPDATE, kimlik
 *    sırasıyla). Super Admin grup işlemleri ve eşzamanlı WhatsApp mesajları sıralanır.
 *  - Blokların kaldırılması ve önerinin "applied" (decision_mode = 'quick') olması TEK
 *    transaction'dadır; herhangi bir hata hepsini geri alır. Karar verilmiş öneri yeniden
 *    işlenmez (idempotent).
 *  - Mesaj metni, misafir veya numara kaydedilmez/loglanmaz.
 */
import { sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { isAppError } from "@/lib/errors";
import { WA_PROPOSAL_LIMITS as PL } from "@/lib/whatsapp-meta";
import { WA_SENDER_ROLES, type WaSenderRole } from "@/lib/wa-calendar-parse";
import { recordAudit } from "@/server/audit/record";
import { findExternalConflicts } from "@/server/ical/service";
import { cancelReservation } from "@/server/reservations/service";

export const WA_AUTO_OPEN_FAILURES = [
  /** İşlemi yapacak kullanıcı artık işletme sahibi değil (veya üyelik/işletme pasif). */
  "not_owner",
  /** Öneri artık bekleyen, nedensiz bir açma değil; grup değişti ya da değerler farklı. */
  "changed",
  /** Bir blok istenen aralıkla yalnız kısmen çakışıyor (blok bölünmez). */
  "partial",
  /** İstenen aralıkta kaldırılabilecek blok yok. */
  "no_target",
  /** Kaldırılacak blok sayısı sınırı aşıyor. */
  "too_many",
  /** Aralıkta rezervasyon veya harici takvim doluluğu var; tarihler tamamen açılamaz. */
  "occupied",
  /** Beklenmeyen hata. */
  "error",
] as const;
export type WaAutoOpenFailure = (typeof WA_AUTO_OPEN_FAILURES)[number];

export type AutoOpenRequest = {
  workspaceId: string;
  /** İşlemi yapan kullanıcı: işletme sahibi (app_wa_message_actor; kilitli mesajdan). */
  userId: string;
  messageId: string;
  itemNo: number;
  propertyId: string;
  checkIn: string;
  checkOut: string;
};

export type AutoOpenResult =
  | { outcome: "applied"; proposalId: string; reservationIds: string[] }
  | { outcome: "failed"; proposalId: string | null; reason: WaAutoOpenFailure };

export type AutoOpener = (req: AutoOpenRequest) => Promise<AutoOpenResult>;

/** Blok iptal nedeni ve öneri karar notu (kişisel bilgi içermez). */
export const WA_AUTO_OPEN_NOTE = "WhatsApp grubundaki talimatla takvim yeniden açıldı.";

class Stop extends Error {
  constructor(
    readonly reason: WaAutoOpenFailure,
    readonly proposalId: string | null,
  ) {
    super(reason);
  }
}

type Locked = {
  id: string;
  status: string;
  action: string | null;
  property_id: string | null;
  check_in: string | null;
  check_out: string | null;
  review_reasons: string[];
  sender_role: string;
  group_id: string;
};

type Block = { id: string; check_in: string; check_out: string };

function classify(err: unknown): WaAutoOpenFailure {
  if (err instanceof Stop) return err.reason;
  if (!isAppError(err)) return "error";
  if (err.code === "FORBIDDEN") return "not_owner";
  if (err.code === "NOT_FOUND" || err.code === "CONFLICT") return "changed";
  return "error";
}

export function createAutoOpener(db: Database): AutoOpener {
  return async (req) => {
    let proposalId: string | null = null;
    try {
      return await withTenant(
        db,
        { userId: req.userId, workspaceId: req.workspaceId },
        async (tx, ctx) => {
          if (ctx.role !== "owner") throw new Stop("not_owner", null);
          // Kilit sırası: GRUP → ÖNERİ → bloklar (otomatik kapatma ve Super Admin ile aynı sıra).
          const pre = await tx.execute<{ group_id: string }>(sql`
            select group_id from wa_calendar_proposals
             where message_id = ${req.messageId}::uuid and item_no = ${req.itemNo}
               and workspace_id = app_current_workspace_id()`);
          const groupId = pre.rows[0]?.group_id;
          if (!groupId) throw new Stop("changed", null);
          const grp = await tx.execute<{ status: string; property_id: string | null }>(
            sql`select * from public.app_wa_lock_group_for_auto_close(${groupId}::uuid)`,
          );
          const gr = grp.rows[0];
          const res = await tx.execute<Locked>(sql`
            select id, status, action, property_id,
                   to_char(check_in, 'YYYY-MM-DD') as check_in,
                   to_char(check_out, 'YYYY-MM-DD') as check_out,
                   review_reasons, sender_role, group_id
              from wa_calendar_proposals
             where message_id = ${req.messageId}::uuid and item_no = ${req.itemNo}
               and workspace_id = app_current_workspace_id()
             for update`);
          const p = res.rows[0];
          if (!p) throw new Stop("changed", null);
          proposalId = p.id;
          if (!gr || gr.status !== "linked" || gr.property_id !== req.propertyId) {
            throw new Stop("changed", p.id);
          }
          if (
            p.group_id !== groupId ||
            p.status !== "pending" ||
            p.action !== "open" ||
            (p.review_reasons ?? []).length !== 0 ||
            !(WA_SENDER_ROLES as readonly string[]).includes(p.sender_role) ||
            p.property_id !== req.propertyId ||
            p.check_in !== req.checkIn ||
            p.check_out !== req.checkOut
          ) {
            throw new Stop("changed", p.id);
          }

          // Hedef: grubun villasında aralıkla çakışan aktif BLOKLAR (rezervasyonlar hiç seçilmez).
          // Satırlar kimlik sırasıyla kilitlenir (eşzamanlı işlemlerle kilitlenme olmaz).
          const blocks = (
            await tx.execute<Block>(sql`
              select r.id,
                     to_char(r.check_in, 'YYYY-MM-DD') as check_in,
                     to_char(r.check_out, 'YYYY-MM-DD') as check_out
                from reservations r
               where r.workspace_id = app_current_workspace_id()
                 and r.property_id = ${req.propertyId}::uuid
                 and r.kind = 'block'
                 and r.status in ('pending', 'confirmed')
                 and daterange(r.check_in, r.check_out, '[)')
                     && daterange(${req.checkIn}::date, ${req.checkOut}::date, '[)')
               order by r.id
               for update`)
          ).rows;
          if (blocks.length === 0) throw new Stop("no_target", p.id);
          // Kısmi çakışma: blok aralığın dışına taşıyor → hiçbir blok kaldırılmaz.
          if (blocks.some((b) => b.check_in < req.checkIn || b.check_out > req.checkOut)) {
            throw new Stop("partial", p.id);
          }
          if (blocks.length > PL.arrayMax) throw new Stop("too_many", p.id);
          // Aralıkta rezervasyon (hiç değiştirilmez) veya harici takvim doluluğu varsa tarihler
          // tamamen müsait olamaz: hiçbir blok kaldırılmaz, ⚠️ (yanıltıcı ✅ verilmez).
          const occupied = await tx.execute<{ n: number }>(sql`
            select count(*)::int as n from reservations r
             where r.workspace_id = app_current_workspace_id()
               and r.property_id = ${req.propertyId}::uuid
               and r.kind = 'reservation'
               and r.status in ('pending', 'confirmed')
               and daterange(r.check_in, r.check_out, '[)')
                   && daterange(${req.checkIn}::date, ${req.checkOut}::date, '[)')`);
          const external = await findExternalConflicts(
            tx,
            req.propertyId,
            req.checkIn,
            req.checkOut,
          );
          if (Number(occupied.rows[0]?.n ?? 0) > 0 || external.length > 0) {
            throw new Stop("occupied", p.id);
          }

          const ids = blocks.map((b) => b.id);
          for (const id of ids) {
            const r = await cancelReservation(tx, ctx, id, WA_AUTO_OPEN_NOTE);
            if (!r.changed) throw new Stop("changed", p.id);
          }
          await tx.execute(sql`
            update wa_calendar_proposals
               set status = 'applied',
                   decided_by = app_current_user_id(),
                   decided_at = now(),
                   decision_mode = 'quick',
                   decision_note = ${WA_AUTO_OPEN_NOTE},
                   target_reservation_ids = ${`{${ids.join(",")}}`}::uuid[],
                   applied_reservation_ids = ${`{${ids.join(",")}}`}::uuid[]
             where id = ${p.id}::uuid`);
          await recordAudit(tx, {
            action: "whatsapp.proposal_auto_opened",
            targetType: "whatsapp_proposal",
            targetId: p.id,
            metadata: {
              property: req.propertyId,
              reservations: ids,
              group: groupId,
              sender_role: p.sender_role as WaSenderRole,
            },
          });
          return { outcome: "applied" as const, proposalId: p.id, reservationIds: ids };
        },
      );
    } catch (err) {
      const reason = classify(err);
      const pid = err instanceof Stop ? err.proposalId : proposalId;
      // Sonuç denetim kaydına (ayrı transaction: ilk transaction geri alındı).
      if (pid && reason !== "not_owner") {
        try {
          await withTenant(db, { userId: req.userId, workspaceId: req.workspaceId }, (tx) =>
            recordAudit(tx, {
              action: "whatsapp.proposal_auto_failed",
              targetType: "whatsapp_proposal",
              targetId: pid,
              metadata: { reason },
            }),
          );
        } catch {
          // Denetim kaydı yazılamadı: takvim zaten değişmedi; worker log'a kodu yazar.
        }
      }
      return { outcome: "failed", proposalId: pid, reason };
    }
  };
}
