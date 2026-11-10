/**
 * WhatsApp Asistanı — A2f: mesaj tepkisi kararı (MERKEZİ ve saf fonksiyon).
 *
 * Worker bir mesajı işledikten (öneriler kaydedildikten ve varsa otomatik blok denendikten) SONRA
 * bu fonksiyonla TEK bir tepki seçer; tepki veritabanında yeniden doğrulanır (app_wa_queue_reaction)
 * ve ağ geçidi tarafından mesajın üzerine reaction olarak gönderilir.
 *
 *   done      ✅  istenen takvim işlemi GERÇEKTEN tamamlandı (otomatik blok oluştu).
 *   submitted ☑️  talimat anlaşıldı ve yönetici onayına sunuldu (ör. rezervasyon). Onay DEĞİLDİR.
 *   warning   ⚠️  takvim talimatı var ama anlaşılamadı, tarih/villa belirsiz, çakışma var ya da
 *                  otomatik işlem güvenle tamamlanamadı.
 *   null          tepki yok: gönderen owner/manager değil (yetkisiz), mesaj takvimle ilgili değil
 *                  (öneri yok) ya da yalnız soru ("müsait mi?").
 *
 * Yeşil tik YALNIZ otomatik kapatma servisi "applied" döndürdüyse seçilir; rezervasyon önerisi hiçbir
 * zaman yeşil tik almaz (gerçek rezervasyon yalnız panelde, yönetici onayıyla oluşur).
 */
import type { WaSenderRole } from "@/lib/wa-calendar-parse";
import type { WaReactionKind } from "@/lib/whatsapp-meta";

import type { StoreItem } from "./proposal";

/** Öneriyi "temiz" saymayı engellemeyen (yalnız bilgi veren) ayrıştırıcı / sunucu bayrakları. */
const INFO_FLAGS: ReadonlySet<string> = new Set([
  "year_inferred",
  "villa_missing",
  "villa_name_mismatch",
  "guest_name_missing",
  "end_inclusive",
  "multiple_items",
]);

/** Yönetici onayına sunulmayı engellemeyen inceleme nedenleri (eylem türü ve bilgi bayrağı). */
const SUBMIT_REASONS: ReadonlySet<string> = new Set(["action_requires_review", "flagged"]);

export type ReactionInput = {
  senderRole: WaSenderRole | null;
  /** Worker'ın kaydettiği öğeler (app_wa_store_proposals girdisi). */
  items: readonly StoreItem[];
  /** Kaydedilen öneri sayısı (0: mesaj öneri üretmedi / yok sayıldı). */
  stored: number;
  /** Otomatik kapatma sonucu; denenmediyse undefined. */
  autoClose?: "applied" | "failed";
};

/** Öğe yönetici onayına "anlaşılmış" olarak sunulabilir mi? */
export function isCleanItem(it: StoreItem): boolean {
  return (
    it.action !== null &&
    it.property_id !== null &&
    it.check_in !== null &&
    it.check_out !== null &&
    it.review_reasons.every((r) => SUBMIT_REASONS.has(r)) &&
    it.flags.every((f) => INFO_FLAGS.has(f))
  );
}

const isQuestion = (it: StoreItem) => it.action === null && it.flags.includes("question");

export function decideReaction(input: ReactionInput): WaReactionKind | null {
  // Yetkisiz gönderen (staff, kayıtsız veya doğrulanmamış numara): tepki yok.
  if (input.senderRole !== "owner" && input.senderRole !== "manager") return null;
  if (input.stored === 0 || input.items.length === 0) return null;
  const actionable = input.items.filter((it) => !isQuestion(it));
  if (actionable.length === 0) return null; // yalnız soru
  if (input.autoClose === "applied") return "done";
  if (input.autoClose === "failed") return "warning";
  return actionable.every(isCleanItem) ? "submitted" : "warning";
}
