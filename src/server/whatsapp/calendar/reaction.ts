/**
 * WhatsApp Asistanı — A2f / B: mesaj tepkisi kararı (MERKEZİ ve saf fonksiyon).
 *
 * Worker bir mesajı işledikten (öneriler kaydedildikten ve varsa otomatik blok denendikten) SONRA
 * bu fonksiyonla TEK bir tepki seçer; tepki veritabanında yeniden doğrulanır (app_wa_queue_reaction)
 * ve ağ geçidi tarafından mesajın üzerine reaction olarak gönderilir.
 *
 *   done      ✅  istenen takvim işlemi GERÇEKTEN tamamlandı (otomatik blok oluştu).
 *   warning   ⚠️  takvim talimatı anlaşıldı ama uygulanamadı: tarih/villa belirsiz, çakışma, bu
 *                  aşamada desteklenmeyen işlem (rezervasyon, açma, iptal) ya da otomatik işlem
 *                  güvenle tamamlanamadı.
 *   null          tepki yok: gönderen yetkisiz (engelli / belirlenemedi; veritabanı zaten eler),
 *                  mesaj takvimle ilgili değil (öneri yok) ya da yalnız soru ("müsait mi?").
 *
 * ☑️ (submitted, "onay bekliyor") B aşamasından itibaren HİÇ seçilmez: işletme panelinde onay
 * ekranı yoktur. Veritabanı da submitted tepkisini reddeder (drizzle/0047).
 */
import type { WaSenderRole } from "@/lib/wa-calendar-parse";
import type { WaReactionKind } from "@/lib/whatsapp-meta";

import type { StoreItem } from "./proposal";

export type ReactionInput = {
  senderRole: WaSenderRole | null;
  /** Worker'ın kaydettiği öğeler (app_wa_store_proposals girdisi). */
  items: readonly StoreItem[];
  /** Kaydedilen öneri sayısı (0: mesaj öneri üretmedi / yok sayıldı). */
  stored: number;
  /** Otomatik kapatma sonucu; denenmediyse undefined. */
  autoClose?: "applied" | "failed";
};

const isQuestion = (it: StoreItem) => it.action === null && it.flags.includes("question");

export function decideReaction(input: ReactionInput): WaReactionKind | null {
  // Yetkisiz gönderen (engelli veya numarası belirlenemeyen): tepki yok.
  if (input.senderRole === null) return null;
  if (input.stored === 0 || input.items.length === 0) return null;
  const actionable = input.items.filter((it) => !isQuestion(it));
  if (actionable.length === 0) return null; // yalnız soru
  if (input.autoClose === "applied") return "done";
  // Anlaşılan ama uygulanmayan (otomatik işlem denenmedi veya başarısız) talimat: ⚠️.
  return "warning";
}
