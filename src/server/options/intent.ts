/**
 * Opsiyon — WhatsApp mesajının opsiyon niyeti ve süresi (saf, deterministik; yapay zekâ yok).
 *
 * Tarihler ayrıştırıcıdan (v9, worker'ın kaydettiği öğeler) gelir; bu modül YALNIZ metinden niyeti
 * (oluştur / iptal / kesinleştir), iptal nedenini ve opsiyon süresini çıkarır ve kararı verir:
 *   apply  — otomatik uygulanabilir (veritabanı yine her şeyi yeniden denetler, gerekirse onaya düşürür)
 *   ask    — Super Admin onayına
 *   ignore — işlem yok (soru, olumsuz ifade)
 *
 * Güvenlik ilkesi: otomatik işlem YALNIZ tanınan, tek anlamlı kalıplarda. Mesajda tanınmayan bir
 * sözcük, ikinci bir niyet, belirsiz süre ya da belirsiz tarih varsa karar en fazla "ask"tır.
 * Kesinleştirme her zaman "ask"tır. Belirsizlik tahminle kapatılmaz.
 *
 * Faz B (0077): uzatma ("2 saat uzatalım", "1 gün daha süre verelim"; opsiyon sözcüğü ya da ödeme
 * bekleme bağlamı zorunlu; en az 1 saat; saat / "…'e kadar" açıklama bekler) ve tarih değişikliği
 * (opsiyon sözcüğü + değiştirme fiili; 2 aralık → eski + yeni, 1 aralık → yeni; göreli kaydırma
 * açıklama bekler). İptal / kesinleştirme sinyali varsa eski davranış aynen geçerlidir.
 *
 * Süre (v2): "48 saat", "48s", "2 gün", "2g", "iki gün", "bir hafta", "1,5 gün", "1 buçuk gün",
 * "2 gün 12 saat", "36 saatlik", "3 günlük", "90 dakika". Süreye benzeyen ama anlaşılamayan ifade
 * ("yarım gün", "yarına kadar", "birkaç gün") → süre belirsiz: işletmenin varsayılan süresi
 * KULLANILMAZ, onaya düşer. Hiç süre yazılmamışsa veritabanı işletmenin varsayılan süresini kullanır.
 *
 * Ayrıştırıcı, worker, ağ geçidi, tepki kuyruğu ve veritabanı fonksiyonları bu modülden etkilenmez.
 */
import { foldTr } from "@/lib/wa-calendar-parse";
import { STARTS_WITH_MONTH } from "@/lib/wa-date-parse";
import { OPTION_EXTEND_LIMITS, OPTION_LIMITS } from "@/lib/option-meta";

export type OptionIntent = "create" | "cancel" | "convert" | "extend" | "reschedule";
export type OptionEndReason = "customer_declined" | "owner_cancelled";
/** Veritabanının kabul ettiği neden kodları (app_wa_option_apply). */
export type OptionReason =
  | "question"
  | "negated"
  | "hedged"
  | "intent_conflict"
  | "intent_unclear"
  | "date_missing"
  | "date_unclear"
  | "date_past"
  | "multiple_ranges"
  | "villa_unclear"
  | "duration_unclear"
  | "duration_out_of_bounds"
  | "duration_after_check_in"
  // Faz B (0077): uzatma / tarih değişikliği.
  | "duration_missing"
  | "new_range_missing"
  | "same_range";

/** Ayrıştırıcının kaydettiği öğe (yalnız bu modülün okuduğu alanlar). */
export type IntentItem = {
  checkIn: string | null;
  checkOut: string | null;
  propertyId: string | null;
  villaResolution: string;
  flags: readonly string[];
};

export type IntentResult = {
  intent: OptionIntent;
  decision: "apply" | "ask" | "ignore";
  reasons: OptionReason[];
  checkIn: string | null;
  checkOut: string | null;
  /** Oluşturmada opsiyon süresi; uzatmada EKLENEN süre (dakika). */
  expiresInMinutes: number | null;
  endReason: OptionEndReason | null;
  /** Faz B: tarih değişikliğinde hedefin (eski) aralığı; yoksa grubun tek açık opsiyonu. */
  oldCheckIn: string | null;
  oldCheckOut: string | null;
};

// ---------------------------------------------------------------------------------------------
// Sözlük (katlanmış metin: Türkçe harfler ASCII küçük harf; bkz. foldTr)
// ---------------------------------------------------------------------------------------------
/** "opsiyon" ve yaygın yazım hataları; "opsiyonel" opsiyon değildir. */
const OPTION_STEM = "(?:opsiyon|opsyon|obsiyon|opsiyn|opsion|opisyon|obsyon|opsyion|opsiyom)";
const OPTION_WORD = new RegExp(`\\b${OPTION_STEM}(?!el)\\w*`);
const OPTION_TOKEN = new RegExp(`^${OPTION_STEM}(?!el)\\w*$`);

const PAYMENT =
  "(?:odeme\\w*|kapora\\w*|kaparo\\w*|depozito\\w*|on\\s+odeme\\w*|havale\\w*|eft\\w*|para\\w*|pesinat\\w*)";
/** Kesinleşme / ödeme bildirimi (olumlu biçimler). */
const CONVERT = new RegExp(
  [
    `\\b${PAYMENT}\\s+(?:de\\s+|da\\s+)?(?:alindi|aldik|aldim|geldi|gelmis|yapildi|yapti|yatti|yatmis|yatirildi|yatirdi|gonderdi|gonderildi|gonderilmis|ulasti|odendi|cekildi)\\b`,
    "\\b(?:musteri|misafir)\\w*\\s+(?:odemeyi|kaporayi|kaparoyu|parayi|depozitoyu)\\s+(?:yapti|yatirdi|gonderdi|odedi|verdi)\\b",
    "\\bkesinles(?:ti|di|mis|tir\\w*|ecek)\\b",
    "\\bkesinlestir\\w*",
    "\\bonayla(?:di|dik|dim|ndi|nmis|yin|yalim|yiniz)?\\b",
    "\\bkesin\\s+rezervasyon\\w*",
    "\\brezervasyon\\w*\\s+(?:cevir\\w*|yap(?:alim|in|iniz)|olarak\\s+(?:kaydet|gir)\\w*)",
    `\\b${OPTION_STEM}\\w*\\s+kesin\\b`,
  ].join("|"),
);
/** Ödeme / kesinleşme olumsuz ya da beklemede: işlem yok. */
const CONVERT_NEGATED = new RegExp(
  [
    `\\b${PAYMENT}\\s+(?:de\\s+|da\\s+)?(?:gelme\\w*|gelmi?yor\\w*|yatma\\w*|alinma\\w*|yapilma\\w*|yok\\b|bekle\\w*)`,
    `\\b${PAYMENT}\\s+(?:\\w+\\s+)?bekl(?:e|i)\\w*`,
    "\\bkesinles(?:me|mi)\\w*",
    "\\bonaylanma\\w*",
  ].join("|"),
);
/** Müşteri vazgeçti ("vazgeçmedi" hariç). */
const WITHDRAWAL = /\bvazgec\w*/;
const WITHDRAWAL_NEGATED = /\bvazgec(?:me(?!k)|mey|mem|ilme)\w*/g;
const CUSTOMER_DECLINED =
  /\b(?:musteri|misafir)\w*\s+(?:almadi|almayacak|gelmeyecek|gelmiyor|istemedi|istemiyor|vazgecti)\b|\bdustu\b/;
/** Sahip iptali. */
const OWNER_CANCEL =
  /\biptal\w*|\bkaldir\w*|\bsil(?:in|elim|iniz|indi|dik|di|ebilirsin\w*)?\b|\bbosalt\w*|\bcikar(?:t\w*|in|alim|dik|ildi|iniz)?\b|\bgeri\s+al\w*/;
const CANCEL_NEGATED =
  /\biptal\s+(?:etme(?!k)|etmey|etmem|edilme|olma(?!k)|olmay|olmadi)\w*|\b(?:sil|kaldir|bosalt)(?:ma(?!k)|may|mam|me(?!k)|mey)\w*/;
/** Süre doldu / bitti: otomatik değil (süre dolumunu görev yapar). */
const EXPIRED =
  /\bsuresi\s+(?:dol|bit|gec)\w*|\bsure\s+(?:doldu|bitti|gecti)\b|\bbitti\b|\bsona\s+erdi\b/;
/** Uzatma / tarih değiştirme fiilleri: Faz B kalıbı tanınmazsa oluşturma ve iptal otomatik değil. */
const MODIFY =
  /\buzat\w*|\bkaydir\w*|\bertele\w*|\bdegis\w*|\btasi(?:n|d|y|r)\w*|\bguncelle\w*|\byerine\b/;
/** Yalın onay / bekletme: niyet belirsiz. */
const HOLD = /\bkalsin\b|\btamam\w*|\bbekle\w*|\bdevam\b|\bayni\b|\bsabit\w*/;
/** Olumsuz oluşturma ("opsiyon vermeyelim"). */
const CREATE_NEGATED =
  /\b(?:verme(?:yelim|yin|yiniz|yecegiz|dik|di)|vermeyecek\w*|koyma(?:yalim|yin|yiniz|dik)|tutma(?:yalim|yin|dik)|alma(?:yalim|yin|dik))\b/;
const HEDGED = /\b(?:olabilir|belki|galiba|sanirim|herhalde|gibi|dusunuyor\w*|bakalim)\b/;

// Faz B (0077): uzatma ve tarih değiştirme ----------------------------------------------------
/** Uzatma fiilleri / kalıpları ("uzat", "ek süre", "süre ver / tanı"). */
const EXTEND_VERB = /\buzat\w*|\bek\s+sure\w*|\bsure\s+(?:ver|tani)\w*/;
/** "<süre> daha" ile birlikte bekleme / verme fiili ("2 saat daha bekleyelim"). */
const MORE_TIME_VERB = /\b(?:bekle|ver|tani|tut|uzat)\w*/;
const EXTEND_NEGATED = /\buzatma(?:yalim|yin|yiniz|yacag\w*|dik|di|yiz|yalim)\b|\buzatilma\w*/;
/**
 * Ödeme / kapora BEKLEME bağlamı ("ödeme bekliyorum", "kaporayı gönderecek"): kesinleşme DEĞİL.
 * Kesinleşme yalnız geçmiş zaman (CONVERT: alındı, geldi, yattı, ödendi, gönderdi …).
 */
const WAITING = new RegExp(
  [
    `\\b${PAYMENT}\\s+(?:\\w+\\s+)?bekl(?:e|i)\\w*`,
    `\\b${PAYMENT}\\s+(?:gonderecek|yollayacak|atacak|yatiracak|yapacak|getirecek|gelecek)\\w*`,
    "\\b(?:musteri|misafir)\\w*\\s+(?:odemeyi|kaporayi|kaparoyu|parayi|depozitoyu)\\s+(?:gonderecek|yollayacak|atacak|yatiracak|yapacak|getirecek)\\w*",
  ].join("|"),
);
/** Tarih değiştirme ("yerine", "değiştir", "kaydır", "ertele", "tarihini … yap"). */
const RESCHEDULE_VERB =
  /\byerine\b|\bileri\s+al\w*|\bdegis\w*|\bkaydir\w*|\bertele\w*|\btasi(?:n|d|y|r)\w*|\bguncelle\w*|\btarih(?:ini|lerini|i|leri)\s+(?:\S+\s+){0,6}(?:yap|cek)\w*/;
const RESCHEDULE_NEGATED =
  /\bdegis(?:me(?!k)|mey|mem|mi)\w*|\bdegistirme(?!k)\w*|\b(?:kaydir|ertele|guncelle)(?:me(?!k)|mey|ma(?!k)|may)\w*/;
/** Saat ya da "…'e kadar" gibi mutlak bitiş: Faz B'de desteklenmez (açıklama). */
const CLOCK_TIME = /\b\d{1,2}[:.]\d{2}\b|\bkadar\b/;
/** Uzatma sinyali: uzatma fiili ya da "<süre> daha" + bekleme / verme fiili. */
function extendSignal(f: string): boolean {
  if (EXTEND_VERB.test(f) || EXTEND_NEGATED.test(f)) return true;
  return /\bdaha\b/.test(f) && MORE_TIME_VERB.test(f) && parseOptionDuration(f).kind !== "none";
}
/** Uzatma bağlamı: opsiyon sözcüğü ya da ödeme / kapora bekleme ("ödeme bekliyorum", "gelmedi"). */
function extendContext(f: string): boolean {
  return OPTION_WORD.test(f) || WAITING.test(f) || CONVERT_NEGATED.test(f);
}
/** İki aralıkla ("20-23 opsiyonunu 21-24 yap"): eski → yeni. */
const MAKE = /\byap\w*/;
const QUESTION = /\?|\bm[iu](?:yiz|sin|siniz|dir|yim)?\b/;

/** Oluşturma fiilleri (opsiyon sözcüğüyle birlikte). */
const CREATE_VERB =
  /^(?:ver\w*|koy\w*|al(?:alim|in|iniz|dik|dim|di|indi|iyoruz|acagiz)|tut\w*|yaz\w*|ekle\w*|gir(?:dik|dim|di|ildi|elim|in)|ac(?:alim|in|iniz|tik|tim|ildi)|yap(?:alim|tik|tim|ildi|in)|var)$/;
/** Takvim / kişi / dolgu sözcükleri: niyet taşımaz. */
const NEUTRAL = new Set([
  "giris",
  "cikis",
  "gece",
  "gecelik",
  "geceligine",
  "geceye",
  "arasi",
  "arasinda",
  "arasindaki",
  "tarih",
  "tarihi",
  "tarihleri",
  "tarihlerini",
  "tarihlere",
  "tarihine",
  "tarihinde",
  "tarihler",
  "icin",
  "olarak",
  "ile",
  "ve",
  "de",
  "da",
  "ki",
  "bu",
  "su",
  "o",
  "bir",
  "lutfen",
  "rica",
  "ederim",
  "kisi",
  "kisilik",
  "yetiskin",
  "cocuk",
  "cocuklu",
  "bebek",
  "aile",
  "misafir",
  "misafire",
  "misafirimize",
  "musteri",
  "musteriye",
  "musterimize",
  "musterimiz",
  "cevap",
  "donus",
  "donecek",
  "haber",
  "verecek",
  "bey",
  "beye",
  "hanim",
  "hanima",
  "villa",
  "villaya",
  "villasi",
  "ev",
  "eve",
  "evi",
  "merhaba",
  "selam",
  "arkadaslar",
  "hocam",
  "abi",
  "abla",
  "tesekkurler",
  "sagolun",
  "yil",
  "yili",
  "senesi",
  "ay",
  "ayi",
  "gunler",
  "gunleri",
  "hafta",
  "haftasi",
  "sonu",
  "yeni",
  "rezervasyon",
  "rezervasyonu",
  "talep",
  "talebi",
  "var",
  "sure",
  "suresi",
  "suresini",
  "sureli",
  "sureligine",
  "sureyle",
]);
const WEEKDAY = /^(?:pazartesi|sali|carsamba|persembe|cuma|cumartesi|pazar)\w*$/;

// ---------------------------------------------------------------------------------------------
// Süre (v2)
// ---------------------------------------------------------------------------------------------
const NUM_WORDS: Record<string, number> = {
  bir: 1,
  iki: 2,
  uc: 3,
  dort: 4,
  bes: 5,
  alti: 6,
  yedi: 7,
  sekiz: 8,
  dokuz: 9,
  on: 10,
  yirmi: 20,
  otuz: 30,
  kirk: 40,
  elli: 50,
  altmis: 60,
  yetmis: 70,
  seksen: 80,
  doksan: 90,
};
const NUM_WORD = `(?:${Object.keys(NUM_WORDS).join("|")})`;
/** Sayı: rakam (ondalık virgül/nokta), "buçuk" ekli, ya da sayı sözcükleri ("yirmi dört"). */
const NUMBER = `(?:(\\d{1,4}(?:[.,]\\d{1,2})?)(\\s+bucuk)?|\\b((?:${NUM_WORD}\\s+){0,2}${NUM_WORD})(\\s+bucuk)?)`;
const UNIT = "(saat\\w*|sa\\b|s\\b|gun\\w*|g\\b|hafta\\w*|dakika\\w*|dk\\b|dak\\b)";
const DURATION = new RegExp(`(?<![\\d.,/-])${NUMBER}\\s*${UNIT}`, "g");
/** Süreye benzeyen ama ölçülemeyen ifadeler. */
const VAGUE_DURATION =
  /\bkadar\b|\byarim\s+(?:gun|saat|hafta)\w*|\bbirkac\s+(?:gun|saat|hafta)\w*|\bbiraz\b|\bbir\s+sure\b|\bsure\s+(?:yok|belli\s+degil)/;
const ALTERNATIVE = /\b(?:ya\s+da|veya|yoksa|ila)\b/;

function numberValue(m: RegExpExecArray): number | null {
  if (m[1]) {
    const v = Number(m[1].replace(",", "."));
    return Number.isFinite(v) ? v + (m[2] ? 0.5 : 0) : null;
  }
  if (m[3]) {
    let v = 0;
    for (const w of m[3].trim().split(/\s+/)) v += NUM_WORDS[w] ?? Number.NaN;
    return Number.isFinite(v) ? v + (m[4] ? 0.5 : 0) : null;
  }
  return null;
}

function unitMinutes(unit: string): number {
  if (/^(?:saat|sa$|s$)/.test(unit)) return 60;
  if (/^(?:gun|g$)/.test(unit)) return 24 * 60;
  if (/^hafta/.test(unit)) return 7 * 24 * 60;
  return 1; // dakika
}

export type DurationResult =
  | { kind: "none" }
  | { kind: "minutes"; minutes: number; spans: [number, number][] }
  | { kind: "unclear"; spans: [number, number][] };

/**
 * Opsiyon süresi (katlanmış metinden). Birden çok süre parçası toplanır ("2 gün 12 saat");
 * alternatif ("48 saat ya da 3 gün") veya ölçülemeyen ifade varsa süre belirsizdir.
 */
export function parseOptionDuration(folded: string): DurationResult {
  const spans: [number, number][] = [];
  let total = 0;
  let bad = false;
  for (const m of folded.matchAll(DURATION)) {
    const v = numberValue(m as RegExpExecArray);
    const unit = m[5]!;
    if (v === null || v <= 0) bad = true;
    else total += v * unitMinutes(unit);
    spans.push([m.index!, m.index! + m[0].length]);
  }
  const vague = VAGUE_DURATION.test(folded);
  if (spans.length === 0) return vague ? { kind: "unclear", spans } : { kind: "none" };
  if (bad || vague) return { kind: "unclear", spans };
  if (spans.length > 1) {
    const between = folded.slice(spans[0]![1], spans[spans.length - 1]![0]);
    if (ALTERNATIVE.test(between)) return { kind: "unclear", spans };
  }
  const minutes = Math.round(total);
  if (Math.abs(total - minutes) > 1e-9) return { kind: "unclear", spans };
  return { kind: "minutes", minutes, spans };
}

// ---------------------------------------------------------------------------------------------
// Niyet
// ---------------------------------------------------------------------------------------------
/** Mesaj opsiyonla ilgili mi (opsiyon sözcüğü — yazım hatalarıyla —, vazgeçme ya da ödeme)? */
export function optionRelevant(body: string): boolean {
  const f = foldTr(body);
  return (
    OPTION_WORD.test(f) ||
    WITHDRAWAL.test(f.replace(WITHDRAWAL_NEGATED, " ")) ||
    CUSTOMER_DECLINED.test(f) ||
    CONVERT.test(f) ||
    CONVERT_NEGATED.test(f) ||
    // Faz B: "müşteri kaporayı gönderecek, 2 saat uzatalım" (bekleme bağlamı + uzatma).
    (WAITING.test(f) && extendSignal(f))
  );
}

/** İptal nedeni: tek ve net olmalı; ikisi birden ya da hiçbiri → null (belirsiz). */
export function cancelReasonOf(body: string): OptionEndReason | null {
  const f = foldTr(body);
  const customer = WITHDRAWAL.test(f.replace(WITHDRAWAL_NEGATED, " ")) || CUSTOMER_DECLINED.test(f);
  const owner = OWNER_CANCEL.test(f);
  if (customer && !owner) return "customer_declined";
  if (owner && !customer) return "owner_cancelled";
  return null;
}

/** Oluşturma için metinde niyet taşımayan sözcükler dışında bir şey kalıyor mu? */
function onlyCreateWords(folded: string, durationSpans: readonly [number, number][]): boolean {
  let text = folded;
  for (const [a, b] of durationSpans) text = text.slice(0, a) + " ".repeat(b - a) + text.slice(b);
  const tokens = [...text.matchAll(/[a-z0-9]+(?:'[a-z]+)?/g)].map((m) => m[0]);
  let afterVilla = false;
  for (const raw of tokens) {
    const t = raw.split("'")[0]!;
    if (afterVilla) {
      afterVilla = false; // "Villa Mavi": villa adı (eşleştirmeyi ayrıştırıcı ve worker yapar)
      continue;
    }
    if (t === "villa" || t === "villasi") {
      afterVilla = true;
      continue;
    }
    if (/^\d+$/.test(t)) continue;
    if (OPTION_TOKEN.test(t) || CREATE_VERB.test(t) || NEUTRAL.has(t) || WEEKDAY.test(t)) continue;
    if (STARTS_WITH_MONTH.test(t)) continue;
    if (/^(?:ocak|subat|mart|nisan|mayis|haziran|temmuz|agustos|eylul|ekim|kasim|aralik)/.test(t))
      continue;
    return false;
  }
  return true;
}

const DATE_UNCLEAR = new Set([
  "date_incomplete",
  "date_ambiguous",
  "date_invalid",
  "year_ambiguous",
  "date_order_reversed",
  "date_list",
  "date_unclear",
  "date_change",
]);
const DATE_PAST = new Set(["date_past", "in_progress"]);
const VILLA_UNCLEAR = new Set(["villa_ambiguous", "villa_name_mismatch", "villa_outside_group"]);

/** Girişin başlangıcı (Europe/Istanbul gece yarısı; Türkiye UTC+3, yaz saati yok). */
const checkInStart = (iso: string) => Date.parse(`${iso}T00:00:00+03:00`);

/**
 * Mesajın opsiyon kararı. `items`: ayrıştırıcının kaydettiği öğeler; `groupPropertyId`: grubun
 * villası. Opsiyonla ilgisiz mesajda null.
 */
export function analyzeOptionMessage(input: {
  body: string;
  sentAt: Date;
  items: readonly IntentItem[];
  groupPropertyId: string | null;
}): IntentResult | null {
  if (!optionRelevant(input.body)) return null;
  const f = foldTr(input.body);
  const reasons = new Set<OptionReason>();
  const fNoWithdrawalNeg = f.replace(WITHDRAWAL_NEGATED, " ");

  // Tarih aralıkları (ayrıştırıcı öğelerinin sırasıyla; tekrarlar birleşir).
  const ranges = new Map<string, IntentItem>();
  for (const i of input.items) {
    if (i.checkIn && i.checkOut) ranges.set(`${i.checkIn}/${i.checkOut}`, i);
  }

  // 1. Niyet sinyalleri.
  const convert = CONVERT.test(f);
  const customer = WITHDRAWAL.test(fNoWithdrawalNeg) || CUSTOMER_DECLINED.test(f);
  const owner = OWNER_CANCEL.test(f) && !CANCEL_NEGATED.test(f);
  const expired = EXPIRED.test(f);
  const modify = MODIFY.test(f);
  const hold = HOLD.test(f);
  const cancel = customer || owner || expired;
  // Faz B: uzatma / tarih değişikliği yalnız iptal ve kesinleştirme sinyali YOKSA (varsa eski
  // davranış aynen: iptal / kesinleştirme + intent_unclear).
  const extend = !convert && !cancel && extendSignal(f) && extendContext(f);
  const reschedule =
    !convert &&
    !cancel &&
    OPTION_WORD.test(f) &&
    (RESCHEDULE_VERB.test(f) || (ranges.size === 2 && MAKE.test(f)));
  const negated =
    extend || reschedule
      ? CREATE_NEGATED.test(f) ||
        CANCEL_NEGATED.test(f) ||
        EXTEND_NEGATED.test(f) ||
        RESCHEDULE_NEGATED.test(f) ||
        /\bvazgec(?:me(?!k)|mey|mem|ilme)\w*/.test(f)
      : CREATE_NEGATED.test(f) ||
        CONVERT_NEGATED.test(f) ||
        CANCEL_NEGATED.test(f) ||
        (/\bvazgec(?:me(?!k)|mey|mem|ilme)\w*/.test(f) && !customer);

  let intent: OptionIntent;
  if (convert && cancel) {
    intent = "cancel";
    reasons.add("intent_conflict");
  } else if (convert) intent = "convert";
  else if (cancel) intent = "cancel";
  else if (extend) {
    intent = "extend";
    if (reschedule) reasons.add("intent_conflict");
  } else if (reschedule) intent = "reschedule";
  else intent = "create";

  // 2. Soru / olumsuz: işlem yok.
  const question =
    QUESTION.test(f) ||
    (input.items.length > 0 && input.items.every((i) => i.flags.includes("question")));
  let decision: IntentResult["decision"] = "apply";
  if (question) {
    reasons.add("question");
    decision = "ignore";
  } else if (negated && !(convert || cancel)) {
    reasons.add("negated");
    decision = "ignore";
  } else if (negated) {
    // Olumlu ve olumsuz birlikte ("opsiyon verdik ama kapora gelmedi"): belirsiz.
    reasons.add("intent_unclear");
  }
  if (decision !== "ignore" && HEDGED.test(f)) reasons.add("hedged");

  // 3. Tarih. Oluştur / iptal / kesinleştir: tek ve net aralık. Uzatma: tarihsiz olabilir (hedef
  // grubun tek açık opsiyonu). Tarih değişikliği: 2 aralık → eski + yeni, 1 aralık → yeni.
  let checkIn: string | null = null;
  let checkOut: string | null = null;
  let oldCheckIn: string | null = null;
  let oldCheckOut: string | null = null;
  const flags = new Set(input.items.flatMap((i) => i.flags));
  const villaUnclear = () =>
    [...flags].some((x) => VILLA_UNCLEAR.has(x)) ||
    input.items.some(
      (i) =>
        i.villaResolution === "ambiguous" ||
        (i.propertyId !== null && i.propertyId !== input.groupPropertyId),
    );
  const dateFlags = () => {
    if ([...flags].some((x) => DATE_UNCLEAR.has(x))) reasons.add("date_unclear");
    if ([...flags].some((x) => DATE_PAST.has(x))) reasons.add("date_past");
    if (villaUnclear()) reasons.add("villa_unclear");
  };
  if (intent === "reschedule") {
    const list = [...ranges.values()];
    if (list.length > 2) reasons.add("multiple_ranges");
    else if (list.length === 0) {
      if ([...flags].some((x) => DATE_UNCLEAR.has(x))) reasons.add("date_unclear");
      else reasons.add("new_range_missing");
    } else {
      const next = list[list.length - 1]!;
      checkIn = next.checkIn;
      checkOut = next.checkOut;
      if (list.length === 2) {
        oldCheckIn = list[0]!.checkIn;
        oldCheckOut = list[0]!.checkOut;
      }
      dateFlags();
    }
  } else if (ranges.size > 1) {
    reasons.add("multiple_ranges");
  } else if (ranges.size === 1) {
    const [only] = [...ranges.values()];
    checkIn = only!.checkIn;
    checkOut = only!.checkOut;
    dateFlags();
  } else if ([...flags].some((x) => DATE_UNCLEAR.has(x))) {
    reasons.add("date_unclear");
  } else if (intent !== "extend") {
    reasons.add("date_missing");
  }

  // 4. Niyete özgü kurallar.
  let minutes: number | null = null;
  let endReason: OptionEndReason | null = null;
  if (intent === "create") {
    const d = parseOptionDuration(f);
    if (d.kind === "unclear") reasons.add("duration_unclear");
    else if (d.kind === "minutes") {
      if (d.minutes < OPTION_LIMITS.minHours * 60 || d.minutes > OPTION_LIMITS.maxHours * 60) {
        reasons.add("duration_out_of_bounds");
      } else {
        minutes = d.minutes;
        if (checkIn && input.sentAt.getTime() + d.minutes * 60_000 > checkInStart(checkIn)) {
          reasons.add("duration_after_check_in");
        }
      }
    }
    // Uzatma, tarih kaydırma, yalın onay ya da tanınmayan sözcük: oluşturma otomatik DEĞİL.
    const spans = d.kind === "none" ? [] : d.spans;
    const alreadyAsk = reasons.has("duration_unclear") || reasons.has("hedged");
    if (modify || hold || !OPTION_WORD.test(f) || (!alreadyAsk && !onlyCreateWords(f, spans))) {
      reasons.add("intent_unclear");
    }
  } else if (intent === "extend") {
    // Eklenen süre: en az 1 saat, en çok 14 gün (opsiyonun ilk oluşturulmasından itibaren 14 gün
    // sınırını ve giriş sınırını veritabanı denetler). Saat / "…'e kadar": desteklenmez.
    const d = parseOptionDuration(f);
    if (CLOCK_TIME.test(f) || d.kind === "unclear") reasons.add("duration_unclear");
    else if (d.kind === "none") reasons.add("duration_missing");
    else if (
      d.minutes < OPTION_EXTEND_LIMITS.minMinutes ||
      d.minutes > OPTION_EXTEND_LIMITS.maxLifetimeMinutes
    ) {
      reasons.add("duration_out_of_bounds");
    } else minutes = d.minutes;
  } else if (intent === "reschedule") {
    // Bitiş korunur (yeni 24 saat başlamaz): mesajda süre yazılıysa niyet belirsiz.
    if (parseOptionDuration(f).kind !== "none" || CLOCK_TIME.test(f)) reasons.add("intent_unclear");
  } else if (intent === "cancel") {
    if (expired) {
      // "Süresi doldu / bitti": süre dolumunu görev yapar; otomatik iptal YOK.
      reasons.add("intent_unclear");
    } else if (!reasons.has("intent_conflict")) {
      endReason = customer && owner ? null : customer ? "customer_declined" : "owner_cancelled";
      if (endReason === null) reasons.add("intent_unclear");
    }
    if (modify) reasons.add("intent_unclear");
  }
  // Kesinleştirme her zaman Super Admin onayına (misafir bilgisi onayda girilir).

  if (decision !== "ignore") {
    if (intent === "convert" || reasons.size > 0) decision = "ask";
  } else {
    for (const r of [...reasons]) if (r !== "question" && r !== "negated") reasons.delete(r);
  }
  return {
    intent,
    decision,
    reasons: [...reasons].sort(),
    checkIn,
    checkOut,
    expiresInMinutes: intent === "create" || intent === "extend" ? minutes : null,
    endReason: decision === "ignore" ? null : endReason,
    oldCheckIn,
    oldCheckOut,
  };
}
