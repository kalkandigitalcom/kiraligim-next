/**
 * WhatsApp Asistanı — A2e: işletme SAHİBİNİN açık kapatma talimatının takvime otomatik işlenmesi.
 *
 * Worker (dist/wa-calendar.js) öneriyi kaydettikten SONRA, yalnız uygunluk kuralını
 * (calendar/auto-close-rule.ts) geçen kapatma önerileri için çağırır. Next.js'e ve "server-only"e
 * bağımlı DEĞİLDİR.
 *
 * Güvenlik:
 *  - Blok, mevcut rezervasyon servisiyle (createReservation: tarih kuralları, pasif villa, çakışma
 *    kısıtı ve harici takvim koruması) ve gönderen SAHİBİN oturum bağlamında oluşur: withTenant
 *    üyeliği ve rolü veritabanından yeniden okur; rol owner değilse hiçbir şey yazılmaz.
 *  - Öneri FOR UPDATE ile kilitlenir ve bekleyen, nedensiz, sahipten gelen bir kapatma olduğu,
 *    villa ve tarihlerin worker'ın değerlendirdiğiyle aynı olduğu yeniden denetlenir.
 *  - Blok ve öneri kararı ("applied", decision_mode = 'quick', decided_by = sahip) TEK
 *    transaction'dadır; veritabanı durum makinesi ve quick kısıtı ayrıca uygular. Karar verilmiş
 *    öneri yeniden işlenmez (idempotent).
 *  - Her hata yakalanır: takvim değişmez, öneri panelde onay bekler ve sonuç (yalnız kısa neden
 *    kodu) denetim kaydına yazılır. Mesaj metni, misafir veya numara kaydedilmez/loglanmaz.
 */
import { sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { isAppError } from "@/lib/errors";
import { recordAudit } from "@/server/audit/record";
import { findExternalConflicts } from "@/server/ical/service";
import { createReservation, findConflicts } from "@/server/reservations/service";

export const WA_AUTO_CLOSE_FAILURES = [
  /** Gönderen artık işletme sahibi değil (veya üyelik/işletme pasif). */
  "not_owner",
  /** Öneri artık bekleyen, nedensiz bir sahip kapatması değil ya da değerleri değişti. */
  "changed",
  /** Takvimde çakışan kayıt veya harici (iCal) doluluk var. */
  "conflict",
  /** Villa pasif. */
  "property_inactive",
  /** Tarihler rezervasyon kurallarına uymuyor (ör. çok ileri tarih). */
  "invalid",
  /** Beklenmeyen hata. */
  "error",
] as const;
export type WaAutoCloseFailure = (typeof WA_AUTO_CLOSE_FAILURES)[number];

export type AutoCloseRequest = {
  workspaceId: string;
  /** Gönderenin kullanıcı kimliği (app_wa_message_sender; kilitli mesajdan). */
  userId: string;
  messageId: string;
  itemNo: number;
  propertyId: string;
  checkIn: string;
  checkOut: string;
};

export type AutoCloseResult =
  | { outcome: "applied"; proposalId: string; reservationId: string }
  | { outcome: "failed"; proposalId: string | null; reason: WaAutoCloseFailure };

export type AutoCloser = (req: AutoCloseRequest) => Promise<AutoCloseResult>;

/** Panelde ve blok notunda gösterilen sabit metin (kişisel bilgi içermez). */
export const WA_AUTO_CLOSE_NOTE = "WhatsApp grubundaki sahip talimatıyla otomatik kapatıldı.";

class Stop extends Error {
  constructor(
    readonly reason: WaAutoCloseFailure,
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
};

function classify(err: unknown): WaAutoCloseFailure {
  if (err instanceof Stop) return err.reason;
  if (!isAppError(err)) return "error";
  if (err.code === "CONFLICT") {
    return /pasif/i.test(err.message) ? "property_inactive" : "conflict";
  }
  if (err.code === "VALIDATION") return "invalid";
  if (err.code === "FORBIDDEN") return "not_owner";
  if (err.code === "NOT_FOUND") return "changed";
  return "error";
}

export function createAutoCloser(db: Database): AutoCloser {
  return async (req) => {
    let proposalId: string | null = null;
    try {
      return await withTenant(
        db,
        { userId: req.userId, workspaceId: req.workspaceId },
        async (tx, ctx) => {
          if (ctx.role !== "owner") throw new Stop("not_owner", null);
          const res = await tx.execute<Locked>(sql`
            select id, status, action, property_id,
                   to_char(check_in, 'YYYY-MM-DD') as check_in,
                   to_char(check_out, 'YYYY-MM-DD') as check_out,
                   review_reasons, sender_role
              from wa_calendar_proposals
             where message_id = ${req.messageId}::uuid and item_no = ${req.itemNo}
               and workspace_id = app_current_workspace_id()
             for update`);
          const p = res.rows[0];
          if (!p) throw new Stop("changed", null);
          proposalId = p.id;
          if (
            p.status !== "pending" ||
            p.action !== "close" ||
            (p.review_reasons ?? []).length !== 0 ||
            p.sender_role !== "owner" ||
            p.property_id !== req.propertyId ||
            p.check_in !== req.checkIn ||
            p.check_out !== req.checkOut
          ) {
            throw new Stop("changed", p.id);
          }
          // Çakışma: yazımdan hemen önce yeniden (veritabanı kısıtı ayrıca uygular).
          const internal = await findConflicts(tx, req.propertyId, req.checkIn, req.checkOut);
          const external = await findExternalConflicts(
            tx,
            req.propertyId,
            req.checkIn,
            req.checkOut,
          );
          if (internal.length > 0 || external.length > 0) throw new Stop("conflict", p.id);

          const reservationId = await createReservation(
            tx,
            ctx,
            {
              kind: "block",
              propertyId: req.propertyId,
              checkIn: req.checkIn,
              checkOut: req.checkOut,
              note: WA_AUTO_CLOSE_NOTE,
            },
            { originProposalId: p.id },
          );
          await tx.execute(sql`
            update wa_calendar_proposals
               set status = 'applied',
                   decided_by = app_current_user_id(),
                   decided_at = now(),
                   decision_mode = 'quick',
                   decision_note = ${WA_AUTO_CLOSE_NOTE},
                   applied_reservation_ids = array[${reservationId}::uuid]
             where id = ${p.id}::uuid`);
          await recordAudit(tx, {
            action: "whatsapp.proposal_auto_applied",
            targetType: "whatsapp_proposal",
            targetId: p.id,
            metadata: { property: req.propertyId, reservation: reservationId },
          });
          return { outcome: "applied" as const, proposalId: p.id, reservationId };
        },
      );
    } catch (err) {
      const reason = classify(err);
      const pid = err instanceof Stop ? err.proposalId : proposalId;
      // Sonuç denetim kaydına (ayrı transaction: ilk transaction geri alındı). Sahiplik
      // doğrulanamadıysa yazılamaz; öneri yine panelde bekler.
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
