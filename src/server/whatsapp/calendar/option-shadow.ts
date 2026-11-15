/**
 * Opsiyon gölge modu (Aşama 2) — saf analiz. Worker, merkezi ayar açıksa (WA_OPTION_SHADOW=on)
 * mesajı her zamanki gibi işledikten SONRA bu fonksiyonla "opsiyon özelliği açık olsaydı ne
 * yapılırdı" kararını üretir; karar YALNIZ wa_option_shadow_decisions'a yazılır
 * (app_wa_store_option_shadow). Hiçbir opsiyon, rezervasyon, blok veya tepki oluşturulmaz.
 *
 * İki aşamalı karar: burada metin ve ayrıştırıcı (v8) çıktısına göre ön karar (intent + apply /
 * ask / ignore + nedenler); veritabanı fonksiyonu takvim çakışmasını, açık opsiyonları ve hedef
 * opsiyonu yazım anında denetleyip "apply"ı gerekirse "ask"a düşürür. Veritabanı kararı asla
 * "ask"tan "apply"a yükseltmez.
 *
 * Kurallar (Opsiyon Yönetimi planı, bölüm 6–8 ve 15 Kasım kararları):
 *   - Bir mesaj = en fazla bir opsiyon; birden fazla tarih aralığı → ask (multiple_ranges).
 *   - Soru → ignore; olumsuz ("opsiyon vermeyelim") → ignore; temkinli ("olabilir") → ask.
 *   - Süre yalnız mesajda yazıyorsa: 1 saat – 14 gün, girişten önce dolmalı; belirsiz → ask.
 *   - Kesinleştirme ve iptal yalnız birebir tarihle "apply" adayıdır; tarihsiz bildirimin hedefi
 *     veritabanında aranır ama "tek açık opsiyon" kuralı karara bağlanana kadar en fazla "ask".
 */
import { foldTr, WA_CALENDAR_PARSER_VERSION } from "@/lib/wa-calendar-parse";
import {
  OPTION_LIMITS,
  type ShadowDecision,
  type ShadowIntent,
  type ShadowReason,
} from "@/lib/option-meta";

import type { StoreItem } from "./proposal";

/** app_wa_store_option_shadow öğesi (JSON alan adları veritabanı fonksiyonuyla aynı). */
export type ShadowItem = {
  item_no: number;
  parser_version: number;
  intent: ShadowIntent;
  decision: ShadowDecision;
  reasons: ShadowReason[];
  check_in: string | null;
  check_out: string | null;
  expires_in_minutes: number | null;
};

const OPTION_WORD = /\bopsiyon(?!el)\w*/;
const WITHDRAWAL = /\bvazgec\w*/;
const WITHDRAWAL_NEGATED = /\bvazgec(?:me(?!k)|mey|mem|ilme)\w*/g;
/** Ödeme / kesinleşme bildirimi (yalnız olumlu biçimler; "gelmedi", "bekliyoruz" değil). */
const CONVERT =
  /\b(?:odeme|odemeyi|kapora|kaporayi|para|parayi)\s+(?:alindi|aldik|geldi|yapildi|yapti|yatti|yatirildi|gonderdi|gonderildi)\b|\bmusteri\s+odemeyi\s+yapti\b|\bkesinles(?:ti|di|tir\w*|mis)\b|\bonayla(?:di|dik|ndi)\b|\bkesin\s+rezervasyon\s+oldu\b/;
/** İptal bildirimi (olumlu vazgeçme ayrıca). */
const CANCEL =
  /\biptal\w*|\bdustu\b|\bkaldir\w*|\bsuresi\s+dol\w*|\bmusteri\s+almadi\b|\bbosa\s+cik\w*/;
/** Müşterinin almadığı bildirimi ("Müşteri almadı"): opsiyon sözcüğü olmadan da iptal adayıdır. */
const NOT_TAKEN = /\b(?:musteri|misafir)\s+almadi\b/;
/** "Opsiyon tamam" gibi yalın onay: kesinleşme mi, opsiyonun verildiği mi belirsiz. */
const BARE_OK = /\btamam\w*/;
const NEGATED = /\b(?:verme(?:yelim|yin|yiniz|yecegiz|dik)|vermeyecek\w*|etme(?:yelim|yin))\b/;
const HEDGED = /\b(?:olabilir|belki|galiba|sanirim|herhalde|gibi)\b/;
const QUESTION = /\?|\bm[iu](?:yiz|sin|siniz|dir|yim)?\b/;
const HOURS = /\b(\d{1,4})\s*saat\w*/;
const DAYS = /\b(\d{1,3})\s*gun\w*/;
const MINUTES = /\b(\d{1,4})\s*(?:dakika|dk)\w*/;
/** Saat / gün sayısı olmadan "… kadar" (yarın akşama kadar, cumaya kadar): belirsiz süre. */
const VAGUE_DURATION = /\bkadar\b/;

const DATE_UNCLEAR = new Set([
  "date_ambiguous",
  "date_incomplete",
  "date_invalid",
  "date_unclear",
  "date_order_reversed",
  "date_list",
  "date_change",
  "year_ambiguous",
  "range_too_long",
]);
const DATE_PAST = new Set(["date_past", "in_progress"]);
const VILLA_UNCLEAR = new Set(["villa_ambiguous", "villa_name_mismatch", "villa_outside_group"]);

/** Mesaj opsiyonla ilgili mi (oluşturma / kesinleştirme / iptal adayı)? */
export function shadowRelevant(body: string): boolean {
  const f = foldTr(body);
  return (
    OPTION_WORD.test(f) ||
    WITHDRAWAL.test(f.replace(WITHDRAWAL_NEGATED, " ")) ||
    CONVERT.test(f) ||
    NOT_TAKEN.test(f)
  );
}

function intentOf(f: string): { intent: ShadowIntent; reasons: ShadowReason[] } {
  const option = OPTION_WORD.test(f);
  const withdrawal = WITHDRAWAL.test(f.replace(WITHDRAWAL_NEGATED, " "));
  const convert = CONVERT.test(f);
  const cancel = withdrawal || CANCEL.test(f) || NOT_TAKEN.test(f);
  if (convert && cancel) return { intent: "unknown", reasons: ["intent_conflict"] };
  if (convert) return { intent: "convert", reasons: [] };
  if (cancel) return { intent: "cancel", reasons: [] };
  if (option && BARE_OK.test(f)) return { intent: "unknown", reasons: ["intent_unclear"] };
  if (option) return { intent: "create", reasons: [] };
  return { intent: "unknown", reasons: ["intent_unclear"] };
}

/** Mesajdaki opsiyon süresi (dakika). undefined: süre yazılmamış; null: belirsiz. */
function durationOf(f: string): number | null | undefined {
  const h = HOURS.exec(f);
  const d = DAYS.exec(f);
  const m = MINUTES.exec(f);
  const found = [h, d, m].filter(Boolean).length;
  if (found > 1) return null;
  if (h) return Number(h[1]) * 60;
  if (d) return Number(d[1]) * 24 * 60;
  if (m) return Number(m[1]);
  if (VAGUE_DURATION.test(f)) return null;
  return undefined;
}

/** Girişin başlangıcı (Europe/Istanbul gece yarısı; Türkiye UTC+3, yaz saati yok). */
const checkInStart = (iso: string) => Date.parse(`${iso}T00:00:00+03:00`);

/**
 * Gölge kararı. `items`: worker'ın kaydettiği öğeler (ayrıştırıcı v8 + villa çözümü);
 * `groupPropertyId`: grubun villası. Opsiyonla ilgisiz mesajda boş dizi.
 */
export function analyzeOptionShadow(input: {
  body: string;
  sentAt: Date;
  items: readonly StoreItem[];
  groupPropertyId: string | null;
}): ShadowItem[] {
  const f = foldTr(input.body);
  if (!shadowRelevant(input.body)) return [];
  const { intent, reasons: intentReasons } = intentOf(f);
  const reasons = new Set<ShadowReason>(intentReasons);
  let decision: ShadowDecision = "apply";

  const items = input.items;
  const question =
    QUESTION.test(f) || (items.length > 0 && items.every((i) => i.flags.includes("question")));
  if (question) {
    reasons.add("question");
    decision = "ignore";
  } else if (NEGATED.test(f)) {
    reasons.add("negated");
    decision = "ignore";
  }
  if (decision !== "ignore" && HEDGED.test(f)) reasons.add("hedged");

  // Tarih: tek ve net aralık. Birden fazla farklı aralık desteklenmez.
  const ranges = new Map<string, StoreItem>();
  for (const i of items) {
    if (i.check_in && i.check_out) ranges.set(`${i.check_in}/${i.check_out}`, i);
  }
  let checkIn: string | null = null;
  let checkOut: string | null = null;
  if (ranges.size > 1) {
    reasons.add("multiple_ranges");
  } else if (ranges.size === 1) {
    const [only] = [...ranges.values()];
    checkIn = only!.check_in;
    checkOut = only!.check_out;
    const flags = new Set(items.flatMap((i) => i.flags));
    if ([...flags].some((x) => DATE_UNCLEAR.has(x))) reasons.add("date_unclear");
    if ([...flags].some((x) => DATE_PAST.has(x))) reasons.add("date_past");
    const villaUnclear =
      [...flags].some((x) => VILLA_UNCLEAR.has(x)) ||
      items.some(
        (i) =>
          i.villa_resolution === "ambiguous" ||
          (i.property_id !== null && i.property_id !== input.groupPropertyId),
      );
    if (villaUnclear) reasons.add("villa_unclear");
  } else if (items.some((i) => i.flags.some((x) => DATE_UNCLEAR.has(x)))) {
    reasons.add("date_unclear");
  } else if (intent === "create") {
    reasons.add("date_missing");
  }

  // Süre yalnız oluşturmada anlamlıdır ("süresi doldu" iptaldir).
  let minutes: number | null = null;
  if (intent === "create") {
    const d = durationOf(f);
    if (d === null) reasons.add("duration_unclear");
    else if (d !== undefined) {
      if (d < OPTION_LIMITS.minHours * 60 || d > OPTION_LIMITS.maxHours * 60) {
        reasons.add("duration_out_of_bounds");
      } else {
        minutes = d;
        if (checkIn && input.sentAt.getTime() + d * 60_000 > checkInStart(checkIn)) {
          reasons.add("duration_after_check_in");
        }
      }
    }
  }

  if (decision !== "ignore" && (intent === "unknown" || reasons.size > 0)) decision = "ask";
  // İşlem yoksa (soru / olumsuz) yalnız işlemsizlik nedeni yazılır.
  if (decision === "ignore") {
    for (const r of [...reasons]) if (r !== "question" && r !== "negated") reasons.delete(r);
  }
  return [
    {
      item_no: 0,
      parser_version: WA_CALENDAR_PARSER_VERSION,
      intent,
      decision,
      reasons: [...reasons].sort(),
      check_in: checkIn,
      check_out: checkOut,
      expires_in_minutes: minutes,
    },
  ];
}
