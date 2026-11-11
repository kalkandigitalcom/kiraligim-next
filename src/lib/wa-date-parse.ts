/**
 * WhatsApp Asistanı — MERKEZİ Türkçe tarih ve tarih aralığı ayrıştırıcısı (saf; veritabanı ve ağ yok).
 *
 * Takvimle ilgili bütün WhatsApp işlemleri (kapatma, açma ve ileride iptal/tarih değişikliği)
 * tarihleri YALNIZ bu modülden alır (wa-calendar-parse.ts → parseCalendarMessage).
 *
 * Model: [giriş, çıkış) — "20-25" = 20 giriş, 25 çıkış, 5 gece (reservations ile aynı).
 * "Bugün": mesajın GÖNDERİLDİĞİ anın Europe/Istanbul tarihi, "YYYY-MM-DD" (çağıran verir).
 *
 * Temel kural: bir ifadenin TEK makul tarih yorumu yoksa tarih tahmin edilmez; aralık boş kalır
 * ve bir neden bayrağı eklenir (işlem yapılmaz, ⚠️ + soru). Açık ve tek anlamlı yazımlar ise
 * gereksiz yere reddedilmez.
 *
 * Desteklenen yazımlar (özet):
 *  - Ay adıyla: "10-15 Aralık", "10 Aralık - 15 Aralık", "10 Ara - 15 Ara", "10 Aralık'tan 15
 *    Aralık'a", "10'dan 15 Aralık'a kadar", "10 Aralık'tan 15'ine kadar", "10 ile 15 Aralık arası",
 *    "10 ve 15 Aralık arası", "10 15 Aralık", "10/15 Aralık", ayı önde: "Aralık 10-15",
 *    "Aralık'ta 10-15", "Aralık'ın 10'u ile 15'i arası", "Aralık 10 - Aralık 15"; ardışık gün listesi
 *    "10, 11, 12 Aralık"; yıl: "10-15 Eylül 2027", "28 Aralık - 3 Ocak".
 *  - Sayısal: "10.12-15.12", "10.12 / 15.12", "10.12 ile 15.12", "10-15.12", "10.12-15" (ikinci gün
 *    aynı ay), "5.1-10.1", "10/12/2026-15/12/2026", "10.12.26-15.12.26".
 *  - Ay yazılmadan (yalnız takvim komutu bağlamında): "20-25", "20.25", "20 25", "20/25",
 *    "20 ile 25", "20'den 25'e", "20'sinden 25'ine kadar", "20 ve 25 arası", "ayın 20'si ile 25'i
 *    arası", "20'sinde giriş 25'inde çıkış" → bu ayın günleri. Başlangıç bugünden önceyse geçmiş
 *    sayılır (soru); "önümüzdeki ayın 10-15'i", "gelecek ay 10-15" → gelecek ay.
 *  - Göreli: "bugün", "yarın", "öbür gün", "bu gece", "yarından itibaren 3 gece", "önümüzdeki 3
 *    gece", "gelecek hafta pazartesi-cuma", "cumartesi gecesi", "bu ayın sonuna kadar",
 *    "Aralık ayı boyunca".
 *  - Gece sayısı: "15 Aralık gecesi" (1 gece), "15 Aralık giriş 3 gece", "15 Aralık'tan itibaren 5
 *    gece". "dahil": "10-15 Aralık dahil", "10-15 Aralık arası (15 dahil)" → çıkış 16.
 *  - Düzeltme: "10-15 Aralık değil 20-25 Aralık" (ilk aralık atılır), "10-15 Aralık değil, Ocak"
 *    (aynı günler, yeni ay).
 *  - Giriş/çıkış etiketi ters yazılırsa ("Çıkış 15 Aralık giriş 10 Aralık") etiket esas alınır.
 *
 * Soru sorulan (tarih boş) durumlar: ters sıralı günler ("25-20", "28-3 Ocak"), ardışık olmayan
 * gün listesi ("10 ve 12 Aralık", "10,15"), belirsiz göreli ifadeler (hafta sonu, yılbaşına kadar,
 * bayram, "N gün sonra", haftanın günü tek başına), geçersiz gün. Saat ("saat 10.15", "10.15'te"),
 * tutar ("15-20 bin"), birim ("2-3 kişi", "10-15 dk") ve telefon numaraları tarih sayılmaz.
 */
import type { WaCalendarFlag } from "./wa-calendar-parse";
import { addDays, isIsoDate, nightsBetween } from "./reservation-meta";

/** Bu geceden uzun aralıklar bayrakla işaretlenir. */
export const WA_CALENDAR_MAX_NIGHTS = 60;
/** Yıl tahmin edildiyse ve giriş bu kadar gün sonrasındaysa year_ambiguous (~11 ay). */
export const WA_CALENDAR_YEAR_AMBIGUOUS_DAYS = 335;

// ---------------------------------------------------------------------------------------------
// Ay adları (katlanmış metin: Türkçe harfler ASCII, küçük harf)
// ---------------------------------------------------------------------------------------------

export const MONTHS_FULL = [
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
export const MONTH = `(?:(${MONTHS_FULL.join("|")})(?:'?[a-z]*)|(${Object.keys(MONTHS_SHORT).join("|")})\\.?(?![a-z]))`;
/** Grupsuz ay kalıbı (başka kalıpların içinde). */
const MONTH_NC = `(?:(?:${MONTHS_FULL.join("|")})(?:'?[a-z]*)|(?:${Object.keys(MONTHS_SHORT).join("|")})\\.?(?![a-z]))`;
export const MONTH_ONLY = new RegExp(`^${MONTH}$`);
export const STARTS_WITH_MONTH = new RegExp(`^\\s*${MONTH}`);
/** Ay adından sonra yıl; para birimi veya "bin" ile devam ediyorsa yıl değil tutardır. */
const YEAR = `(?:\\s+(20\\d{2})(?!\\d)(?!\\s*(?:tl|try|eur|euro|usd|dolar|lira|gbp|sterlin|bin)\\b)(?!\\s*[$€₺£]))?`;
/** Gün: önünde rakam/ayraç ya da "saat" olamaz ("saat 10.06" tarih değildir). */
const DAY = `(?<![\\d.,/:])(?<!saat\\s{0,3})(\\d{1,2})`;
const DASH = `\\s*(?:-|–|—|ila|ile)\\s*`;
/** Türkçe ek: "15'ine", "10'dan", "20'si" (katlanmış; kesme isteğe bağlı). */
const SUF = `(?:'?[a-z]{1,8})?`;

/** Sayıdan sonra gelirse sayıyı tarih olmaktan çıkaran birimler ("1.5 hafta", "2-3 kişi"). */
const UNIT_WORDS =
  "hafta|gun|gece|kisi|saat|dk|dakika|sn|saniye|yas|yetiskin|cocuk|kat|oda|km|metre|m2|bin|milyon|tl|try|lira|euro|eur|usd|dolar|gbp|sterlin|adet|tane|derece|kg|gr|lt|litre|numara|no";
const UNIT = `\\s*(?:${UNIT_WORDS})\\b`;
const UNIT_AFTER = new RegExp(`^\\s*(?:(?:${UNIT_WORDS})\\b|[$€₺£%])`);

const WEEKDAYS = [
  "pazartesi",
  "sali",
  "carsamba",
  "persembe",
  "cumartesi",
  "cuma",
  "pazar",
] as const;
const WD = `(${WEEKDAYS.join("|")})`;
/** Pazartesi = 0 … Pazar = 6. */
const weekdayIndex = (w: string): number =>
  ({ pazartesi: 0, sali: 1, carsamba: 2, persembe: 3, cuma: 4, cumartesi: 5, pazar: 6 })[
    w as "pazartesi"
  ] ?? -1;

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
};
const NUM = `(\\d{1,2}|${Object.keys(NUM_WORDS).join("|")})`;
const numOf = (raw: string): number => NUM_WORDS[raw] ?? Number(raw);

// ---------------------------------------------------------------------------------------------
// Tipler
// ---------------------------------------------------------------------------------------------

export type DatePart = { day: number; month: number; year: number | null };
type MentionBase = {
  start: number;
  end: number;
  /** Eşleşen metin (katlanmış), ekleriyle birlikte. */
  text: string;
  /** Hemen ardından "dahil" geliyor (bitiş günü konaklamaya dahil). */
  inclusiveAfter: boolean;
  /** Hemen önünde eşleşmemiş "12-" kalmış. */
  orphanBefore: boolean;
  /** Bilgi bayrakları (ay çıkarıldı, göreli, düzeltildi…). */
  info: WaCalendarFlag[];
};
export type RangeMention = MentionBase & { kind: "range"; from: DatePart; to: DatePart };
export type DayMention = MentionBase & {
  kind: "day";
  date: DatePart;
  /** "giriş"/"çıkış" etiketi (yazıldıysa). */
  role: "in" | "out" | null;
  /** "3 gece", "gecesi" (1): giriş + N gece. */
  nights: number | null;
};
/** Tarih olduğu belli ama tek yoruma bağlanamayan ifade: soru sorulur. */
export type UnclearMention = MentionBase & { kind: "unclear"; reason: WaCalendarFlag };
export type DateMention = RangeMention | DayMention | UnclearMention;

export type ResolvedRange = {
  checkIn: string | null;
  checkOut: string | null;
  flags: WaCalendarFlag[];
};

export type DateContext = {
  /** "YYYY-MM-DD" (Europe/Istanbul, mesajın gönderildiği gün). */
  today: string;
  /**
   * Bölümde takvim komutu bağlamı var mı (kapat/aç/iptal, olumsuzları, düzeltme sözcükleri,
   * "ayın", giriş…çıkış). Ay yazılmamış sayılar, göreli ifadeler ve belirsiz ifadeler YALNIZ bu
   * bağlamda tarih sayılır ("15-20 kişi", "yarın temizlik var" tarih değildir).
   */
  operational: boolean;
  /**
   * "X değil Y" düzeltmesi UYGULANMASIN (tarih değiştirme: "20-25 Temmuz değil, 22-27 Temmuz
   * olacak" — eski ve yeni aralık ikisi de gerekir). Varsayılan: düzeltme uygulanır.
   */
  keepCorrected?: boolean;
};

// ---------------------------------------------------------------------------------------------
// Yardımcılar
// ---------------------------------------------------------------------------------------------

const monthOf = (full: string | undefined, short: string | undefined): number =>
  full
    ? MONTHS_FULL.indexOf(full as (typeof MONTHS_FULL)[number]) + 1
    : (MONTHS_SHORT[short ?? ""] ?? 0);

/** Ay kalıbı eşleşmesinden ay numarası (grupsuz metin için). */
function monthFromText(text: string): number {
  const m = new RegExp(`^${MONTH}`).exec(text.trim());
  return m ? monthOf(m[1], m[2]) : 0;
}

const yearOf = (raw: string | undefined): number | null => {
  if (!raw) return null;
  const n = Number(raw);
  return raw.length === 2 ? 2000 + n : n;
};

const iso = (y: number, p: { day: number; month: number }) =>
  `${String(y).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;

const partOf = (isoDate: string): DatePart => ({
  year: Number(isoDate.slice(0, 4)),
  month: Number(isoDate.slice(5, 7)),
  day: Number(isoDate.slice(8, 10)),
});

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** 0 = Pazartesi … 6 = Pazar. */
const weekdayOf = (isoDate: string) => (new Date(`${isoDate}T00:00:00Z`).getUTCDay() + 6) % 7;

/** Bir sonraki ayın ilk günü (ISO). */
const firstOfNextMonth = (isoDate: string) => {
  const y = Number(isoDate.slice(0, 4));
  const m = Number(isoDate.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : iso(y, { day: 1, month: m + 1 });
};

/** Gün ekini bir yönelme (…'e, …'ine, …'a kadar) mi? "15'ine", "15'e", "25'ine". */
const DATIVE = /(?:^'?|[^'])(?:e|a|ye|ya|ne|na|ine|ina|une|una|sine|sina|sune|suna)$/;

// ---------------------------------------------------------------------------------------------
// Kalıplar
// ---------------------------------------------------------------------------------------------

/** "15-20 haziran (2027)", "10'dan 15 Aralık'a", "10 15 Aralık", "10/15 Aralık". */
const RANGE_SAME_MONTH = new RegExp(
  `${DAY}(${SUF})(${DASH}|\\s*/\\s*|(?<!villa\\s{1,3}\\d{1,2}'?[a-z]{0,8})\\s+)(\\d{1,2})(${SUF})\\s*${MONTH}${YEAR}`,
  "g",
);
/** "15 haziran (2027)" */
const DAY_MONTH = new RegExp(`${DAY}\\s*${MONTH}${YEAR}`, "g");
/** "10, 11, 12 Aralık", "10,15 Aralık", "10 ve 12 Aralık". */
const DAY_LIST_MONTH = new RegExp(
  `(?<![\\d.,/:])(\\d{1,2}(?:\\s*,\\s*\\d{1,2})+(?:\\s*(?:,|\\s+ve)\\s*\\d{1,2})?|\\d{1,2}\\s+ve\\s+\\d{1,2})\\s*${MONTH}${YEAR}`,
  "g",
);
/** Ay önde: "Aralık 10-15", "Aralık'ta 10-15", "Aralık'ın 10'u ile 15'i", "Aralık 10 giriş 15". */
const MONTH_FIRST_RANGE = new RegExp(
  `\\b${MONTH}\\s+(\\d{1,2})(?!\\d)(${SUF})(\\s*(?:-|–|—|/)\\s*|\\s+(?:ile|ila|ve|giris\\w*)\\s+|\\s+)(\\d{1,2})(?!\\d)(?![./]\\d)(${SUF})`,
  "g",
);
/** "Aralık 10 - Aralık 15" */
const MONTH_FIRST_TWO = new RegExp(
  `\\b${MONTH}\\s+(\\d{1,2})(?!\\d)${SUF}${DASH}${MONTH_NC}\\s+(\\d{1,2})(?!\\d)`,
  "g",
);
/** "10 Aralık'tan 15'ine kadar" (ikinci gün aynı ay). */
const DAY_MONTH_TO_DAY = new RegExp(
  `${DAY}\\s*${MONTH}${YEAR}(?:\\s+(?:giris\\w*|giriyor\\w*))?(?:${DASH}|\\s*,\\s*|\\s+)(\\d{1,2})(?!\\d)(?![./]\\d)(${SUF})`,
  "g",
);
/** "15.06", "15/06/2027", "15.06.27" */
const NUMERIC_DATE = new RegExp(
  `${DAY}([./])(\\d{1,2})(?:\\2(\\d{4}|\\d{2}))?(?!\\d)(?![.,]\\d)(?!${UNIT})`,
  "g",
);
/** "10.12-15.12", "5.1-10.1", "10.12 / 15.12", "10.12'den 15.12'ye", "10/12/2026-15/12/2026". */
const NUMERIC_FULL_RANGE = new RegExp(
  `${DAY}([./])(\\d{1,2})(?:\\2(\\d{4}|\\d{2}))?(?!\\d)(${SUF})(?:\\s*(?:-|–|—|/)\\s*|\\s+(?:ile|ila)\\s+|\\s+)(\\d{1,2})\\2(\\d{1,2})(?:\\2(\\d{4}|\\d{2}))?(?!\\d)(?![.,]\\d)`,
  "g",
);
/** "10.12-15": ikinci tarihin ayı yazılmamış. */
const NUMERIC_DM_TO_DAY = new RegExp(
  `${DAY}([./])(\\d{2})(?:\\2(\\d{4}|\\d{2}))?\\s*(?:-|–|—)\\s*(\\d{1,2})(?!\\d)(?![./]\\d)(${SUF})`,
  "g",
);
/** Ayı ortak sayısal aralık: "12-18.07", "12-18/07/2027". */
const NUMERIC_RANGE_SAME_MONTH = new RegExp(
  `${DAY}${DASH}(\\d{1,2})([./])(\\d{2})(?:\\3(\\d{4}|\\d{2}))?(?!\\d)(?![.,]\\d)(?!${UNIT})`,
  "g",
);
/** Ay yazılmamış gün çifti (yalnız takvim komutu bağlamında). Önek: gelecek ay. */
const BARE_PAIR = new RegExp(
  `(?<![\\d.,/:])(?<!\\d\\s)(?<!saat\\s{0,3})(?:\\b(onumuzdeki|gelecek|sonraki)\\s+ay(?:in|da|ki)?\\s+)?(\\d{1,2})(?!\\d)(${SUF})(\\s*(?:-|–|—|/|\\.)\\s*|\\s*,\\s*|\\s+(?:ile|ila|ve|giris\\w*)\\s+|\\s+)(\\d{1,2})(?!\\d)(${SUF})(?![.:]\\d)(?!/\\d)(?!\\s+\\d)`,
  "g",
);
/** Aralığın hemen ardından "dahil" (bitiş günü konaklamaya dahil): "dahil", "arası (15 dahil)". */
const INCLUSIVE_AFTER =
  /^\s*(?:'?(?:de|da|te|ta))?\s*(?:arasi\w*\s*)?\(?\s*(?:(\d{1,2})\s*(?:'?[a-z]{0,4})?\s*)?(?:da\s+|de\s+)?dahil\w*/;
/** Bir tarihin hemen önünde kalan "12-" gibi eşleşmemiş aralık başı: tarih belirsizdir. */
const ORPHAN_DASH_BEFORE = /(?:^|[^\d./])(\d{1,2})\s*(?:-|–|—)\s*$/d;
/** Tarihten hemen sonra "değil" (düzeltme). */
const NEGATED_AFTER = /^\s*,?\s*degil\b\s*,?\s*/;
/** Gece sayısı: "15 Aralık giriş 3 gece", "yarından itibaren 3 gece", "15 Aralık gecesi". */
const NIGHTS_AFTER = new RegExp(
  `^(?:'?[a-z]{0,6})?\\s*(?:(?:dan|den|tan|ten)\\s+)?(?:itibaren\\s+|giris\\s+)?${NUM}\\s+gece(?!si)\\b`,
);
const ONE_NIGHT_AFTER = /^(?:'?[a-z]{0,6})?\s+(?:tek\s+)?gecesi\b/;
const ROLE_BEFORE = /(giris|cikis)\w*\s*:?\s*$/;
const ROLE_AFTER = /^(?:'?[a-z]{0,6})?\s+(giris|cikis)\w*/;

// Göreli ifadeler (yalnız takvim komutu bağlamında)
const NEXT_WEEK_RANGE = new RegExp(
  `\\b(?:(?:gelecek|onumuzdeki|sonraki)\\s+hafta(?:ya|nin)?|haftaya)\\s+${WD}${SUF}(?:${DASH}|\\s+)${WD}${SUF}`,
  "g",
);
const WEEKDAY_NIGHT = new RegExp(`\\b(?:bu\\s+)?${WD}\\s+gecesi\\b`, "g");
const TONIGHT = /\bbu\s*gece(?:si)?\b/g;
const NEXT_N_NIGHTS = new RegExp(`\\b(?:onumuzdeki|gelecek)\\s+${NUM}\\s+gece\\b`, "g");
const MONTH_END = /\b(?:bu\s+)?ay(?:in)?\s+son(?:una|u)\s+kadar\b/g;
const WHOLE_MONTH = new RegExp(
  `(?:\\b(?:tum|butun)\\s+)?\\b${MONTH}\\s+ayi(?:nin)?\\s+(?:boyunca|tamami\\w*|komple)|\\b(?:tum|butun)\\s+${MONTH}(?:\\s+ayi\\w*)?`,
  "g",
);
const RELATIVE_DAY = /\b(yarin|obur\s*gun|ertesi\s+gun|bugun)(?:'?[a-z]{0,6})?\b/g;
/** Belirsiz göreli ifadeler: soru sorulur. */
const UNCLEAR_RELATIVE = new RegExp(
  [
    `\\bhafta\\s*sonu\\w*`,
    `\\bhafta\\s*ici\\w*`,
    `\\byil\\s*basi\\w*`,
    `\\bbayram\\w*`,
    `\\b(?:ilk|son)\\s+hafta\\w*`,
    `\\b(?:onumuzdeki|gelecek)\\s+${NUM}\\s+hafta\\w*`,
    `\\b\\d{1,2}(?:'?[a-z]{0,8})?\\s+(?:gun\\s+)?sonra\\b`,
    `\\b${WD}\\w*`,
  ].join("|"),
  "g",
);

// ---------------------------------------------------------------------------------------------
// Tarih ifadelerini bulma
// ---------------------------------------------------------------------------------------------

/**
 * Ünsüz yumuşaması: "Ocağı/Ocağa" (katlanmış "ocag…") gün sayısından sonra Ocak'tır; uzunluk
 * değişmez ("ocag" → "ocak"), konumlar korunur. "Aralığı" hem Aralık hem "aralık (range)"
 * olabileceğinden çevrilmez; gün çiftinden hemen sonra gelirse tarih belirsiz sayılır (⚠️).
 */
const OCAK_MUTATED = /(?<=\d(?:'?[a-z]{0,8})?\s{1,3})ocag(?=[a-z])/g;
const ARALIG_AFTER = /^(?:'?[a-z]{0,4})?\s+aralig[a-z]*/;

export function findDateMentions(rawFolded: string, ctx: DateContext): DateMention[] {
  const folded = rawFolded.replace(OCAK_MUTATED, "ocak");
  const out: DateMention[] = [];
  const taken: [number, number][] = [];
  const free = (s: number, e: number) => taken.every(([a, b]) => e <= a || s >= b);
  const today = ctx.today;
  const ty = Number(today.slice(0, 4));
  const tm = Number(today.slice(5, 7));

  const base = (start: number, end: number, info: WaCalendarFlag[] = []): MentionBase | null => {
    if (!free(start, end)) return null;
    taken.push([start, end]);
    return {
      start,
      end,
      text: folded.slice(start, end),
      inclusiveAfter: false,
      orphanBefore: false,
      info,
    };
  };
  const at = (m: RegExpMatchArray) => [m.index ?? 0, (m.index ?? 0) + m[0].length] as const;
  const range = (b: MentionBase | null, from: DatePart, to: DatePart) => {
    if (b) out.push({ ...b, kind: "range", from, to });
  };
  const day = (b: MentionBase | null, date: DatePart) => {
    if (b) out.push({ ...b, kind: "day", date, role: null, nights: null });
  };
  const unclear = (b: MentionBase | null, reason: WaCalendarFlag) => {
    if (b) out.push({ ...b, kind: "unclear", reason });
  };
  /** Sayının ardından birim geliyor mu ("15-20 kişi", "10-15 dk", "20-25 bin")? */
  const unitAfter = (end: number) => UNIT_AFTER.test(folded.slice(end));
  /** Ay yazılmamış iki gün → bu ay (ya da gelecek ay). */
  const bareRange = (b: MentionBase | null, a: number, z: number, nextMonth: boolean) => {
    if (!b) return;
    const y = nextMonth && tm === 12 ? ty + 1 : ty;
    const m = nextMonth ? (tm % 12) + 1 : tm;
    if (z <= a) return unclear(b, "date_order_reversed");
    if (a < 1 || z > daysInMonth(y, m)) return unclear(b, "date_unclear");
    b.info = [...b.info, "month_inferred"];
    range(b, { day: a, month: m, year: y }, { day: z, month: m, year: y });
  };

  if (ctx.operational) {
    // --- Desteklenen göreli ifadeler -----------------------------------------------------------
    for (const m of folded.matchAll(NEXT_WEEK_RANGE)) {
      const [s, e] = at(m);
      const b = base(s, e, ["date_relative"]);
      if (!b) continue;
      const nextMonday = addDays(today, 7 - weekdayOf(today));
      const d1 = addDays(nextMonday, weekdayIndex(m[1]!));
      const d2 = addDays(nextMonday, weekdayIndex(m[2]!));
      if (d2 <= d1) unclear(b, "date_order_reversed");
      else range(b, partOf(d1), partOf(d2));
    }
    for (const m of folded.matchAll(WEEKDAY_NIGHT)) {
      const [s, e] = at(m);
      const delta = (weekdayIndex(m[1]!) - weekdayOf(today) + 7) % 7;
      const d = addDays(today, delta);
      range(base(s, e, ["date_relative"]), partOf(d), partOf(addDays(d, 1)));
    }
    for (const m of folded.matchAll(TONIGHT)) {
      const [s, e] = at(m);
      range(base(s, e, ["date_relative"]), partOf(today), partOf(addDays(today, 1)));
    }
    for (const m of folded.matchAll(NEXT_N_NIGHTS)) {
      const [s, e] = at(m);
      const n = numOf(m[1]!);
      if (n >= 1) range(base(s, e, ["date_relative"]), partOf(today), partOf(addDays(today, n)));
    }
    for (const m of folded.matchAll(MONTH_END)) {
      const [s, e] = at(m);
      range(base(s, e, ["date_relative"]), partOf(today), partOf(firstOfNextMonth(today)));
    }
    for (const m of folded.matchAll(WHOLE_MONTH)) {
      const [s, e] = at(m);
      const month = monthOf(m[1] ?? m[3], m[2] ?? m[4]);
      if (!month) continue;
      const to = month === 12 ? 1 : month + 1;
      range(
        base(s, e, ["date_relative"]),
        { day: 1, month, year: null },
        {
          day: 1,
          month: to,
          year: null,
        },
      );
    }
  }

  // --- Ay adlı kalıplar -----------------------------------------------------------------------
  for (const m of folded.matchAll(DAY_LIST_MONTH)) {
    const [s, e] = at(m);
    const days = m[1]!.split(/\s*(?:,|\bve\b)\s*/).map(Number);
    const month = monthOf(m[2], m[3]);
    const year = yearOf(m[4]);
    const arasi = /^\s*(?:'?[a-z]{0,4})?\s*arasi/.test(folded.slice(e));
    const b = base(s, e);
    if (!b) continue;
    if (days.length === 2 && arasi) {
      range(b, { day: days[0]!, month, year }, { day: days[1]!, month, year });
    } else if (days.length >= 3 && days.every((d, i) => i === 0 || d === days[i - 1]! + 1)) {
      // Ardışık gün listesi = o günlerin geceleri: "10, 11, 12 Aralık" → 10 → 13.
      b.info = ["day_list"];
      b.inclusiveAfter = true;
      range(b, { day: days[0]!, month, year }, { day: days.at(-1)!, month, year });
    } else {
      unclear(b, "date_list");
    }
  }
  for (const m of folded.matchAll(RANGE_SAME_MONTH)) {
    const [s, e] = at(m);
    if (!free(s, e)) continue;
    const sep = m[3]!;
    // Boşlukla ayrılmış ve ilk günde ek yoksa yalnız artan iki gün aralıktır ("10 15 Aralık").
    if (/^\s+$/.test(sep) && !m[2] && Number(m[4]) <= Number(m[1])) continue;
    const month = monthOf(m[6], m[7]);
    const year = yearOf(m[8]);
    range(base(s, e), { day: Number(m[1]), month, year }, { day: Number(m[4]), month, year });
  }
  for (const m of folded.matchAll(MONTH_FIRST_TWO)) {
    const [s, e] = at(m);
    const month = monthOf(m[1], m[2]);
    const month2 = monthFromText(m[0].slice(m[0].search(/[-–—]|ile|ila/) + 1));
    range(
      base(s, e),
      { day: Number(m[3]), month, year: null },
      {
        day: Number(m[4]),
        month: month2 || month,
        year: null,
      },
    );
  }
  for (const m of folded.matchAll(MONTH_FIRST_RANGE)) {
    const [s, e] = at(m);
    if (unitAfter(e)) continue;
    const month = monthOf(m[1], m[2]);
    const a = Number(m[3]);
    const z = Number(m[6]);
    const b = base(s, e);
    if (!b) continue;
    if (z <= a) unclear(b, "date_order_reversed");
    else range(b, { day: a, month, year: null }, { day: z, month, year: null });
  }
  for (const m of folded.matchAll(DAY_MONTH_TO_DAY)) {
    const [s, e] = at(m);
    const after = folded.slice(e);
    if (new RegExp(`^\\s*${MONTH}`).test(after) || unitAfter(e)) continue;
    // İkinci gün yalnız "…'ine / …'e (kadar)", "arası" ya da "çıkış" ile bağlanırsa aynı ayın günüdür.
    const suffix = m[6] ?? "";
    if (!DATIVE.test(suffix) && !/^\s*(?:kadar|arasi|cikis|cikiyor)/.test(after)) continue;
    const month = monthOf(m[2], m[3]);
    const year = yearOf(m[4]);
    const a = Number(m[1]);
    const z = Number(m[5]);
    const b = base(s, e);
    if (!b) continue;
    if (z <= a) unclear(b, "date_order_reversed");
    else range(b, { day: a, month, year }, { day: z, month, year });
  }
  // --- Sayısal kalıplar -----------------------------------------------------------------------
  for (const m of folded.matchAll(NUMERIC_FULL_RANGE)) {
    const m1 = Number(m[3]);
    const m2 = Number(m[7]);
    if (m1 < 1 || m1 > 12 || m2 < 1 || m2 > 12) continue;
    const [s, e] = at(m);
    range(
      base(s, e),
      { day: Number(m[1]), month: m1, year: yearOf(m[4]) },
      {
        day: Number(m[6]),
        month: m2,
        year: yearOf(m[8]),
      },
    );
  }
  for (const m of folded.matchAll(NUMERIC_DM_TO_DAY)) {
    const month = Number(m[3]);
    if (month < 1 || month > 12) continue;
    const [s, e] = at(m);
    if (unitAfter(e)) continue;
    const year = yearOf(m[4]);
    const a = Number(m[1]);
    const z = Number(m[5]);
    const b = base(s, e);
    if (!b) continue;
    if (z <= a) unclear(b, "date_order_reversed");
    else range(b, { day: a, month, year }, { day: z, month, year });
  }
  for (const m of folded.matchAll(NUMERIC_RANGE_SAME_MONTH)) {
    const month = Number(m[4]);
    if (month < 1 || month > 12) continue;
    const [s, e] = at(m);
    const year = yearOf(m[5]);
    range(base(s, e), { day: Number(m[1]), month, year }, { day: Number(m[2]), month, year });
  }
  for (const m of folded.matchAll(DAY_MONTH)) {
    const [s, e] = at(m);
    day(base(s, e), { day: Number(m[1]), month: monthOf(m[2], m[3]), year: yearOf(m[4]) });
  }
  for (const m of folded.matchAll(NUMERIC_DATE)) {
    const sep = m[2];
    const rawMonth = m[3] ?? "";
    const month = Number(rawMonth);
    if (month < 1 || month > 12) continue;
    // Noktalı, yılsız ve tek haneli ay ("1.5", "2.5") ondalık sayıdır.
    if (sep === "." && !m[4] && rawMonth.length < 2) continue;
    const [s, e] = at(m);
    // "10.06'da" gibi saat/konum eki tek tarih için sorun değil; "10.15'te" zaten ay > 12.
    day(base(s, e), { day: Number(m[1]), month, year: yearOf(m[4]) });
  }

  if (ctx.operational) {
    // --- Göreli günler ("yarın", "bugün", "öbür gün") ------------------------------------------
    for (const m of folded.matchAll(RELATIVE_DAY)) {
      const [s, e] = at(m);
      const w = m[1]!.replace(/\s+/g, " ");
      const offset = w === "bugun" ? 0 : w === "yarin" ? 1 : 2;
      day(base(s, e, ["date_relative"]), partOf(addDays(today, offset)));
    }
    // --- Belirsiz göreli ifadeler (tahmin yok) -------------------------------------------------
    for (const m of folded.matchAll(UNCLEAR_RELATIVE)) {
      const [s, e] = at(m);
      unclear(base(s, e), "date_unclear");
    }
    // --- Ay yazılmamış gün çiftleri ------------------------------------------------------------
    for (const m of folded.matchAll(BARE_PAIR)) {
      const [s, e] = at(m);
      if (!free(s, e) || unitAfter(e)) continue;
      const sep = m[4]!;
      const a = Number(m[2]);
      const z = Number(m[5]);
      const suf2 = m[6] ?? "";
      // "10.15'te", "saat 10.15": saat; "10.06" ve "10/06" zaten sayısal tarih (ay ≤ 12).
      if (/[./]/.test(sep) && (z <= 12 || /^'?(?:te|ta|de|da)$/.test(suf2))) continue;
      if (/^'?(?:te|ta|de|da)$/.test(m[3] ?? "") && /^\s+$/.test(sep)) continue;
      const after = folded.slice(e);
      const arasi = /^\s*(?:'?[a-z]{0,4})?\s*arasi/.test(after);
      const b = base(s, e);
      if (!b) continue;
      if (ARALIG_AFTER.test(after)) unclear(b, "date_unclear");
      else if (/,/.test(sep) || (/\bve\b/.test(sep) && !arasi)) unclear(b, "date_list");
      else bareRange(b, a, z, !!m[1]);
    }
  }

  // --- Sonrası: dahil, etiket, gece sayısı, yetim aralık başı ----------------------------------
  for (const d of out) {
    const after = folded.slice(d.end);
    const inc = INCLUSIVE_AFTER.exec(after);
    if (inc && d.kind === "range" && (!inc[1] || Number(inc[1]) === d.to.day)) {
      d.inclusiveAfter = true;
    }
    if (inc && d.kind === "day" && !inc[1]) d.inclusiveAfter = true;
    if (d.kind === "day") {
      const role = ROLE_BEFORE.exec(folded.slice(0, d.start)) ?? ROLE_AFTER.exec(after);
      d.role = role ? (role[1] === "giris" ? "in" : "out") : null;
      const n = NIGHTS_AFTER.exec(after);
      if (n) d.nights = numOf(n[1]!);
      else if (ONE_NIGHT_AFTER.test(after)) d.nights = 1;
    }
    const m = ORPHAN_DASH_BEFORE.exec(folded.slice(0, d.start));
    const pos = m?.indices?.[1]?.[0];
    d.orphanBefore = pos !== undefined && free(pos, pos + 1);
  }

  const sorted = out.sort((a, b) => a.start - b.start);
  return ctx.keepCorrected ? sorted : applyCorrections(folded, sorted);
}

/**
 * "X değil Y" düzeltmeleri: "değil"den hemen önceki tarih ifadesi atılır. Ardından yalnız bir ay
 * adı geliyorsa ("10-15 Aralık değil, Ocak") aynı günler o ayla yeniden kurulur.
 */
function applyCorrections(folded: string, dates: DateMention[]): DateMention[] {
  const out: DateMention[] = [];
  let corrected = false;
  for (const [i, d] of dates.entries()) {
    const neg = NEGATED_AFTER.exec(folded.slice(d.end));
    if (!neg) {
      out.push(d);
      continue;
    }
    corrected = true;
    const restStart = d.end + neg[0].length;
    const next = dates[i + 1];
    const monthMatch = new RegExp(`^${MONTH}${YEAR}`).exec(folded.slice(restStart));
    const replacesMonth =
      monthMatch &&
      (!next || next.start >= restStart + monthMatch[0].length) &&
      d.kind !== "unclear";
    if (replacesMonth) {
      const month = monthOf(monthMatch[1], monthMatch[2]);
      const year = yearOf(monthMatch[3]);
      if (d.kind === "range") {
        out.push({
          ...d,
          end: restStart + monthMatch[0].length,
          info: [...d.info, "date_corrected"],
          from: { day: d.from.day, month, year },
          to: { day: d.to.day, month, year },
        });
      } else {
        out.push({
          ...d,
          end: restStart + monthMatch[0].length,
          info: [...d.info, "date_corrected"],
          date: { day: d.date.day, month, year },
        });
      }
    }
  }
  if (corrected)
    for (const d of out) if (!d.info.includes("date_corrected")) d.info.push("date_corrected");
  return out;
}

// ---------------------------------------------------------------------------------------------
// Yıl ve aralık çözümü
// ---------------------------------------------------------------------------------------------

/**
 * [from, to) aralığının yıllarını belirler ve tarih bayraklarını üretir. `inclusiveEnd`: bitiş
 * günü konaklamaya dahil yazıldı ("dahil") → çıkış = bitiş + 1 gün.
 */
export function resolveRange(
  from: DatePart,
  to: DatePart,
  today: string,
  inclusiveEnd = false,
  info: WaCalendarFlag[] = [],
): ResolvedRange {
  const thisYear = Number(today.slice(0, 4));
  // Aynı ay içinde ters sıra ("25-20", "Çıkış 15 / giriş 10" etiketsiz): tahmin yok.
  const sameYear = from.year === null || to.year === null || from.year === to.year;
  const reversedSameMonth =
    from.month === to.month && sameYear && to.day < from.day + (inclusiveEnd ? 0 : 1);
  if (reversedSameMonth && !(inclusiveEnd && to.day === from.day)) {
    return { checkIn: null, checkOut: null, flags: ["date_order_reversed"] };
  }
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
  const flags: WaCalendarFlag[] = [...info];
  if (inclusiveEnd && !info.includes("day_list")) flags.push("end_inclusive");
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
export function resolveSingle(
  p: DatePart,
  today: string,
  info: WaCalendarFlag[] = [],
): ResolvedRange {
  const flags: WaCalendarFlag[] = ["date_incomplete", ...info];
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

/** Tek gün + gece sayısı → aralık ("15 Aralık giriş 3 gece", "yarından itibaren 2 gece"). */
function resolveNights(p: DatePart, nights: number, today: string, info: WaCalendarFlag[]) {
  const single = resolveSingle(p, today);
  if (!single.checkIn) return single;
  // Yıl resolveSingle'da belirlendi; aralık açık yılla kurulur, yıl bayrakları taşınır.
  const carried = single.flags.filter(
    (f) => f === "year_inferred" || f === "year_ambiguous",
  ) as WaCalendarFlag[];
  return resolveRange(
    partOf(single.checkIn),
    partOf(addDays(single.checkIn, nights)),
    today,
    false,
    [...info, "nights_count", ...carried],
  );
}

const AMBIGUOUS_DATES: ResolvedRange = { checkIn: null, checkOut: null, flags: ["date_ambiguous"] };

/** Bir bölümdeki tarih ifadelerini aralıklara çevirir (belirsizse tek, boş, bayraklı aralık). */
export function rangesOf(dates: DateMention[], today: string): ResolvedRange[] {
  if (dates.length === 0) return [{ checkIn: null, checkOut: null, flags: ["date_missing"] }];
  const unclearOne = dates.find((d): d is UnclearMention => d.kind === "unclear");
  if (unclearOne) {
    return [{ checkIn: null, checkOut: null, flags: ["date_ambiguous", unclearOne.reason] }];
  }
  // "12-…" gibi eşleşmeyen bir aralık başı varsa tarih tahmin edilmez.
  if (dates.some((d) => d.orphanBefore)) return [AMBIGUOUS_DATES];
  const ranges = dates.filter((d): d is RangeMention => d.kind === "range");
  const days = dates.filter((d): d is DayMention => d.kind === "day");
  const resolveR = (r: RangeMention) => resolveRange(r.from, r.to, today, r.inclusiveAfter, r.info);
  if (days.length === 0) return ranges.map(resolveR);
  if (ranges.length === 0 && days.length === 2) {
    let [a, b] = days as [DayMention, DayMention];
    // "Çıkış 15 Aralık, giriş 10 Aralık": etiketler esas alınır.
    if (a.role === "out" && b.role === "in") [a, b] = [b, a];
    return [resolveRange(a.date, b.date, today, b.inclusiveAfter, [...a.info, ...b.info])];
  }
  if (ranges.length === 0 && days.length === 1) {
    const d = days[0]!;
    if (d.nights !== null && d.nights >= 1) return [resolveNights(d.date, d.nights, today, d.info)];
    return [resolveSingle(d.date, today, d.info)];
  }
  return [AMBIGUOUS_DATES];
}

// ---------------------------------------------------------------------------------------------
// Açıklama sorusu (⚠️ ile birlikte gönderilecek metin; ağ geçidinin metin kuyruğu için hazır)
// ---------------------------------------------------------------------------------------------

const TR_MONTHS = [
  "Ocak",
  "Şubat",
  "Mart",
  "Nisan",
  "Mayıs",
  "Haziran",
  "Temmuz",
  "Ağustos",
  "Eylül",
  "Ekim",
  "Kasım",
  "Aralık",
];
/** "2026-12-10" → "10 Aralık 2026" */
export const trDate = (isoDate: string) =>
  `${Number(isoDate.slice(8, 10))} ${TR_MONTHS[Number(isoDate.slice(5, 7)) - 1]} ${isoDate.slice(0, 4)}`;

/**
 * Tarih işlem yapılamayacak kadar belirsizse gönderilecek kısa Türkçe soru; tarih açık ve
 * işlenebilirse null. Kişisel bilgi içermez (yalnız tarih ve neden).
 */
export function dateClarification(r: {
  checkIn: string | null;
  checkOut: string | null;
  flags: readonly string[];
}): string | null {
  const f = new Set(r.flags);
  const example = 'Örnek: "20-25 Aralık kapatalım".';
  if (f.has("date_order_reversed")) {
    return `Bitiş tarihi başlangıçtan önce görünüyor. Giriş ve çıkış tarihlerini ay adıyla yazar mısınız? ${example}`;
  }
  if (f.has("date_list")) {
    return `Bu günler tek bir aralık mı, ayrı ayrı günler mi? Lütfen giriş ve çıkış tarihini yazın. ${example}`;
  }
  if (f.has("date_unclear")) {
    return `Hangi tarihleri kastettiğinizi kesin anlayamadım. Giriş ve çıkış tarihini gün ve ay olarak yazar mısınız? ${example}`;
  }
  if (f.has("date_invalid")) return `Yazılan tarih takvimde yok. Tarihi kontrol eder misiniz?`;
  if (f.has("date_past") && r.checkIn && r.checkOut) {
    return `${trDate(r.checkIn)} – ${trDate(r.checkOut)} geçmişte kalıyor. Başka bir ay mı kastettiniz?`;
  }
  if (f.has("in_progress") && r.checkIn && r.checkOut) {
    return `${trDate(r.checkIn)} geçmişte kalıyor. İşlem bugünden mi başlasın, yoksa başka bir ay mı kastettiniz?`;
  }
  if (f.has("year_ambiguous") && r.checkIn) {
    return `${trDate(r.checkIn)} yaklaşık bir yıl sonrası. Doğru yıl mı? Yılı da yazar mısınız?`;
  }
  if (f.has("range_too_long")) {
    return `Aralık ${WA_CALENDAR_MAX_NIGHTS} geceden uzun. Tarihleri kontrol eder misiniz?`;
  }
  if (f.has("date_incomplete") && r.checkIn) {
    return `Yalnız ${trDate(r.checkIn)} yazılmış. Kaç gece ya da çıkış tarihi nedir?`;
  }
  if (f.has("date_missing") || f.has("date_ambiguous")) {
    return `Tarihleri anlayamadım. Giriş ve çıkış tarihini yazar mısınız? ${example}`;
  }
  return null;
}
