/**
 * WhatsApp Asistanı — A2c: worker'ın app_wa_store_proposals'a gönderdiği öğe (saf fonksiyon).
 *
 * Girdi: ayrıştırıcı öğesi, villa çözümü (resolveProposal), çakışma özeti (app_wa_busy) ve
 * gönderen rolü. Çıktı: veritabanı CHECK sınırlarına uyan JSON nesnesi (alıntı ≤ 500, villa adı
 * ≤ 120 karakter, diziler ≤ 20, tarihler tutarlı, rezervasyon durumu yalnız reserve için).
 *
 * İnceleme nedenleri reviewRequirement ile hesaplanır; veritabanı staff ve grup dışı villa
 * nedenlerini ayrıca kendisi ekler (worker unutsa bile).
 */
import {
  type WaCalendarItem,
  type WaSenderRole,
  WA_CALENDAR_PARSER_VERSION,
  reviewRequirement,
} from "@/lib/wa-calendar-parse";
import { WA_PROPOSAL_LIMITS as PL } from "@/lib/whatsapp-meta";

import { type VillaResolutionResult, villaReviewContext } from "./resolve";

/** Yalnız bilgi veren bayraklar (sınır aşılırsa ilk atılanlar). */
const INFO_ONLY_STORE_FLAGS: ReadonlySet<string> = new Set([
  "year_inferred",
  "villa_missing",
  "villa_name_mismatch",
  "multiple_items",
  "end_inclusive",
  "month_inferred",
  "date_relative",
  "date_corrected",
  "nights_count",
  "day_list",
  "guest_name_missing",
]);

/** app_wa_busy satırı (misafir bilgisi yok). */
export type BusyRow = {
  kind: string;
  recordId: string;
  checkIn: string;
  checkOut: string;
  status: string;
};

/** app_wa_store_proposals öğesi (JSON alan adları veritabanı fonksiyonuyla aynı). */
export type StoreItem = {
  item_no: number;
  parser_version: number;
  message_excerpt: string;
  action: WaCalendarItem["action"];
  villa_name_raw: string | null;
  property_id: string | null;
  villa_resolution: VillaResolutionResult["resolution"];
  candidate_property_ids: string[];
  check_in: string | null;
  check_out: string | null;
  reservation_status: "confirmed" | "pending" | null;
  flags: string[];
  conflicts: {
    kind: string;
    record_id: string;
    check_in: string;
    check_out: string;
    status: string;
  }[];
  score: number;
  band: "high" | "medium" | "low";
  review_reasons: string[];
};

/** Unicode kod noktasına göre kısaltır (vekil çiftleri bölünmez; PostgreSQL length() ile aynı). */
export function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

/** Çakışma özetinin sorgulanabileceği aralık: iki tarih dolu, çıkış girişten sonra, ≤ maxNights. */
export function busyRange(
  item: Pick<WaCalendarItem, "checkIn" | "checkOut">,
  maxNights: number,
): { from: string; to: string } | null {
  const { checkIn, checkOut } = item;
  if (!checkIn || !checkOut || checkOut <= checkIn) return null;
  const nights = (Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 864e5;
  if (!Number.isFinite(nights) || nights < 1 || nights > maxNights) return null;
  return { from: checkIn, to: checkOut };
}

/**
 * Çakışma yok mu? close/reserve: aralıkta dolu kayıt yoksa. open/cancel: dolu kayıt beklenen
 * hedeftir, çakışma sayılmaz. Çakışma sorgulanamadıysa (busy === null) temkinli: false.
 */
export function conflictFreeFor(action: WaCalendarItem["action"], busy: readonly BusyRow[] | null) {
  if (busy === null) return false;
  if (action === "open" || action === "cancel") return true;
  return busy.length === 0;
}

export function buildStoreItem(input: {
  item: WaCalendarItem;
  itemNo: number;
  villa: VillaResolutionResult;
  busy: readonly BusyRow[] | null;
  senderRole: WaSenderRole | null;
}): StoreItem {
  const { item, villa, busy } = input;
  const conflictFree = conflictFreeFor(item.action, busy);
  const decision = reviewRequirement(item, {
    ...villaReviewContext(villa),
    senderRole: input.senderRole,
    conflictFree,
  });

  const checkIn = item.checkIn;
  const checkOut = checkIn && item.checkOut && item.checkOut > checkIn ? item.checkOut : null;
  const villaName = item.villaName?.trim() ? clip(item.villaName.trim(), PL.villaNameMax) : null;
  const excerpt = clip(item.excerpt.trim(), PL.excerptMax) || "-";
  const all = [...new Set<string>([...item.flags, ...villa.serverFlags])];
  // Veritabanı sınırı (≤ 20). Pratikte aşılmaz; aşılırsa işlemi ENGELLEYEN bayraklar korunur,
  // yalnız bilgi bayrakları atılır (bayrak düşürülerek otomatik işleme yol açılmaz).
  const flags =
    all.length <= PL.arrayMax
      ? all
      : [
          ...all.filter((f) => !INFO_ONLY_STORE_FLAGS.has(f)),
          ...all.filter((f) => INFO_ONLY_STORE_FLAGS.has(f)),
        ].slice(0, PL.arrayMax);

  return {
    item_no: input.itemNo,
    parser_version: WA_CALENDAR_PARSER_VERSION,
    message_excerpt: excerpt,
    action: item.action,
    villa_name_raw: villaName,
    property_id: villa.propertyId,
    villa_resolution: villa.resolution,
    candidate_property_ids: villa.candidateIds.slice(0, PL.arrayMax),
    check_in: checkIn,
    check_out: checkOut,
    // Ayrıştırıcı reserve için her zaman doldurur; boşsa temkinli "pending".
    reservation_status: item.action === "reserve" ? (item.reservationStatus ?? "pending") : null,
    flags,
    conflicts: (busy ?? []).slice(0, PL.arrayMax).map((b) => ({
      kind: b.kind,
      record_id: b.recordId,
      check_in: b.checkIn,
      check_out: b.checkOut,
      status: b.status,
    })),
    score: decision.score,
    band: decision.band,
    review_reasons: decision.reasons.slice(0, PL.arrayMax),
  };
}
