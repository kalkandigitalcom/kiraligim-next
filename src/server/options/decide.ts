/**
 * Opsiyon — WhatsApp mesajından opsiyon kararı (saf; veritabanı ve yan etki yok).
 *
 * Girdi: worker'ın mesaj için ZATEN kaydettiği öğeler (wa_calendar_proposals; drizzle/0072
 * app_option_message_items ile okunur) ve mesaj metni. Niyet, iptal nedeni, süre ve karar
 * ./intent modülünden gelir (doğal Türkçe, yazım hataları, süre ayrıştırıcısı v2). Çıktı
 * app_wa_option_apply öğeleridir; veritabanı her şeyi YENİDEN denetler (otomasyon anahtarı,
 * çakışma, açık opsiyon, süre, hedef) ve "apply"ı gerekirse onaya düşürür, asla yükseltmez.
 *
 * Kurallar:
 *   - Yalnız DOĞRULANMIŞ sahip / yöneticinin mesajı işlem üretir. Personel, doğrulanmamış
 *     katılımcı veya worker'ın öğe kaydetmediği mesaj: işlem YOK (worker'ın ⚠️'si aynen kalır).
 *   - Otomatik uygulama yalnız tek anlamlı oluşturma, tarihli ve nedeni net iptal, süresi net
 *     uzatma ve tek hedefli tarih değişikliği kalıplarında (Faz B). Kesinleştirme, "süresi doldu",
 *     belirsiz tarih / süre / niyet ve tanınmayan sözcük içeren oluşturma onaya / açıklamaya düşer.
 *   - Faz B: uzatma / tarih değişikliği worker öğesi olmadan da üretilebilir; veritabanı göndereni
 *     worker'ınkiyle aynı kuralla yeniden denetler.
 *   - Soru ve olumsuz ifade işlem üretmez. panel_cancel WhatsApp'tan gelemez.
 */
import { analyzeOptionMessage, cancelReasonOf } from "./intent";

export { cancelReasonOf };

/** app_option_message_items satırı (worker'ın kaydettiği öğe; metin ve misafir bilgisi yok). */
export type OptionMessageItem = {
  itemNo: number;
  parserVersion: number;
  checkIn: string | null;
  checkOut: string | null;
  propertyId: string | null;
  villaResolution: string;
  flags: string[];
  senderRole: string;
  senderVerified: boolean;
};

/** app_wa_option_apply öğesi (JSON alan adları veritabanı fonksiyonuyla aynı). */
export type OptionApplyItem = {
  item_no: number;
  intent: "create" | "cancel" | "convert" | "extend" | "reschedule";
  decision: "apply" | "ask" | "ignore";
  reasons: string[];
  check_in: string | null;
  check_out: string | null;
  expires_in_minutes: number | null;
  end_reason: "customer_declined" | "owner_cancelled" | null;
  /** Faz B: yalnız tarih değişikliğinde, mesajda eski aralık da yazılıysa. */
  old_check_in?: string | null;
  old_check_out?: string | null;
};

export type OptionDecision =
  | { kind: "none"; why: "sender_not_allowed" | "no_items" | "not_option" }
  | { kind: "items"; items: OptionApplyItem[] };

const VERIFIED_ROLES = new Set(["owner", "manager"]);

/**
 * Mesajın opsiyon kararı. `items`: worker'ın kaydettiği öğeler; `groupPropertyId`: grubun villası.
 * Niyet, süre ve karar kuralları ./intent'tedir (saf, deterministik).
 */
export function decideOptionMessage(input: {
  body: string;
  sentAt: Date;
  items: readonly OptionMessageItem[];
  groupPropertyId: string | null;
}): OptionDecision {
  if (
    input.items.length > 0 &&
    !input.items.every((i) => i.senderVerified && VERIFIED_ROLES.has(i.senderRole))
  ) {
    return { kind: "none", why: "sender_not_allowed" };
  }
  const r = analyzeOptionMessage({
    body: input.body,
    sentAt: input.sentAt,
    items: input.items,
    groupPropertyId: input.groupPropertyId,
  });
  // Worker öğesi yoksa YALNIZ uzatma / tarih değişikliği (Faz B; "2 saat daha bekleyelim" gibi
  // tarihsiz mesajlar). Gönderen veritabanında yeniden denetlenir (doğrulanmış sahip / yönetici).
  if (
    input.items.length === 0 &&
    (r === null || r.decision === "ignore" || (r.intent !== "extend" && r.intent !== "reschedule"))
  ) {
    return { kind: "none", why: "no_items" };
  }
  if (r === null) return { kind: "none", why: "not_option" };
  return {
    kind: "items",
    items: [
      {
        item_no: 0,
        intent: r.intent,
        decision: r.decision,
        reasons: r.reasons,
        check_in: r.checkIn,
        check_out: r.checkOut,
        expires_in_minutes: r.expiresInMinutes,
        end_reason: r.endReason,
        ...(r.oldCheckIn !== null
          ? { old_check_in: r.oldCheckIn, old_check_out: r.oldCheckOut }
          : {}),
      },
    ],
  };
}
