/**
 * WhatsApp Asistanı — v6: bağlı gruptaki tarih değiştirme talimatı ("20-25 Temmuz rezervasyonu
 * 22-27 Temmuz olarak değişti") mevcut kaydın tarihlerini taşır.
 *
 * Worker (dist/wa-calendar.js) öneriyi kaydettikten SONRA, yalnız uygunluk kuralını
 * (calendar/auto-close-rule.ts → autoChangeCandidate) geçen değiştirme önerileri için çağırır.
 * Next.js'e ve "server-only"e bağımlı DEĞİLDİR. Talimatı grubun engellenmemiş her katılımcısı
 * verebilir (B aşaması); işlem işletme SAHİBİ adına yapılır.
 *
 * Kapsam:
 *  - Hedef: grubun villasında ESKİ aralıkla [giriş, çıkış) BİREBİR eşleşen TEK aktif kayıt
 *    (rezervasyon veya blok). Misafir adı kullanılmaz; kayıt yalnız tarihle bulunur.
 *  - Aynı kayıt güncellenir (yeni kayıt oluşturulmaz); misafir, kişi sayısı, tutar, kaynak, durum
 *    ve notlar korunur (rescheduleReservation yalnız tarihleri değiştirir).
 *  - İşlem YAPILMAYAN durumlar (⚠️, takvim değişmez):
 *      no_target : eski aralıkta kayıt yok (harici takvim/iCal olayı tek başına hedef olamaz);
 *      multiple  : eski aralıkla örtüşen birden çok kayıt (tahmin edilmez);
 *      partial   : tek kayıt var ama tarihleri eski aralıkla birebir aynı değil;
 *      external  : kayıt Airbnb/Booking kaynaklı (dış platformda değişmiş gibi gösterilmez);
 *      occupied  : yeni aralık başka bir kayıtla veya harici takvim (iCal) doluluğuyla çakışıyor;
 *      invalid   : yeni aralık tarih kurallarına uymuyor (gece sınırı, tarih penceresi).
 *  - Harici takvim (iCal) olayları hiçbir koşulda değiştirilmez.
 *
 * Güvenlik ve bütünlük:
 *  - Kilit sırası: GRUP (FOR SHARE, 0045) → ÖNERİ (FOR UPDATE) → hedef kayıtlar (FOR UPDATE,
 *    kimlik sırasıyla). Super Admin grup işlemleri ve eşzamanlı WhatsApp mesajları sıralanır.
 *  - Tarih değişikliği ve önerinin "applied" (decision_mode = 'quick') olması TEK transaction'dadır;
 *    herhangi bir hata hepsini geri alır. Çakışma ayrıca veritabanı kısıtıyla garanti edilir
 *    (reservations_no_overlap, harici takvim tetikleyicisi). Karar verilmiş öneri yeniden işlenmez
 *    (idempotent): aynı mesaj ikinci kez işlenmez, işlense de değişiklik ikinci kez yapılmaz.
 *  - Mesaj metni, misafir veya numara kaydedilmez/loglanmaz.
 */
import { sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { isAppError } from "@/lib/errors";
import { WA_SENDER_ROLES, type WaSenderRole } from "@/lib/wa-calendar-parse";
import { recordAudit } from "@/server/audit/record";
import { findExternalConflicts } from "@/server/ical/service";
import { findConflicts, rescheduleReservation } from "@/server/reservations/service";

export const WA_AUTO_CHANGE_FAILURES = [
  /** İşlemi yapacak kullanıcı artık işletme sahibi değil (veya üyelik/işletme pasif). */
  "not_owner",
  /** Öneri artık bekleyen, nedensiz bir değiştirme değil; grup değişti ya da değerler farklı. */
  "changed",
  /** Eski aralıkta kayıt yok. */
  "no_target",
  /** Eski aralıkla örtüşen birden çok kayıt. */
  "multiple",
  /** Tek kayıt var ama tarihleri eski aralıkla birebir aynı değil. */
  "partial",
  /** Airbnb/Booking kaynaklı rezervasyon: dış platformda değiştirilmiş gibi gösterilmez. */
  "external",
  /** Yeni aralık dolu (başka kayıt veya harici takvim). */
  "occupied",
  /** Yeni aralık tarih kurallarına uymuyor. */
  "invalid",
  /** Beklenmeyen hata. */
  "error",
] as const;
export type WaAutoChangeFailure = (typeof WA_AUTO_CHANGE_FAILURES)[number];

export type AutoChangeRequest = {
  workspaceId: string;
  /** İşlemi yapan kullanıcı: işletme sahibi (app_wa_message_actor; kilitli mesajdan). */
  userId: string;
  messageId: string;
  itemNo: number;
  propertyId: string;
  /** Eski aralık (kaydın bugünkü tarihleri). */
  oldCheckIn: string;
  oldCheckOut: string;
  /** Yeni aralık. */
  checkIn: string;
  checkOut: string;
};

export type AutoChangeResult =
  | { outcome: "applied"; proposalId: string; reservationId: string }
  | { outcome: "failed"; proposalId: string | null; reason: WaAutoChangeFailure };

export type AutoChanger = (req: AutoChangeRequest) => Promise<AutoChangeResult>;

/** Öneri karar notu (kişisel bilgi içermez). */
export const WA_AUTO_CHANGE_NOTE = "WhatsApp grubundaki talimatla kaydın tarihleri değiştirildi.";

/** Dış platformda yönetilen rezervasyon kaynakları: tarihleri buradan taşınmaz. */
const EXTERNAL_SOURCES: ReadonlySet<string> = new Set(["airbnb", "booking"]);

class Stop extends Error {
  constructor(
    readonly reason: WaAutoChangeFailure,
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
  old_check_in: string | null;
  old_check_out: string | null;
  review_reasons: string[];
  sender_role: string;
  group_id: string;
};

type Target = {
  id: string;
  kind: string;
  source: string | null;
  check_in: string;
  check_out: string;
};

function classify(err: unknown): WaAutoChangeFailure {
  if (err instanceof Stop) return err.reason;
  if (!isAppError(err)) return "error";
  if (err.code === "FORBIDDEN") return "not_owner";
  if (err.code === "VALIDATION") return "invalid";
  // Tarih yazımında çakışma (eşzamanlı bir kayıt, harici takvim): veritabanı kısıtı reddetti.
  if (err.code === "CONFLICT") return "occupied";
  if (err.code === "NOT_FOUND") return "changed";
  return "error";
}

export function createAutoChanger(db: Database): AutoChanger {
  return async (req) => {
    let proposalId: string | null = null;
    try {
      return await withTenant(
        db,
        { userId: req.userId, workspaceId: req.workspaceId },
        async (tx, ctx) => {
          if (ctx.role !== "owner") throw new Stop("not_owner", null);
          // Kilit sırası: GRUP → ÖNERİ → kayıtlar (otomatik kapatma/açma ile aynı sıra).
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
                   to_char(old_check_in, 'YYYY-MM-DD') as old_check_in,
                   to_char(old_check_out, 'YYYY-MM-DD') as old_check_out,
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
            p.action !== "change" ||
            (p.review_reasons ?? []).length !== 0 ||
            !(WA_SENDER_ROLES as readonly string[]).includes(p.sender_role) ||
            p.property_id !== req.propertyId ||
            p.check_in !== req.checkIn ||
            p.check_out !== req.checkOut ||
            p.old_check_in !== req.oldCheckIn ||
            p.old_check_out !== req.oldCheckOut
          ) {
            throw new Stop("changed", p.id);
          }

          // Hedef: grubun villasında ESKİ aralıkla örtüşen aktif kayıtlar (kimlik sırasıyla
          // kilitlenir). Yalnız birebir eşleşen TEK kayıt taşınır; aksi hâlde tahmin yok.
          const overlapping = (
            await tx.execute<Target>(sql`
              select r.id, r.kind, r.source,
                     to_char(r.check_in, 'YYYY-MM-DD') as check_in,
                     to_char(r.check_out, 'YYYY-MM-DD') as check_out
                from reservations r
               where r.workspace_id = app_current_workspace_id()
                 and r.property_id = ${req.propertyId}::uuid
                 and r.status in ('pending', 'confirmed')
                 and daterange(r.check_in, r.check_out, '[)')
                     && daterange(${req.oldCheckIn}::date, ${req.oldCheckOut}::date, '[)')
               order by r.id
               for update`)
          ).rows;
          if (overlapping.length === 0) throw new Stop("no_target", p.id);
          if (overlapping.length > 1) throw new Stop("multiple", p.id);
          const target = overlapping[0]!;
          if (target.check_in !== req.oldCheckIn || target.check_out !== req.oldCheckOut) {
            throw new Stop("partial", p.id);
          }
          if (target.kind === "reservation" && EXTERNAL_SOURCES.has(target.source ?? "")) {
            throw new Stop("external", p.id);
          }

          // Yeni aralık: taşınan kaydın kendisi dışında boş olmalı (kayıt ve harici takvim).
          // Veritabanı kısıtı eşzamanlı yazımlara karşı ayrıca garanti eder.
          const busy = await findConflicts(
            tx,
            req.propertyId,
            req.checkIn,
            req.checkOut,
            target.id,
          );
          const external = await findExternalConflicts(
            tx,
            req.propertyId,
            req.checkIn,
            req.checkOut,
          );
          if (busy.length > 0 || external.length > 0) throw new Stop("occupied", p.id);

          const r = await rescheduleReservation(tx, ctx, target.id, {
            checkIn: req.checkIn,
            checkOut: req.checkOut,
          });
          if (!r.changed) throw new Stop("changed", p.id);
          await tx.execute(sql`
            update wa_calendar_proposals
               set status = 'applied',
                   decided_by = app_current_user_id(),
                   decided_at = now(),
                   decision_mode = 'quick',
                   decision_note = ${WA_AUTO_CHANGE_NOTE},
                   target_reservation_ids = ${`{${target.id}}`}::uuid[],
                   applied_reservation_ids = ${`{${target.id}}`}::uuid[]
             where id = ${p.id}::uuid`);
          await recordAudit(tx, {
            action: "whatsapp.proposal_auto_changed",
            targetType: "whatsapp_proposal",
            targetId: p.id,
            metadata: {
              property: req.propertyId,
              reservation: target.id,
              kind: target.kind as "reservation" | "block",
              group: groupId,
              sender_role: p.sender_role as WaSenderRole,
            },
          });
          return { outcome: "applied" as const, proposalId: p.id, reservationId: target.id };
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
