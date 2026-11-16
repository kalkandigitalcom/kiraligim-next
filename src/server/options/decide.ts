/**
 * Opsiyon Aşama 3d — WhatsApp mesajından opsiyon kararı (saf; veritabanı ve yan etki yok).
 *
 * Girdi: worker'ın mesaj için ZATEN kaydettiği öğeler (wa_calendar_proposals; drizzle/0072
 * app_option_message_items ile okunur) ve mesaj metni. Karar, Aşama 2 gölge modunun aynı saf
 * fonksiyonuyla (analyzeOptionShadow; DEĞİŞTİRİLMEDEN içe aktarılır) üretilir; üstüne 3d kuralları
 * eklenir. Çıktı app_wa_option_apply öğeleridir; veritabanı her şeyi YENİDEN denetler (anahtarlar,
 * çakışma, açık opsiyon, süre, hedef) ve "apply"ı gerekirse onaya düşürür, asla yükseltmez.
 *
 * 3d kuralları (16 Kasım 2026 kararları):
 *   - Yalnız DOĞRULANMIŞ sahip / yöneticinin mesajı işlem üretir. Personel, doğrulanmamış
 *     katılımcı veya worker'ın öğe kaydetmediği mesaj: işlem YOK (worker'ın ⚠️'si aynen kalır).
 *   - Oluşturma ve iptal; (Aşama 3e) kesinleştirme ("ödeme alındı", "kesinleşti") HER ZAMAN Super
 *     Admin onayına düşer (otomatik uygulanmaz; misafir bilgisi onayda girilir).
 *   - İptal nedeni: "vazgeçti", "müşteri almadı", "düştü" → customer_declined; "iptal", "kaldır" →
 *     owner_cancelled; ikisi birden ya da hiçbiri → belirsiz, otomatik uygulanmaz (onay).
 *     panel_cancel WhatsApp'tan gelemez.
 *   - "Süresi doldu / bitti" ve benzeri: otomatik iptal (ya da oluşturma) YOK, Super Admin onayı.
 *     Süre dolumunu görev yapar.
 *   - Tarihsiz iptal ("Opsiyon iptal.") otomatik uygulanmaz: hedef yalnız "gruptaki tek açık
 *     opsiyon" çıkarımıyla bulunabilir → onay (date_missing).
 *   - Soru / olumsuz ifade işlem üretmez; temkinli, çok aralıklı, tarihsiz, villa / tarih belirsiz
 *     mesaj onaya düşer (gölge kuralları).
 */
import type { ShadowItem } from "@/server/whatsapp/calendar/option-shadow";
import { analyzeOptionShadow } from "@/server/whatsapp/calendar/option-shadow";
import type { StoreItem } from "@/server/whatsapp/calendar/proposal";
import { foldTr } from "@/lib/wa-calendar-parse";

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
  intent: "create" | "cancel" | "convert";
  decision: "apply" | "ask" | "ignore";
  reasons: string[];
  check_in: string | null;
  check_out: string | null;
  expires_in_minutes: number | null;
  end_reason: "customer_declined" | "owner_cancelled" | null;
};

export type OptionDecision =
  | { kind: "none"; why: "sender_not_allowed" | "no_items" | "not_option" }
  | { kind: "items"; items: OptionApplyItem[] };

const VERIFIED_ROLES = new Set(["owner", "manager"]);

const WITHDRAWAL = /\bvazgec\w*/;
const WITHDRAWAL_NEGATED = /\bvazgec(?:me(?!k)|mey|mem|ilme)\w*/g;
const NOT_TAKEN = /\b(?:musteri|misafir)\s+almadi\b/;
const DROPPED = /\bdustu\b/;
const OWNER_CANCEL = /\biptal\w*|\bkaldir\w*/;
const EXPIRED = /\bsuresi\s+(?:dol|bit|gec)\w*|\bsure\s+(?:doldu|bitti|gecti)\b/;

/** İptal nedeni: tek ve net olmalı; ikisi birden ya da hiçbiri → null (belirsiz). */
export function cancelReasonOf(body: string): "customer_declined" | "owner_cancelled" | null {
  const f = foldTr(body);
  const customer =
    WITHDRAWAL.test(f.replace(WITHDRAWAL_NEGATED, " ")) || NOT_TAKEN.test(f) || DROPPED.test(f);
  const owner = OWNER_CANCEL.test(f);
  if (customer && !owner) return "customer_declined";
  if (owner && !customer) return "owner_cancelled";
  return null;
}

/** Gölge analizinin okuduğu alanlar dışındakiler nötr değerle doldurulur (yalnız okuma). */
function asStoreItem(i: OptionMessageItem): StoreItem {
  return {
    item_no: i.itemNo,
    parser_version: i.parserVersion,
    message_excerpt: "",
    action: null,
    villa_name_raw: null,
    property_id: i.propertyId,
    villa_resolution: i.villaResolution as StoreItem["villa_resolution"],
    candidate_property_ids: [],
    check_in: i.checkIn,
    check_out: i.checkOut,
    reservation_status: null,
    flags: i.flags,
    conflicts: [],
    score: 0,
    band: "low",
    review_reasons: [],
  } as unknown as StoreItem;
}

/**
 * Mesajın opsiyon kararı. `items`: worker'ın kaydettiği öğeler; `groupPropertyId`: grubun villası.
 */
export function decideOptionMessage(input: {
  body: string;
  sentAt: Date;
  items: readonly OptionMessageItem[];
  groupPropertyId: string | null;
}): OptionDecision {
  if (input.items.length === 0) return { kind: "none", why: "no_items" };
  if (!input.items.every((i) => i.senderVerified && VERIFIED_ROLES.has(i.senderRole))) {
    return { kind: "none", why: "sender_not_allowed" };
  }
  const shadow: ShadowItem[] = analyzeOptionShadow({
    body: input.body,
    sentAt: input.sentAt,
    items: input.items.map(asStoreItem),
    groupPropertyId: input.groupPropertyId,
  });
  if (shadow.length === 0) return { kind: "none", why: "not_option" };

  const out: OptionApplyItem[] = [];
  for (const s of shadow) {
    if (s.intent !== "create" && s.intent !== "cancel" && s.intent !== "convert") continue; // unknown
    const reasons = new Set<string>(s.reasons);
    let decision = s.decision;
    let endReason: OptionApplyItem["end_reason"] = null;
    const expiredPhrase = EXPIRED.test(foldTr(input.body));
    // "Süresi doldu / bitti" hiçbir niyetle otomatik işlem üretmez (oluşturma da sayılmaz).
    if (decision !== "ignore" && expiredPhrase) {
      reasons.add("intent_unclear");
      decision = "ask";
    }
    // Tarihsiz iptal: hedef yalnız "gruptaki tek açık opsiyon" çıkarımıyla bulunur → otomatik değil.
    if (s.intent === "cancel" && decision !== "ignore" && !s.check_in) {
      reasons.add("date_missing");
      decision = "ask";
    }
    // Kesinleştirme (Aşama 3e): asla otomatik değil; Super Admin onayı (misafir bilgisi orada).
    if (s.intent === "convert" && decision !== "ignore") decision = "ask";
    // İptal nedeni ("süresi doldu" iptalinde yazılmaz: onaya düşer).
    if (s.intent === "cancel" && decision !== "ignore" && !expiredPhrase) {
      endReason = cancelReasonOf(input.body);
      if (endReason === null) {
        reasons.add("intent_unclear");
        decision = "ask";
      }
    }
    out.push({
      item_no: s.item_no,
      intent: s.intent,
      decision,
      reasons: [...reasons].sort(),
      check_in: s.check_in,
      check_out: s.check_out,
      expires_in_minutes: s.intent === "create" ? s.expires_in_minutes : null,
      end_reason: endReason,
    });
  }
  return out.length === 0 ? { kind: "none", why: "not_option" } : { kind: "items", items: out };
}
