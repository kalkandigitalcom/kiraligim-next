/**
 * WhatsApp Asistanı — takvim mesajı ayrıştırıcısı (saf, bağımlılıksız; veritabanı ve ağ yok).
 *
 * Villa sahibinin gruba yazdığı doğal dildeki mesajdan ("Villa A 15-20 Haziran kapalı.") takvim
 * İŞLEM ÖNERİSİ çıkarır: eylem, villa adı adayı, [giriş, çıkış) tarihleri ve bayraklar. Hiçbir şeyi
 * uygulamaz; çıktı yalnız panelde onaylanacak öneri için girdidir.
 *
 * Kurallar:
 *  - Tarihler reservations ile aynı modeldedir: "15-20 Haziran" = giriş 15, çıkış 20 → [15, 20),
 *    5 gece. "Bugün" dışarıdan verilir ("YYYY-MM-DD", Europe/Istanbul; bkz. istanbulToday).
 *  - Yıl yazılmamışsa: aralık bu yıl içinde henüz bitmediyse bu yıl, bittiyse gelecek yıl
 *    (year_inferred). Giriş bugünden ~11 ay sonraysa year_ambiguous. Yazılmış yıl korunur.
 *  - Ay adları Türkçe veya aksansız, tam ya da kısa ("Ağustos", "agustos", "ağu."), eklerle
 *    ("Haziran'da"). Sayısal biçim: "15.06", "15/06/2027". Ay adı olmayan sayı çiftleri ("15-20
 *    bin TL"), binlik ayraçlı tutarlar ("25.000") ve telefon numaraları tarih sayılmaz.
 *  - "müsait değil", "kapalı değil" gibi olumsuz kalıplar olumlu sözcüklerden önce çözülür.
 *  - Belirsizlik tahminle kapatılmaz; bayrakla işaretlenir ve ilgili alan boş bırakılır.
 *
 * Villa adının gerçek bir villaya eşlenmesi (matchVillaName) ve güven puanı (scoreProposal)
 * da saftır; villa listesi, gönderen doğrulaması ve çakışma bilgisi çağıran taraftan gelir.
 */
import { addDays, isIsoDate, nightsBetween } from "./reservation-meta";

/**
 * Ayrıştırıcı sürümü: öneri kaydına yazılır (kurallar değişince artırılır).
 *  1: ilk sürüm.
 *  2: "misafir/rezervasyon yok" belirsiz; "dahil" bitiş; tarih değişikliği (date_change);
 *     "12-18.07"; "1.5 hafta" ve "saat 10.06" tarih değil; villa adı ile eylem ayrımı;
 *     reviewRequirement (güven puanı güvenlik kurallarını aşamaz).
 *  3: "giriş … çıkış" + açık "kapat" talimatı kapatmadır (önceden belirsiz).
 */
export const WA_CALENDAR_PARSER_VERSION = 3;

export const WA_CALENDAR_ACTIONS = ["close", "reserve", "open", "cancel"] as const;
export type WaCalendarAction = (typeof WA_CALENDAR_ACTIONS)[number];

export const WA_CALENDAR_FLAGS = [
  /** Eylem sözcüğü yok. */
  "action_missing",
  /** Birden çok, çelişen eylem sözcüğü (ör. "kapalı" + "rezervasyon"). */
  "action_ambiguous",
  /** Soru cümlesi ("kapalı mı?"): işlem değil. */
  "question",
  /** Mesajda villa adı yok (grupta tek villa varsa çağıran taraf çözer). */
  "villa_missing",
  /** Birden çok villa ve birden çok aralık birlikte: hangisinin hangisine ait olduğu belirsiz. */
  "villa_ambiguous",
  /** Tarih ifadesi yok. */
  "date_missing",
  /** Yalnız bir gün var (giriş ya da çıkış eksik). */
  "date_incomplete",
  /** Tarih ifadeleri bir aralığa bağlanamıyor. */
  "date_ambiguous",
  /** Takvimde olmayan gün ("31 Haziran") veya çıkış girişten önce. */
  "date_invalid",
  /** Aralık (veya tek gün) tamamen geçmişte. */
  "date_past",
  /** Giriş geçmişte, çıkış gelecekte (devam eden konaklama). */
  "in_progress",
  /** Yıl yazılmadı; kuralla belirlendi (bilgi). */
  "year_inferred",
  /** Yıl yazılmadı ve giriş ~11 aydan uzakta: yanlış yıl olabilir. */
  "year_ambiguous",
  /** Aralık WA_CALENDAR_MAX_NIGHTS geceden uzun. */
  "range_too_long",
  /** Mesajdan birden çok öneri çıktı. */
  "multiple_items",
  /** Rezervasyon için misafir adı mesajda yok (onayda istenir). */
  "guest_name_missing",
  /** "2-9 Temmuz dahil": son gün konaklamaya dahil; çıkış bir gün sonrası olarak hesaplandı. */
  "end_inclusive",
  /**
   * Tarih değişikliği ("15-20'den 16-21'e alındı"): henüz desteklenmiyor. Eylem boş bırakılır;
   * tarih alanları YENİ aralığı gösterir, eski aralık alıntıdadır. Elle inceleme zorunlu.
   */
  "date_change",
] as const;
export type WaCalendarFlag = (typeof WA_CALENDAR_FLAGS)[number];

/** Bu geceden uzun aralıklar bayrakla işaretlenir. */
export const WA_CALENDAR_MAX_NIGHTS = 60;
/** Yıl tahmin edildiyse ve giriş bu kadar gün sonrasındaysa year_ambiguous (~11 ay). */
export const WA_CALENDAR_YEAR_AMBIGUOUS_DAYS = 335;
/** Bir mesajdan çıkarılacak en fazla öneri. */
export const WA_CALENDAR_MAX_ITEMS = 10;
/** Öneri kaydında saklanan mesaj parçasının en fazla uzunluğu. */
export const WA_CALENDAR_EXCERPT_MAX = 500;
/** Ayrıştırılan en fazla mesaj uzunluğu (wa_inbound_messages.body sınırı). */
const MAX_INPUT = 4000;

export type WaCalendarItem = {
  action: WaCalendarAction | null;
  /** Mesajda yazıldığı haliyle villa adı ("A", "Zeytin"); yoksa null. */
  villaName: string | null;
  checkIn: string | null;
  checkOut: string | null;
  nights: number | null;
  /** Yalnız reserve için: "opsiyon" → pending, diğerleri → confirmed. */
  reservationStatus: "confirmed" | "pending" | null;
  flags: WaCalendarFlag[];
  /** İki uç tarih eksiksiz ve tarih bayrağı yok (güven puanı bileşeni). */
  datesExplicit: boolean;
  /** Tek ve çelişkisiz eylem (güven puanı bileşeni). */
  actionClear: boolean;
  /** Önerinin dayandığı mesaj parçası (en fazla WA_CALENDAR_EXCERPT_MAX karakter). */
  excerpt: string;
};

export type WaCalendarParseResult = {
  parserVersion: number;
  /** Boşsa mesaj takvimle ilgili değil (noop). */
  items: WaCalendarItem[];
};

// ---------------------------------------------------------------------------------------------
// Türkçe katlama: uzunluk korunur (karakter karakter), böylece katlanmış metindeki konumlar
// özgün metinde de geçerlidir.
// ---------------------------------------------------------------------------------------------

const FOLD: Record<string, string> = {
  İ: "i",
  I: "i",
  ı: "i",
  Ğ: "g",
  ğ: "g",
  Ü: "u",
  ü: "u",
  Ş: "s",
  ş: "s",
  Ö: "o",
  ö: "o",
  Ç: "c",
  ç: "c",
  Â: "a",
  â: "a",
  Î: "i",
  î: "i",
  Û: "u",
  û: "u",
  "’": "'",
  "‘": "'",
  "`": "'",
};

/** Türkçe harfleri ASCII küçük harfe indirir; UTF-16 uzunluğu değişmez. */
export function foldTr(text: string): string {
  let out = "";
  for (const ch of text) {
    const mapped = FOLD[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const lower = ch.toLowerCase();
    out += lower.length === ch.length ? lower : ch;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Ay adları ve tarih kalıpları (katlanmış metin üzerinde)
// ---------------------------------------------------------------------------------------------

const MONTHS_FULL = [
  "ocak",
  "subat",
  "mart",
  "nisan",
  "mayis",
  "haziran",
  "temmuz",
  "agustos",
  "eylul",
  "ekim",
  "kasim",
  "aralik",
] as const;
const MONTHS_SHORT: Record<string, number> = {
  oca: 1,
  sub: 2,
  mar: 3,
  nis: 4,
  may: 5,
  haz: 6,
  tem: 7,
  agus: 8,
  agu: 8,
  eyl: 9,
  eki: 10,
  kas: 11,
  ara: 12,
};

/** Tam ay adı (+ isteğe bağlı ek: "haziran'da", "temmuza") veya kısa ad ("haz.", "agu"). */
const MONTH = `(?:(${MONTHS_FULL.join("|")})(?:'?[a-z]*)|(${Object.keys(MONTHS_SHORT).join("|")})\\.?(?![a-z]))`;
/** Ay adından sonra yıl; para birimi veya "bin" ile devam ediyorsa yıl değil tutardır. */
const YEAR = `(?:\\s+(20\\d{2})(?!\\d)(?!\\s*(?:tl|try|eur|euro|usd|dolar|lira|gbp|sterlin|bin)\\b)(?!\\s*[$€₺£]))?`;
/** Gün: önünde rakam/ayraç ya da "saat" olamaz ("saat 10.06" tarih değildir). */
const DAY = `(?<![\\d.,/:])(?<!saat\\s{0,3})(\\d{1,2})`;
const DASH = `\\s*(?:-|–|—|ila|ile)\\s*`;

/** "15-20 haziran (2027)" */
const RANGE_SAME_MONTH = new RegExp(`${DAY}${DASH}(\\d{1,2})\\s*${MONTH}${YEAR}`, "g");
/** "15 haziran (2027)" */
const DAY_MONTH = new RegExp(`${DAY}\\s*${MONTH}${YEAR}`, "g");
/** Sayıdan sonra gelirse sayıyı tarih olmaktan çıkaran birimler ("1.5 hafta", "2.5 kişi"). */
const UNIT = `\\s*(?:hafta|gun|gece|kisi|saat|dk|dakika|yas|yetiskin|cocuk|kat|oda|km|metre|m2)\\b`;
/**
 * "15.06", "15/06/2027", "15.06.27" — ardından rakam, binlik/ondalık devamı veya birim gelemez.
 * Noktalı ve yılsız yazımda ay iki hanelidir ("15.06" tarih, "1.5" değil; denetim kodda).
 */
const NUMERIC_DATE = new RegExp(
  `${DAY}([./])(\\d{1,2})(?:\\2(\\d{4}|\\d{2}))?(?!\\d)(?![.,]\\d)(?!${UNIT})`,
  "g",
);
/** Ayı ortak sayısal aralık: "12-18.07", "12-18/07/2027". */
const NUMERIC_RANGE_SAME_MONTH = new RegExp(
  `${DAY}${DASH}(\\d{1,2})([./])(\\d{2})(?:\\3(\\d{4}|\\d{2}))?(?!\\d)(?![.,]\\d)(?!${UNIT})`,
  "g",
);
/** Aralığın hemen ardından "dahil" (bitiş günü konaklamaya dahil). */
const INCLUSIVE_AFTER = /^\s*(?:'?(?:de|da|te|ta))?\s*(?:da\s+|de\s+)?dahil\w*/;
/** Bir tarihin hemen önünde kalan "12-" gibi eşleşmemiş aralık başı: tarih belirsizdir. */
const ORPHAN_DASH_BEFORE = /(?:^|[^\d./])(\d{1,2})\s*(?:-|–|—)\s*$/d;
/** "…'dan/'den …'a/'e" ve değişiklik sözcükleri: tarih değişikliği. */
const FROM_SUFFIX = /(?:dan|den|tan|ten)$/;
const CHANGE_WORDS = /\b(?:kaydir\w*|ertele\w*|degis\w*|tasin\w*|tasidi\w*|guncellen\w*|yerine)\b/;
const MONTH_ONLY = new RegExp(`^${MONTH}$`);
const STARTS_WITH_MONTH = new RegExp(`^\\s*${MONTH}`);

type DatePart = { day: number; month: number; year: number | null };
type MentionBase = {
  start: number;
  end: number;
  /** Eşleşen metin (katlanmış), ekleriyle birlikte. */
  text: string;
  /** Hemen ardından "dahil" geliyor. */
  inclusiveAfter: boolean;
  /** Hemen önünde eşleşmemiş "12-" kalmış. */
  orphanBefore: boolean;
};
type RangeMention = MentionBase & { kind: "range"; from: DatePart; to: DatePart };
type DayMention = MentionBase & { kind: "day"; date: DatePart };
type DateMention = RangeMention | DayMention;

const monthOf = (full: string | undefined, short: string | undefined): number =>
  full
    ? MONTHS_FULL.indexOf(full as (typeof MONTHS_FULL)[number]) + 1
    : (MONTHS_SHORT[short ?? ""] ?? 0);

const yearOf = (raw: string | undefined): number | null => {
  if (!raw) return null;
  const n = Number(raw);
  return raw.length === 2 ? 2000 + n : n;
};

function findDateMentions(folded: string): DateMention[] {
  const out: DateMention[] = [];
  const taken: [number, number][] = [];
  const free = (s: number, e: number) => taken.every(([a, b]) => e <= a || s >= b);
  const take = (m: RegExpMatchArray): MentionBase | null => {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (!free(start, end)) return null;
    taken.push([start, end]);
    return {
      start,
      end,
      text: m[0],
      inclusiveAfter: INCLUSIVE_AFTER.test(folded.slice(end)),
      orphanBefore: false,
    };
  };

  for (const m of folded.matchAll(RANGE_SAME_MONTH)) {
    const base = take(m);
    if (!base) continue;
    const month = monthOf(m[3], m[4]);
    const year = yearOf(m[5]);
    out.push({
      ...base,
      kind: "range",
      from: { day: Number(m[1]), month, year },
      to: { day: Number(m[2]), month, year },
    });
  }
  for (const m of folded.matchAll(NUMERIC_RANGE_SAME_MONTH)) {
    const month = Number(m[4]);
    if (month < 1 || month > 12) continue;
    const base = take(m);
    if (!base) continue;
    const year = yearOf(m[5]);
    out.push({
      ...base,
      kind: "range",
      from: { day: Number(m[1]), month, year },
      to: { day: Number(m[2]), month, year },
    });
  }
  for (const m of folded.matchAll(DAY_MONTH)) {
    const base = take(m);
    if (!base) continue;
    out.push({
      ...base,
      kind: "day",
      date: { day: Number(m[1]), month: monthOf(m[2], m[3]), year: yearOf(m[4]) },
    });
  }
  for (const m of folded.matchAll(NUMERIC_DATE)) {
    const sep = m[2];
    const rawMonth = m[3] ?? "";
    const month = Number(rawMonth);
    if (month < 1 || month > 12) continue;
    // Noktalı, yılsız ve tek haneli ay ("1.5", "2.5") ondalık sayıdır.
    if (sep === "." && !m[4] && rawMonth.length < 2) continue;
    const base = take(m);
    if (!base) continue;
    out.push({ ...base, kind: "day", date: { day: Number(m[1]), month, year: yearOf(m[4]) } });
  }
  // Önündeki sayı başka bir tarih ifadesinin parçası değilse "12-" eşleşmemiş aralık başıdır.
  for (const d of out) {
    const m = ORPHAN_DASH_BEFORE.exec(folded.slice(0, d.start));
    const at = m?.indices?.[1]?.[0];
    d.orphanBefore = at !== undefined && free(at, at + 1);
  }
  return out.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------------------------
// Yıl ve aralık çözümü
// ---------------------------------------------------------------------------------------------

const iso = (y: number, p: DatePart) =>
  `${String(y).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;

type ResolvedRange = { checkIn: string | null; checkOut: string | null; flags: WaCalendarFlag[] };

/**
 * [from, to) aralığının yıllarını belirler ve tarih bayraklarını üretir. `inclusiveEnd`: bitiş
 * günü konaklamaya dahil yazıldı ("dahil") → çıkış = bitiş + 1 gün.
 */
function resolveRange(
  from: DatePart,
  to: DatePart,
  today: string,
  inclusiveEnd = false,
): ResolvedRange {
  const thisYear = Number(today.slice(0, 4));
  let yIn: number;
  let yOut: number;
  let inferred = false;

  if (from.year !== null && to.year !== null) {
    yIn = from.year;
    yOut = to.year;
  } else if (from.year !== null) {
    yIn = from.year;
    yOut = iso(yIn, to) <= iso(yIn, from) ? yIn + 1 : yIn;
  } else if (to.year !== null) {
    yOut = to.year;
    yIn = iso(yOut, from) >= iso(yOut, to) ? yOut - 1 : yOut;
  } else {
    inferred = true;
    yIn = thisYear;
    // Çıkış girişten önceyse yıl dönümü ("28 Aralık - 3 Ocak").
    yOut = iso(thisYear, to) <= iso(thisYear, from) ? thisYear + 1 : thisYear;
    // Aralık bu yıl içinde bitmişse gelecek yıl kastedilmiştir.
    if (iso(yOut, to) <= today) {
      yIn += 1;
      yOut += 1;
    }
  }

  const checkIn = iso(yIn, from);
  const lastDay = iso(yOut, to);
  if (!isIsoDate(checkIn) || !isIsoDate(lastDay)) {
    return { checkIn: null, checkOut: null, flags: ["date_invalid"] };
  }
  const checkOut = inclusiveEnd ? addDays(lastDay, 1) : lastDay;
  if (checkOut <= checkIn) return { checkIn: null, checkOut: null, flags: ["date_invalid"] };
  const flags: WaCalendarFlag[] = [];
  if (inclusiveEnd) flags.push("end_inclusive");
  if (inferred) flags.push("year_inferred");
  if (checkOut <= today) flags.push("date_past");
  else if (checkIn < today) flags.push("in_progress");
  if (inferred && checkIn >= addDays(today, WA_CALENDAR_YEAR_AMBIGUOUS_DAYS)) {
    flags.push("year_ambiguous");
  }
  if (nightsBetween(checkIn, checkOut) > WA_CALENDAR_MAX_NIGHTS) flags.push("range_too_long");
  return { checkIn, checkOut, flags };
}

/** Tek gün (çıkış belirsiz): yılı aynı kuralla belirler; checkOut boş kalır, tahmin edilmez. */
function resolveSingle(p: DatePart, today: string): ResolvedRange {
  const flags: WaCalendarFlag[] = ["date_incomplete"];
  let y = p.year ?? Number(today.slice(0, 4));
  if (p.year === null) {
    flags.push("year_inferred");
    if (iso(y, p) < today) y += 1;
  }
  const checkIn = iso(y, p);
  if (!isIsoDate(checkIn)) return { checkIn: null, checkOut: null, flags: ["date_invalid"] };
  if (checkIn < today) flags.push("date_past");
  if (p.year === null && checkIn >= addDays(today, WA_CALENDAR_YEAR_AMBIGUOUS_DAYS)) {
    flags.push("year_ambiguous");
  }
  return { checkIn, checkOut: null, flags };
}

// ---------------------------------------------------------------------------------------------
// Eylem
// ---------------------------------------------------------------------------------------------

/** Olumsuz kalıplar önce aranır ve metinden çıkarılır ("müsait değil" ≠ "müsait"). */
const NEGATED: { re: RegExp; action: WaCalendarAction }[] = [
  { re: /\b(?:musait|bos|uygun|acik)\s+degil\w*/g, action: "close" },
  { re: /\bmusaitlik\s+yok\b/g, action: "close" },
  { re: /\b(?:kapali|dolu)\s+degil\w*/g, action: "open" },
];

/**
 * Varlık olumsuzlaması ("misafir yok", "rezervasyon yok", "kimse gelmeyecek"): açma da olabilir,
 * yalnız bilgi de. Rezervasyon sözcüğü içerdiği için ASLA rezervasyon sayılmaz; eylem belirsizdir.
 */
const NEGATED_PRESENCE =
  /\b(?:misafir\w*|rezervasyon\w*|kimse|musteri\w*|kiraci\w*)\s+(?:yok\w*|gelmeyecek\w*|gelmiyor\w*|olmayacak\w*)/g;

const ACTION_WORDS: { re: RegExp; action: WaCalendarAction }[] = [
  { re: /\biptal\w*|\bvazgec\w*/, action: "cancel" },
  {
    re: /\bkapa(?:li\w*|t\w*|n\w*)|\bdolu\b|\bblok\w*|\bsatma\w*|\bverme(?:yin|yelim|yiniz)?\b/,
    action: "close",
  },
  {
    re: /\brezervasyon\w*|\brezerve\b|\bmisafir\w*|\bopsiyon\w*|\bkiralan\w*|\bkiraladi\w*|\bsatildi\b/,
    action: "reserve",
  },
  {
    re: /\bac(?:alim|in|iniz|ildi|ilsin|abiliriz|abilirsiniz|tik|tim|iyoruz|ik|iyorum)?\b|\bmusait\b|\bbos\b|\bserbest\b|\bbosalt\w*/,
    action: "open",
  },
];

const QUESTION = /\?|\bm[iu](?:\s|$|[.,!])/;
const OPTION = /\bopsiyon\w*/;
const CHECK_IN_OUT = /\bgiris\b[\s\S]*\bcikis\b|\bcikis\b[\s\S]*\bgiris\b/;
/** Açık kapatma TALİMATI ("kapat", "kapatalım", "kapatın"); "kapalı"/"dolu" durum bildirir. */
const CLOSE_COMMAND = /\bkapat\w*/;

type ActionResult = {
  action: WaCalendarAction | null;
  clear: boolean;
  flags: WaCalendarFlag[];
  pending: boolean;
};

function detectAction(folded: string): ActionResult {
  if (QUESTION.test(folded)) {
    return { action: null, clear: false, flags: ["question"], pending: false };
  }
  const found = new Set<WaCalendarAction>();
  let negatedPresence = false;
  let rest = folded.replace(NEGATED_PRESENCE, (m) => {
    negatedPresence = true;
    return " ".repeat(m.length);
  });
  for (const n of NEGATED) {
    rest = rest.replace(n.re, (m) => {
      found.add(n.action);
      return " ".repeat(m.length);
    });
  }
  for (const w of ACTION_WORDS) if (w.re.test(rest)) found.add(w.action);
  // "giriş … çıkış" tek başına rezervasyon anlamı taşır. Yalnız açık kapatma talimatıyla
  // ("10 Haziran giriş, 15 Haziran çıkış … kapat") birlikteyse tarih sınırını belirtir (v3).
  if (CHECK_IN_OUT.test(rest)) {
    const closeCommand = found.size === 1 && found.has("close") && CLOSE_COMMAND.test(rest);
    if (!closeCommand) found.add("reserve");
  }
  const pending = OPTION.test(rest);
  if (negatedPresence) return { action: null, clear: false, flags: ["action_ambiguous"], pending };

  // İptal; rezervasyon sözcükleri ve "tekrar açalım" ile birlikte tek anlamlıdır (iptal tarihi
  // açar). "Kapat" ile birlikte çelişkilidir.
  if (found.has("cancel")) {
    return found.has("close")
      ? { action: null, clear: false, flags: ["action_ambiguous"], pending }
      : { action: "cancel", clear: true, flags: [], pending };
  }
  if (found.size === 0) return { action: null, clear: false, flags: ["action_missing"], pending };
  if (found.size > 1) return { action: null, clear: false, flags: ["action_ambiguous"], pending };
  const [action] = [...found] as [WaCalendarAction];
  return { action, clear: true, flags: [], pending };
}

// ---------------------------------------------------------------------------------------------
// Villa adı adayı
// ---------------------------------------------------------------------------------------------

/** "villa"dan sonra ad olamayacak sözcükler (katlanmış). */
const NAME_STOP = new Set<string>([
  ...MONTHS_FULL,
  "icin",
  "tarih",
  "tarihleri",
  "tarihlerini",
  "tarihinde",
  "arasi",
  "ve",
  "ile",
  "de",
  "da",
  "bu",
  "su",
  "o",
  "giris",
  "cikis",
  "tekrar",
  "villa",
  "villasi",
  // "villa lazım", "villa var mı", "villa için": "villa" genel sözcük olarak kullanılmış.
  "lazim",
  "var",
  "yok",
  "mi",
  "mu",
  "ne",
  "gibi",
  "olarak",
  "kiralik",
  "kiralama",
  "kiralamak",
  "ariyorum",
  "ariyoruz",
  "istiyorum",
  "istiyoruz",
  "bakiyorum",
  "bakiyoruz",
  "saat",
  "temizlik",
  "temizligi",
  "havuz",
  "havuzu",
  "bahce",
  "fiyat",
  "fiyati",
  "fiyatlari",
  "tatil",
  "tatili",
  "sahibi",
  "tum",
  "butun",
  "hepsi",
  "ayni",
  "diger",
  "yeni",
]);

/** Eylem gövdeleri ad olamaz (eylem sözlüğünden bağımsız, yalnız ad süzgeci). */
const NON_NAME_WORD =
  /^(?:kapa(?:li|t|n)\w*|dolu|blok\w*|satma\w*|satil\w*|verme\w*|rezerv\w*|misafir\w*|opsiyon\w*|kiral(?:an|adi)\w*|iptal\w*|vazgec\w*|musait\w*|bos|bosal\w*|serbest|uygun|ac(?:alim|in|iniz|ildi|ilsin|ik)?)$/;
/** Özgün metinde büyük harfle (veya rakamla) başlıyor mu? İkinci ad sözcüğü için şart. */
const STARTS_UPPER = /^[A-ZÇĞİÖŞÜÂÎÛ0-9]/;

/** "Villa A", "Villa Zeytin Evi", "Villa C'nin". */
const VILLA_PREFIX = /\bvilla(?:si)?\s+([a-z0-9][a-z0-9'-]*)(?:\s+([a-z][a-z'-]*))?/dg;
/** Yalnız iyelikli biçim: "Zeytin villası" (çıplak "… villa" öncesi sözcük ad sayılmaz). */
const VILLA_SUFFIX = /\b([a-z0-9][a-z0-9-]*)\s+villasi(?:nin|nda|na|ni|yla)?\b/dg;

const stripSuffix = (word: string) => {
  const i = word.indexOf("'");
  return i === -1 ? word : word.slice(0, i);
};

const isNameWord = (w: string) =>
  w.length > 0 && !NAME_STOP.has(w) && !MONTH_ONLY.test(w) && !NON_NAME_WORD.test(w);

type VillaSpan = { start: number; end: number; name: string };

/**
 * Villa adı adayları ve metindeki konumları. Ad ayrıştırması eylemden bağımsızdır; bulunan
 * konumlar eylem tanımadan önce metinden çıkarılır ("Villa Boş Koy" bir açma eylemi değildir).
 */
function findVillaNames(folded: string, original: string): VillaSpan[] {
  const found: VillaSpan[] = [];
  const add = (start: number, end: number) => {
    const name = original.slice(start, end).trim();
    const key = foldTr(name);
    if (name && !found.some((v) => foldTr(v.name) === key)) found.push({ start, end, name });
  };

  for (const m of folded.matchAll(VILLA_PREFIX)) {
    const w1 = m[1] ?? "";
    const w1Start = m.indices?.[1]?.[0];
    if (w1Start === undefined) continue;
    const w1Clean = stripSuffix(w1);
    // "Villa 15-20 Haziran", "villası 3-8 eylül": tarihin parçası olan sayı ad değildir.
    if (/^\d/.test(w1Clean)) {
      const after = folded.slice(w1Start + w1.length);
      if (!/^\d+$/.test(w1Clean)) continue;
      if (/^\s*(?:[-–—./]|ila\b|ile\b)/.test(after) || STARTS_WITH_MONTH.test(after)) continue;
    } else if (!isNameWord(w1Clean)) continue;
    let end = w1Start + w1Clean.length;
    // İyelik eki almış ilk sözcük adı bitirir ("Villa C'nin 10-15 …").
    const w2 = m[2];
    const w2Start = m.indices?.[2]?.[0];
    // İkinci sözcük yalnız özgün metinde büyük harfle başlıyorsa adın parçasıdır
    // ("Villa Zeytin Evi" evet, "Villa Mavi saat 10.00" hayır).
    if (w2 && w2Start !== undefined && !w1.includes("'")) {
      const w2Clean = stripSuffix(w2);
      if (isNameWord(w2Clean) && STARTS_UPPER.test(original.slice(w2Start))) {
        end = w2Start + w2Clean.length;
      }
    }
    add(w1Start, end);
  }
  for (const m of folded.matchAll(VILLA_SUFFIX)) {
    const w = m[1] ?? "";
    const s = m.indices?.[1]?.[0];
    if (s === undefined || /^\d/.test(w) || !isNameWord(w)) continue;
    add(s, s + w.length);
  }
  return found.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------------------------
// Bölümleme ve ana fonksiyon
// ---------------------------------------------------------------------------------------------

/**
 * Satır sonları, ";", "!" ve cümle sonu noktasından böler. Nokta yalnız ardından boşluk + büyük
 * harf/rakam ya da metin sonu gelirse cümle sonudur: "15.06" ve "haz. kapalı" bölünmez.
 */
function splitSegments(text: string): string[] {
  return text
    .split(/\n|[;!]|\.(?=\s+[A-ZÇĞİÖŞÜ0-9]|\s*$)/)
    .map((t) => t.trim())
    .filter(Boolean);
}

const DATE_FLAGS: ReadonlySet<WaCalendarFlag> = new Set<WaCalendarFlag>([
  "date_missing",
  "date_incomplete",
  "date_ambiguous",
  "date_invalid",
  "year_ambiguous",
  "date_change",
]);

type Draft = {
  action: WaCalendarAction | null;
  villaName: string | null;
  range: ResolvedRange;
  reservationStatus: WaCalendarItem["reservationStatus"];
  actionClear: boolean;
  excerpt: string;
  flags: Set<WaCalendarFlag>;
};

const AMBIGUOUS_DATES: ResolvedRange = { checkIn: null, checkOut: null, flags: ["date_ambiguous"] };

/** Bir bölümdeki tarih ifadelerini aralıklara çevirir (belirsizse tek, boş, bayraklı aralık). */
function rangesOf(dates: DateMention[], today: string): ResolvedRange[] {
  const ranges = dates.filter((d): d is RangeMention => d.kind === "range");
  const days = dates.filter((d): d is DayMention => d.kind === "day");
  if (dates.length === 0) return [{ checkIn: null, checkOut: null, flags: ["date_missing"] }];
  // "12-…" gibi eşleşmeyen bir aralık başı varsa tarih tahmin edilmez.
  if (dates.some((d) => d.orphanBefore)) return [AMBIGUOUS_DATES];
  if (days.length === 0) {
    return ranges.map((r) => resolveRange(r.from, r.to, today, r.inclusiveAfter));
  }
  if (ranges.length === 0 && days.length === 2) {
    return [resolveRange(days[0]!.date, days[1]!.date, today, days[1]!.inclusiveAfter)];
  }
  if (ranges.length === 0 && days.length === 1) return [resolveSingle(days[0]!.date, today)];
  return [AMBIGUOUS_DATES];
}

/**
 * Tarih değişikliği mi? İki aralık "…'dan … 'a" ile bağlanmış ya da bölümde değişiklik sözcüğü
 * ("kaydırıldı", "ertelendi", "değişti") var. Desteklenmeyen işlem: tahmin edilmez.
 */
function isDateChange(folded: string, dates: DateMention[]): boolean {
  if (dates.length === 0) return false;
  if (CHANGE_WORDS.test(folded)) return true;
  const ranges = dates.filter((d) => d.kind === "range");
  return ranges.length >= 2 && FROM_SUFFIX.test(ranges[0]!.text);
}

/**
 * Mesajı takvim önerilerine ayrıştırır. `today`: "YYYY-MM-DD" (Europe/Istanbul). Takvimle
 * ilgisiz mesajda `items` boştur. Hiçbir sonuç kendiliğinden uygulanmaz.
 */
export function parseCalendarMessage(text: string, today: string): WaCalendarParseResult {
  if (!isIsoDate(today)) throw new Error("today: YYYY-MM-DD bekleniyor");
  const drafts: Draft[] = [];

  for (const seg of splitSegments(text.slice(0, MAX_INPUT))) {
    const folded = foldTr(seg);
    const dates = findDateMentions(folded);
    const spans = findVillaNames(folded, seg);
    const villas = spans.map((v) => v.name);
    // Eylem, villa adları metinden çıkarılarak tanınır (ad ile eylem ayrı ayrıştırılır).
    let actionText = folded;
    for (const v of spans) {
      actionText =
        actionText.slice(0, v.start) + " ".repeat(v.end - v.start) + actionText.slice(v.end);
    }
    const act = detectAction(actionText);

    // Ne tarih ne de (villa + eylem) varsa sohbet mesajıdır.
    if (dates.length === 0 && !(villas.length > 0 && act.action !== null)) continue;

    // Tarih değişikliği: tek öneri, eylem yok, yeni aralık (son aralık) ve date_change bayrağı.
    if (isDateChange(folded, dates)) {
      const all = rangesOf(dates, today);
      const target = all.at(-1)!;
      const flags = new Set<WaCalendarFlag>([...target.flags, "action_ambiguous", "date_change"]);
      if (villas.length > 1) flags.add("villa_ambiguous");
      else if (villas.length === 0) flags.add("villa_missing");
      drafts.push({
        action: null,
        villaName: villas.length === 1 ? villas[0]! : null,
        range: target,
        reservationStatus: null,
        actionClear: false,
        excerpt: seg.slice(0, WA_CALENDAR_EXCERPT_MAX),
        flags,
      });
      continue;
    }

    const ranges = rangesOf(dates, today);
    // Villa × aralık: tek villa veya tek aralık eşleşmeyi belirler; ikisi de çoksa belirsiz.
    const pairs: { villa: string | null; range: ResolvedRange; ambiguous: boolean }[] =
      villas.length <= 1
        ? ranges.map((range) => ({ villa: villas[0] ?? null, range, ambiguous: false }))
        : ranges.length === 1
          ? villas.map((villa) => ({ villa, range: ranges[0]!, ambiguous: false }))
          : ranges.map((range) => ({ villa: null, range, ambiguous: true }));

    for (const p of pairs) {
      const flags = new Set<WaCalendarFlag>([...act.flags, ...p.range.flags]);
      if (p.ambiguous) flags.add("villa_ambiguous");
      else if (!p.villa) flags.add("villa_missing");
      if (act.action === "reserve") flags.add("guest_name_missing");
      drafts.push({
        action: act.action,
        villaName: p.villa,
        range: p.range,
        reservationStatus:
          act.action === "reserve" ? (act.pending ? "pending" : "confirmed") : null,
        actionClear: act.clear,
        excerpt: seg.slice(0, WA_CALENDAR_EXCERPT_MAX),
        flags,
      });
    }
  }

  const limited = drafts.slice(0, WA_CALENDAR_MAX_ITEMS);
  const items = limited.map((d): WaCalendarItem => {
    if (limited.length > 1) d.flags.add("multiple_items");
    const flags = WA_CALENDAR_FLAGS.filter((f) => d.flags.has(f));
    const { checkIn, checkOut } = d.range;
    return {
      action: d.action,
      villaName: d.villaName,
      checkIn,
      checkOut,
      nights: checkIn && checkOut ? nightsBetween(checkIn, checkOut) : null,
      reservationStatus: d.reservationStatus,
      flags,
      datesExplicit: !!checkIn && !!checkOut && !flags.some((f) => DATE_FLAGS.has(f)),
      actionClear: d.actionClear,
      excerpt: d.excerpt,
    };
  });
  return { parserVersion: WA_CALENDAR_PARSER_VERSION, items };
}

// ---------------------------------------------------------------------------------------------
// Villa eşleme (saf: villa listesi çağırandan gelir)
// ---------------------------------------------------------------------------------------------

export type VillaOption = { id: string; name: string; aliases?: readonly string[] };
export type VillaMatch =
  { kind: "matched"; id: string } | { kind: "ambiguous"; ids: string[] } | { kind: "none" };

/** Ad karşılaştırması için: katlanmış, ek/noktalama ve "villa" sözcüğü atılmış sözcükler. */
export function villaKey(name: string): string {
  return foldTr(name)
    .replace(/'[a-z]*/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && w !== "villa" && w !== "villasi")
    .join(" ");
}

/**
 * Mesajdaki ad adayını villa listesine eşler: önce tam eşleşme (ad veya takma ad), yoksa adın
 * baştaki sözcükleri ("zeytin" → "Villa Zeytin Evi"). Birden çok villa → ambiguous.
 */
export function matchVillaName(candidate: string, villas: readonly VillaOption[]): VillaMatch {
  const key = villaKey(candidate);
  if (!key) return { kind: "none" };
  const keysOf = (v: VillaOption) => [villaKey(v.name), ...(v.aliases ?? []).map(villaKey)];
  const pick = (list: readonly VillaOption[]): VillaMatch => {
    const ids = [...new Set(list.map((v) => v.id))];
    if (ids.length === 1) return { kind: "matched", id: ids[0]! };
    return ids.length > 1 ? { kind: "ambiguous", ids } : { kind: "none" };
  };
  const exact = villas.filter((v) => keysOf(v).includes(key));
  if (exact.length > 0) return pick(exact);
  return pick(villas.filter((v) => keysOf(v).some((k) => k.startsWith(`${key} `))));
}

// ---------------------------------------------------------------------------------------------
// Güven puanı
// ---------------------------------------------------------------------------------------------

/** named: adla tekil eşleşti; single: adsız ama grupta tek villa; ambiguous/none: eşleşmedi. */
export type VillaResolution = "named" | "single" | "ambiguous" | "none";

export const WA_CONFIDENCE_WEIGHTS = {
  villaNamed: 30,
  villaSingle: 25,
  datesExplicit: 25,
  actionClear: 20,
  senderVerified: 15,
  conflictFree: 10,
} as const;

export type ConfidenceBand = "high" | "medium" | "low";

/** 0–100. Puan yalnız onay ekranının kolaylığını belirler; her öneri yine onay ister. */
export function scoreProposal(input: {
  villa: VillaResolution;
  datesExplicit: boolean;
  actionClear: boolean;
  senderVerified: boolean;
  conflictFree: boolean;
}): number {
  const w = WA_CONFIDENCE_WEIGHTS;
  return (
    (input.villa === "named" ? w.villaNamed : input.villa === "single" ? w.villaSingle : 0) +
    (input.datesExplicit ? w.datesExplicit : 0) +
    (input.actionClear ? w.actionClear : 0) +
    (input.senderVerified ? w.senderVerified : 0) +
    (input.conflictFree ? w.conflictFree : 0)
  );
}

/** ≥ 85 yüksek (tek tıkla onay), 60–84 orta, < 60 düşük (düzenleme zorunlu). */
export function confidenceBand(score: number): ConfidenceBand {
  return score >= 85 ? "high" : score >= 60 ? "medium" : "low";
}

// ---------------------------------------------------------------------------------------------
// İnceleme kuralı (güvenlik): güven puanı bu kuralları ASLA aşamaz
// ---------------------------------------------------------------------------------------------

/** Tek tıkla onaylanabilecek eylemler. Rezervasyon, iptal ve açma her zaman elle incelenir. */
export const WA_QUICK_APPROVE_ACTIONS: readonly WaCalendarAction[] = ["close"];

/** Tek tıkla onayı engellemeyen (yalnız bilgi veren) bayraklar. */
const INFO_ONLY_FLAGS: ReadonlySet<WaCalendarFlag> = new Set<WaCalendarFlag>([
  "year_inferred",
  "multiple_items",
]);

export const WA_REVIEW_REASONS = [
  /** Eylem yok (belirsiz, soru, tarih değişikliği…). */
  "no_action",
  /** Rezervasyon, iptal veya açma: puan ne olursa olsun elle inceleme. */
  "action_requires_review",
  /** Bilgi dışı bir bayrak var. */
  "flagged",
  /** Tarihler eksik veya belirsiz. */
  "dates_incomplete",
  /** Villa adla tekil eşleşmedi ve grupta tek villa da yok. */
  "villa_unresolved",
  /**
   * Villa adla eşleşti ama mesajın geldiği grubun villası değil (grup dışı villa): öneri
   * oluşturulur, tek tıkla onay hiçbir zaman yapılamaz.
   */
  "villa_needs_review",
  /** Gönderen yetkisiz (normalde öneri hiç oluşmaz; savunma amaçlı). */
  "sender_unverified",
  /**
   * Eski (B aşaması öncesi) kayıtlar için korunur: staff önerisi elle incelenirdi. Artık
   * üretilmez; engellenmemiş her grup katılımcısı yetkili gönderendir.
   */
  "staff_review_required",
  /** Mevcut kayıtla çakışma var. */
  "conflict",
  /** Güven puanı yüksek bantta değil. */
  "low_confidence",
] as const;
export type WaReviewReason = (typeof WA_REVIEW_REASONS)[number];

/**
 * Gönderenin rolü (B aşaması). Super Admin'in bir işletmeye ve villaya eşleştirdiği AKTİF grubun
 * her katılımcısı operasyonel mesaj gönderebilir; ayrıca telefon doğrulaması veya allowlist yoktur.
 * owner/manager/staff: numarası işletmenin bir üyesinde doğrulanmış (yalnız bilgi amaçlı);
 * participant: işletme üyesi olmayan (veya numarası doğrulanmamış) grup katılımcısı.
 * null: gönderen yetkisiz (Super Admin engeli, numarası belirlenemeyen gönderen) — veritabanı bu
 * mesajları zaten yok sayar; savunma amaçlı.
 */
export const WA_SENDER_ROLES = ["owner", "manager", "staff", "participant"] as const;
export type WaSenderRole = (typeof WA_SENDER_ROLES)[number];

export type WaReviewDecision = {
  /** Yalnız `reasons` boşsa true. */
  quickApprove: boolean;
  score: number;
  band: ConfidenceBand;
  reasons: WaReviewReason[];
};

/**
 * Bir önerinin tek tıkla onaylanıp onaylanamayacağı. Her öneri yine onay ister; bu kural yalnız
 * "tek tık" ile "elle inceleme (düzenleme)" arasında seçer. Puan burada hesaplanır ve yalnız bir
 * neden EKLEYEBİLİR; hiçbir puan bir güvenlik nedenini kaldıramaz.
 */
export function reviewRequirement(
  item: WaCalendarItem,
  ctx: {
    villa: VillaResolution;
    senderRole: WaSenderRole | null;
    conflictFree: boolean;
    /** Eşleşen villa, mesajın geldiği grubun villası değil (resolveProposal: villa_outside_group). */
    villaOutsideGroup?: boolean;
  },
): WaReviewDecision {
  // B aşaması: engellenmemiş her grup katılımcısı yetkili gönderendir (rolü ne olursa olsun).
  const senderVerified = ctx.senderRole !== null;
  const score = scoreProposal({
    villa: ctx.villa,
    datesExplicit: item.datesExplicit,
    actionClear: item.actionClear,
    senderVerified,
    conflictFree: ctx.conflictFree,
  });
  const band = confidenceBand(score);
  const reasons: WaReviewReason[] = [];
  if (item.action === null) reasons.push("no_action");
  else if (!WA_QUICK_APPROVE_ACTIONS.includes(item.action)) reasons.push("action_requires_review");
  // Grupta tek villa varsa "villa adı yazılmamış" bayrağı çağıran tarafça çözülmüştür.
  const resolved = (f: WaCalendarFlag) =>
    INFO_ONLY_FLAGS.has(f) || (f === "villa_missing" && ctx.villa === "single");
  if (item.flags.some((f) => !resolved(f))) reasons.push("flagged");
  if (!item.datesExplicit || !item.checkIn || !item.checkOut) reasons.push("dates_incomplete");
  if (ctx.villa !== "named" && ctx.villa !== "single") reasons.push("villa_unresolved");
  if (ctx.villaOutsideGroup === true) reasons.push("villa_needs_review");
  if (!senderVerified) reasons.push("sender_unverified");
  if (!ctx.conflictFree) reasons.push("conflict");
  if (band !== "high") reasons.push("low_confidence");
  return { quickApprove: reasons.length === 0, score, band, reasons };
}

// ---------------------------------------------------------------------------------------------
// Kişi sayısı (onay ekranında ön doldurma; öneri kaydına yazılmaz, yönetici düzeltir)
// ---------------------------------------------------------------------------------------------

export type WaGuestCount = {
  /** Yetişkin sayısı; yalnız "N kişi" yazıldıysa N. */
  adults: number | null;
  children: number | null;
  /** Toplam kişi (yetişkin + çocuk ya da "N kişi"). */
  total: number | null;
};

const GUESTS_MAX = 50;

/**
 * "4 kişi", "4 kişilik", "2 yetişkin 1 çocuk", "6 misafir", "3 pax". Tarih ve tutar sayıları
 * kişi sayısı sayılmaz (yalnız ardından kişi sözcüğü gelen 1–2 haneli sayı). Bulunamazsa null.
 * Saf fonksiyon; sonuç yalnız onay formunu önceden doldurur, yönetici her zaman düzeltebilir.
 */
export function parseGuestCount(text: string): WaGuestCount {
  const folded = foldTr(text.slice(0, MAX_INPUT));
  const pick = (re: RegExp): number | null => {
    const m = re.exec(folded);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isInteger(n) && n >= 0 && n <= GUESTS_MAX ? n : null;
  };
  const boundary = "(?![a-z0-9])";
  const pre = "(?<![0-9.,:/-])";
  const adults = pick(new RegExp(`${pre}\\b(\\d{1,2})\\s*(?:yetiskin|buyuk)`, "u"));
  const children = pick(new RegExp(`${pre}\\b(\\d{1,2})\\s*(?:cocuk|bebek)`, "u"));
  const total = pick(
    new RegExp(`${pre}\\b(\\d{1,2})\\s*(?:kisi[a-z]*|misafir[a-z]*|pax)${boundary}`, "u"),
  );
  if (adults !== null) {
    return { adults, children, total: adults + (children ?? 0) };
  }
  if (total !== null) {
    return {
      adults: total - (children ?? 0) > 0 ? total - (children ?? 0) : total,
      children,
      total,
    };
  }
  return { adults: null, children, total: children };
}
