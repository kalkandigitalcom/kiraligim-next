/**
 * WhatsApp Asistanı — A2e: hangi öneri panel onayı beklemeden takvime işlenebilir? (saf fonksiyon)
 *
 * YALNIZ şu durumda: mesajda TEK öğe var ve bu öğe
 *  - açık bir kapatma talimatı (action = close; soru, belirsiz veya çelişen eylem değil),
 *  - işletme SAHİBİNİN doğrulanmış numarasından (manager ve staff → panel onayı),
 *  - grubun eşleştirildiği villa için (grup villasız ise veya başka villa yazıldıysa → panel),
 *  - iki tarihi de açıkça yazılmış (yıl tahmini dışında bayrak yok),
 *  - çakışmasız (app_wa_busy boş),
 *  - inceleme nedeni YOK (reviewRequirement: güven bandı yüksek).
 * Kural bilinçli olarak dardır: şüphede öneri panelde onay bekler. Yazım anında veritabanı ve
 * rezervasyon servisi her şeyi yeniden denetler (auto-close.ts).
 */
import type { WaSenderRole } from "@/lib/wa-calendar-parse";

import type { StoreItem } from "./proposal";

/** Otomatik kapatmayı engellemeyen bayraklar ("villa_missing" yalnız grubun tek villasıyla). */
const ALLOWED_FLAGS: ReadonlySet<string> = new Set(["year_inferred", "villa_missing"]);

export function autoCloseCandidate(
  items: readonly StoreItem[],
  ctx: { senderRole: WaSenderRole | null; groupPropertyId: string | null },
): StoreItem | null {
  if (items.length !== 1) return null;
  const it = items[0]!;
  if (ctx.senderRole !== "owner") return null;
  if (!ctx.groupPropertyId || it.property_id !== ctx.groupPropertyId) return null;
  if (it.action !== "close") return null;
  if (it.review_reasons.length !== 0 || it.band !== "high") return null;
  if (it.villa_resolution !== "named" && it.villa_resolution !== "single") return null;
  if (!it.check_in || !it.check_out || it.check_out <= it.check_in) return null;
  if (it.conflicts.length !== 0) return null;
  if (it.flags.some((f) => !ALLOWED_FLAGS.has(f))) return null;
  return it;
}
