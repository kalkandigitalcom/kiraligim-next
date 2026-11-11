/**
 * WhatsApp Asistanı — A2e / B: hangi öneri takvime otomatik işlenebilir? (saf fonksiyon)
 *
 * YALNIZ şu durumda: mesajda TEK öğe var ve bu öğe
 *  - açık bir kapatma talimatı (action = close; soru, belirsiz veya çelişen eylem değil),
 *  - yetkili gönderenden: bağlı ve aktif grubun Super Admin tarafından engellenmemiş herhangi bir
 *    katılımcısı (B aşaması; sahip olması gerekmez — işlem işletme sahibi adına yapılır),
 *  - grubun eşleştirildiği villa için (grup villasız ise → panel; mesajda yazan ad önemsizdir:
 *    grup eşleştirmesi kesin kaynaktır, resolve.ts),
 *  - iki tarihi de açıkça yazılmış (yıl tahmini dışında bayrak yok),
 *  - çakışmasız (app_wa_busy boş),
 *  - inceleme nedeni YOK (reviewRequirement: güven bandı yüksek).
 * Kural bilinçli olarak dardır: şüphede öneri panelde onay bekler. Yazım anında veritabanı ve
 * rezervasyon servisi her şeyi yeniden denetler (auto-close.ts).
 */
import type { WaSenderRole } from "@/lib/wa-calendar-parse";

import type { StoreItem } from "./proposal";

/** Otomatik kapatmayı engellemeyen (yalnız bilgi veren) bayraklar. */
const ALLOWED_FLAGS: ReadonlySet<string> = new Set([
  "year_inferred",
  "villa_missing",
  // Mesajda başka bir ad yazılmış; grup eşleştirmesi esas alındı (resolve.ts).
  "villa_name_mismatch",
  // Ayrıştırıcı v4 (merkezi tarih modülü): tarih tek anlamlı çözüldü; yalnız nasıl çözüldüğü.
  "end_inclusive",
  "month_inferred",
  "date_relative",
  "date_corrected",
  "nights_count",
  "day_list",
]);

export function autoCloseCandidate(
  items: readonly StoreItem[],
  ctx: { senderRole: WaSenderRole | null; groupPropertyId: string | null },
): StoreItem | null {
  if (items.length !== 1) return null;
  const it = items[0]!;
  if (ctx.senderRole === null) return null;
  if (!ctx.groupPropertyId || it.property_id !== ctx.groupPropertyId) return null;
  if (it.action !== "close") return null;
  if (it.review_reasons.length !== 0 || it.band !== "high") return null;
  if (it.villa_resolution !== "named" && it.villa_resolution !== "single") return null;
  if (!it.check_in || !it.check_out || it.check_out <= it.check_in) return null;
  if (it.conflicts.length !== 0) return null;
  if (it.flags.some((f) => !ALLOWED_FLAGS.has(f))) return null;
  return it;
}

/**
 * Aşama 2: hangi öğe takvimi doğrudan AÇABİLİR (blokları kaldırabilir)? (saf fonksiyon)
 *
 * YALNIZ: mesajda TEK öğe; açık bir açma talimatı (action = open; soru veya çelişen eylem değil);
 * yetkili grup katılımcısı; grubun villası; iki tarih açıkça yazılmış; inceleme nedeni yok
 * (güven bandı yüksek). Takvimdeki dolu kayıtlar (conflicts) açma için engel değil hedeftir;
 * hangi kayıtların kaldırılacağına yazım anında auto-open.ts karar verir (yalnız TAMAMEN aralıkta
 * kalan BLOKLAR; kısmi çakışma veya blok yoksa işlem yok).
 */
export function autoOpenCandidate(
  items: readonly StoreItem[],
  ctx: { senderRole: WaSenderRole | null; groupPropertyId: string | null },
): StoreItem | null {
  if (items.length !== 1) return null;
  const it = items[0]!;
  if (ctx.senderRole === null) return null;
  if (!ctx.groupPropertyId || it.property_id !== ctx.groupPropertyId) return null;
  if (it.action !== "open") return null;
  if (it.review_reasons.length !== 0 || it.band !== "high") return null;
  if (it.villa_resolution !== "named" && it.villa_resolution !== "single") return null;
  if (!it.check_in || !it.check_out || it.check_out <= it.check_in) return null;
  if (it.flags.some((f) => !ALLOWED_FLAGS.has(f))) return null;
  return it;
}
