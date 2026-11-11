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
import { isIsoDate, nightsBetween } from "./reservation-meta";
import {
  type DateMention,
  findDateMentions,
  MONTH_ONLY,
  MONTHS_FULL,
  type ResolvedRange,
  rangesOf,
  STARTS_WITH_MONTH,
} from "./wa-date-parse";

/**
 * Ayrıştırıcı sürümü: öneri kaydına yazılır (kurallar değişince artırılır).
 *  1: ilk sürüm.
 *  2: "misafir/rezervasyon yok" belirsiz; "dahil" bitiş; tarih değişikliği (date_change);
 *     "12-18.07"; "1.5 hafta" ve "saat 10.06" tarih değil; villa adı ile eylem ayrımı;
 *     reviewRequirement (güven puanı güvenlik kurallarını aşamaz).
 *  3: "giriş … çıkış" + açık "kapat" talimatı kapatmadır (önceden belirsiz).
 *  4: tarihler merkezi modülden (wa-date-parse.ts): ay yazılmamış aralıklar (bu ay), ayı önde
 *     yazım, sayısal çeşitler, gece sayısı, göreli ifadeler, "dahil" çeşitleri, "X değil Y"
 *     düzeltmesi, giriş/çıkış etiketi; ters sıra ve belirsiz ifadelerde soru. Olumsuz eylem
 *     ("kapatmayalım", "açmayın") eylemi iptal eder; fiyat sorusu işlem değildir; tarihi
 *     anlaşılamayan takvim komutu ⚠️ alır.
 */
export const WA_CALENDAR_PARSER_VERSION = 5;

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
  // --- Sürüm 4 (merkezi tarih modülü) --------------------------------------------------------
  /** Ay yazılmadı; günler bu ayın (ya da "gelecek ay") günleri sayıldı (bilgi). */
  "month_inferred",
  /** Tarih göreli ifadeden hesaplandı ("yarın", "bu gece", "gelecek hafta"…; bilgi). */
  "date_relative",
  /** "X değil Y" düzeltmesi uygulandı (bilgi). */
  "date_corrected",
  /** Çıkış, giriş + gece sayısından hesaplandı ("3 gece", "gecesi"; bilgi). */
  "nights_count",
  /** Ardışık gün listesi ("10, 11, 12 Aralık") gecelere çevrildi (bilgi). */
  "day_list",
  /** Bitiş başlangıçtan önce ("25-20", "28-3 Ocak"): tahmin yok, soru. */
  "date_order_reversed",
  /** Ardışık olmayan gün listesi ya da "10,15": aralık mı ayrı günler mi belirsiz. */
  "date_list",
  /** Göreli ya da kısmi ifade tek bir tarihe bağlanamıyor (hafta sonu, bayram, "N gün sonra"…). */
  "date_unclear",
  /** Eylem olumsuz ("kapatmayalım", "açmayın"): işlem yok. */
  "action_negated",
] as const;
export type WaCalendarFlag = (typeof WA_CALENDAR_FLAGS)[number];

/** Aralık sınırı ve yıl belirsizliği eşikleri merkezi tarih modülündedir. */
export { WA_CALENDAR_MAX_NIGHTS, WA_CALENDAR_YEAR_AMBIGUOUS_DAYS } from "./wa-date-parse";
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
// Tarih değişikliği sözcükleri (tarihler merkezi modülden: wa-date-parse.ts)
// ---------------------------------------------------------------------------------------------

/** "…'dan/'den …'a/'e" ve değişiklik sözcükleri: tarih değişikliği. */
const FROM_SUFFIX = /(?:dan|den|tan|ten)$/;
const CHANGE_WORDS = /\b(?:kaydir\w*|ertele\w*|degis\w*|tasin\w*|tasidi\w*|guncellen\w*|yerine)\b/;

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
  /\b(?:misafir\w*|rezervasyon\w*|kimse|musteri\w*|kiraci\w*)\s+(?:yok\w*|olmayacak\w*)|\b(?:misafir\w*|kimse|musteri\w*|kiraci\w*)\s+gelmedi\w*/g;

/**
 * Rezervasyonun düştüğünü bildiren AÇMA kalıpları (v5). Yalnız takvim BLOKLARI kaldırılır; gerçek
 * rezervasyon kaydı hiç değişmez (auto-open.ts: aralıkta rezervasyon varsa işlem yok, ⚠️). Bu
 * kalıplar ve iptal sözcükleri yalnız AÇIK tarih aralığıyla işlem yapar (göreli tarih ⚠️).
 * Önce aranır ve metinden çıkarılır ("kapatmayı kaldır" olumsuz kapatma değildir).
 */
const OPEN_PHRASES: RegExp[] = [
  /\b(?:rezervasyon\w*|blok\w*|blog\w*|kapatma\w*|kapama\w*|kapali\w*)\s+kaldir\w*/g,
  /\b(?:misafir\w*|kimse|musteri\w*|kiraci\w*)\s+(?:gelmeyecek\w*|gelmiyor\w*)/g,
  /\bbosa\s+(?:cikar\w*|cikti\w*|cikmis\w*)/g,
];

/**
 * Rezervasyonun ALINDIĞINI bildiren KAPATMA kalıpları (v5): "rezervasyon alındı/yapıldı/geldi",
 * "misafir aldı/gelecek/var". Yeni rezervasyon kaydı OLUŞTURULMAZ; yalnız takvim kapatılır.
 * Ad sözcüğü (rezervasyon, misafir) tek başına ACTION_WORDS'te "reserve" kalır (⚠️); bu yüzden
 * kalıplar önce aranır ve metinden çıkarılır. Sayı + "misafir" kişi sayısı olabileceğinden bu
 * kalıplar ay yazılmamış sayıları tarih yapmaz (OPERATIONAL_CONTEXT'te yalnız RESERVATION_DONE).
 */
const RESERVATION_DONE =
  /\brezervasyon\w*\s+(?:(?:da|de)\s+)?(?:alindi|aldik|aldim|aldi|alinmis|yapildi|yaptik|yaptim|yapti|yapilmis|geldi|gelmis|olustu|kesinlesti|onaylandi|var)\b|\brezerve\s+(?:edildi|ettik|oldu|edilmis)\b/;
const RESERVED_PHRASES =
  /\brezervasyon\w*\s+(?:(?:da|de)\s+)?(?:alindi|aldik|aldim|aldi|alinmis|yapildi|yaptik|yaptim|yapti|yapilmis|geldi|gelmis|olustu|kesinlesti|onaylandi|var)\b|\brezerve\s+(?:edildi|ettik|oldu|edilmis)\b|\bmisafir\w*\s+(?:aldi\w*|aldik|aldim|alindi|var|geliyor\w*|gelecek\w*|girecek\w*|girdi\w*|kalacak\w*|kaliyor\w*)/g;

/**
 * Kapatma sözcükleri. v5: "doldur", "kiralandı / kiraladık", "kiraya verdik", "başkasına
 * verdik", "satıldı / sattık", "tutuldu" (önceden "kiralandı/satıldı" rezervasyon sayılıyordu;
 * artık yalnız takvim kapatılır, rezervasyon kaydı oluşturulmaz).
 */
const CLOSE_WORDS =
  /\bkapa(?:li\w*|t\w*|n\w*)|\bdolu\b|\bblok\w*|\bsatma(?:yalim|yin|yiniz|yacag\w*)?\b|\bverme(?:yin|yelim|yiniz)?\b|\bdoldur\w*|\bkirala(?:ndi\w*|nmis\w*|dik|dim|di|diniz|dilar)\b|\b(?:kiraya|baskasina)\s+(?:verildi\w*|verdik|verdim|verdi|verilmis\w*|verecegiz|veriyoruz|verelim|kiraladik)\b|\bsat(?:ildi\w*|ilmis\w*|tik|tim)\b|\btutul(?:du\w*|mus\w*)|\btuttular\b/;

/**
 * Açık kapatma talimatı veya durum ("kapat", "dolu", "blokla", "satmayalım", "doldur").
 * Yalnız bildirim sözcükleri ("kiralandı", "satıldı", "tutuldu", "kiraya verdik") tarih YOKSA ⚠️
 * almaz: sohbet olabilir ("ayakkabı satıldı 20 TL").
 */
const STRONG_CLOSE =
  /\bkapa(?:li\w*|t\w*|n\w*)|\bdolu\b|\bblok\w*|\bsatma(?:yalim|yin|yiniz|yacag\w*)?\b|\bverme(?:yin|yelim|yiniz)?\b|\bdoldur\w*/;
/**
 * "doldur" yalnız takvim için kapatmadır. Metinde takvim dışı bir NESNE varsa ("formu doldur",
 * "havuzu 20-25 Aralık doldurun") eylem sayılmaz: belirtme hâli (-ı/-i/-u/-ü) taşıyan, tarih /
 * takvim / villa / ay / gün dışı bir sözcük aranır. Yanlış ret güvenlidir (⚠️ değil, işlem yok).
 */
const FILL_WORD = /\bdoldur\w*/g;
const CALENDAR_OBJECT =
  /^(?:tarih\w*|takvim\w*|villa\w*|gun\w*|aralig\w*|hafta\w*|ay\w*|gece\w*|bu|su|o|simdi|hemen|hepsi|kisi|lutfen)$/;
function fillsNonCalendarObject(text: string): boolean {
  for (const m of text.matchAll(/[a-z]+(?:'[a-z]+)?/g)) {
    const w = m[0];
    if (w.includes("'") || w.startsWith("doldur") || w.length < 3) continue;
    if (CALENDAR_OBJECT.test(w) || MONTH_ONLY.test(w) || STARTS_WITH_MONTH.test(w)) continue;
    if (/(?:yi|yu|[^aeiou][iu])$/.test(w)) return true;
  }
  return false;
}

const ACTION_WORDS: { re: RegExp; action: WaCalendarAction }[] = [
  { re: /\biptal\w*|\bvazgec\w*/, action: "cancel" },
  {
    re: CLOSE_WORDS,
    action: "close",
  },
  {
    re: /\brezervasyon\w*|\brezerve\b|\bmisafir\w*|\bopsiyon\w*/,
    action: "reserve",
  },
  {
    re: /\bac(?:alim|in|iniz|ildi|ilsin|abiliriz|abilirsiniz|tik|tim|iyoruz|ik|iyorum|mak|mamiz|maliyiz)?\b|\bmusait\b|\bbos\b|\bserbest\b|\bbosalt\w*/,
    action: "open",
  },
];

/**
 * Daha önce yapılmış kapatmaya ATIF ("kapattığımız", "kapatılan", "kapalı olan … tarihleri"):
 * eylem değil, açılacak tarihleri niteler. Yalnız metinde açma sözcüğü de varsa yok sayılır
 * ("daha önce kapattığımız 5-10 Ocak tarihlerini serbest bırakalım" → açma). Tek başına
 * ("10-15 Aralık'ı kapattık") kapatma bildirimi olarak kalır.
 */
const CLOSE_REFERENCE = /\bkapat(?:tig|tik|il|ilmis)\w*|\bkapadig\w*|\bkapali\s+olan\w*/g;

const QUESTION = /\?|\bm[iu](?:\s|$|[.,!])/;
/**
 * Olumsuz eylem ("kapatmayalım", "kapatma", "kapatmayın", "açmayalım", "açmayın"): o eylem
 * İPTAL olur, karşıt eylem doğmaz. "kapatmak"/"açmak" (mastar) olumsuz değildir; "satmayalım" ve
 * "vermeyelim" anlamı gereği kapatmadır (ACTION_WORDS).
 */
const NEGATED_VERBS: { re: RegExp; action: WaCalendarAction }[] = [
  // "dolu yapmayalım", "müsait yapmayın": önce (yoksa "dolu"/"müsait" tek başına eylem sayılır).
  { re: /\b(?:dolu|kapali)\s+yap(?:ma(?!k)|may|mam)\w*/g, action: "close" },
  { re: /\b(?:musait|bos|acik)\s+yap(?:ma(?!k)|may|mam)\w*/g, action: "open" },
  { re: /\bkapat(?:ma(?!k)|may|mam)\w*/g, action: "close" },
  { re: /\bac(?:ma(?!k)|may|mam)\w*/g, action: "open" },
  // v5 olumsuz bildirimler: "kiralanmadı", "rezervasyon alınmadı", "satılmadı", "kiraya
  // vermedik", "misafir almadık", "doldurmayalım", "tutulmadı" → kapatma YOK, tepki yok.
  // "kiralama/kiralamaya/kiralamadan" ad olarak kullanılır; yalnız çekimli olumsuz biçimler.
  {
    re: /\bkiralan(?:ma|mi)\w*|\bkirala(?:madi\w*|mayalim|mayin|mayacag\w*|mamis\w*|miyor\w*)|\bsat(?:ilma\w*|ilmi\w*|madi\w*|mamis\w*|miyor\w*)|\b(?:kiraya|baskasina)\s+ver(?:me|mi|ilme|ilmi)\w*|\bdoldur(?:ma(?!k)|may|mam)\w*|\btutulma\w*/g,
    action: "close",
  },
  {
    re: /\b(?:rezervasyon\w*|misafir\w*)\s+(?:(?:da|de)\s+)?(?:alinma\w*|alma(?!k)\w*|yapilma\w*|yapma(?!k)\w*|gelme(?!k)\w*|olusma\w*)/g,
    action: "close",
  },
  // "iptal etmeyelim", "vazgeçmedik": iptal (dolayısıyla açma) YOK.
  {
    re: /\biptal\s+(?:etme(?!k)|etmey|etmem|edilme|olma(?!k)|olmay|olmadi)\w*|\bvazgec(?:me(?!k)|mey|mem|ilme)\w*/g,
    action: "cancel",
  },
];
/** Fiyat / ücret sorusu: eylem yoksa işlem değil, soru. */
const PRICE_QUESTION = /\bfiyat\w*|\bucret\w*|\bkac\s+para\b|\bne\s+kadar\b|\bnedir\b/;
/**
 * Takvim komutu bağlamı (merkezi tarih modülüne): ay yazılmamış sayılar ve göreli ifadeler yalnız
 * bu bağlamda tarih sayılır ("15-20 kişi", "yarın temizlik var" tarih değildir).
 */
const OPERATIONAL_CONTEXT_WORDS =
  /\bkapa(?:li|t|n)\w*|\bdolu\b|\bblok\w*|\bsatma\w*|\bverme(?:yin|yelim|yiniz)?\b|\bdoldur\w*|\bkirala(?:ndi|nmis|dik|dim|di)\w*|\b(?:kiraya|baskasina)\s+ver\w*|\bsat(?:ildi|ilmis|tik|tim)\w*|\btutul\w*|\btuttular\b|\bkaldir\w*|\bbosa\s+cik\w*|\bac(?:alim|in|iniz|ildi|ilsin|abiliriz|abilirsiniz|tik|tim|iyoruz|ik|iyorum|ma|may|mam)\w*|\bmusait\w*|\bbos\b|\bserbest\b|\bbosalt\w*|\biptal\w*|\bvazgec\w*|\bdegil\b|\byanlis\s+yaz\w*|\bpardon\b|\bduzelt\w*|\bolacak\b|\byerine\b|\bayin\b|\bgiris\b[\s\S]*\bcikis\b|\bcikis\b[\s\S]*\bgiris\b/;
const OPERATIONAL_CONTEXT = {
  test: (t: string) => OPERATIONAL_CONTEXT_WORDS.test(t) || RESERVATION_DONE.test(t),
};
/** Tarihi anlaşılamayan takvim komutu ⚠️ alır; tarih izi yoksa ("kapıyı kapat") sohbettir. */
const DATE_TRACE =
  /\d|\btarih\w*|\bhafta\w*|\bgece\w*|\byarin\w*|\bbugun\w*|\bbayram\w*|\byil\s*basi\w*|\b(?:pazartesi|sali|carsamba|persembe|cuma|cumartesi|pazar)\w*/;
const OPTION = /\bopsiyon\w*/;
const CHECK_IN_OUT = /\bgiris\b[\s\S]*\bcikis\b|\bcikis\b[\s\S]*\bgiris\b/;
/** Açık kapatma TALİMATI ("kapat", "kapatalım", "kapatın"); "kapalı"/"dolu" durum bildirir. */
const CLOSE_COMMAND = /\bkapat\w*/;

type ActionResult = {
  action: WaCalendarAction | null;
  clear: boolean;
  flags: WaCalendarFlag[];
  pending: boolean;
  /** Yalnız olumsuz eylem var ("20-25 Aralık kapatmayalım"): işlem yok, tepki yok. */
  negatedOnly?: boolean;
  /**
   * İptal / rezervasyon düştü kaynaklı açma (v5): yalnız AÇIK tarih aralığıyla işlem yapılır
   * (göreli tarih, "N gece" → ⚠️).
   */
  strictDates?: boolean;
  /**
   * Yalnız rezervasyon/misafir kalıbıyla kapatma (v5): tarih yoksa ⚠️ verilmez (kişi sayısı
   * olabilir: "15-20 misafir gelecek").
   */
  weak?: boolean;
};

function detectAction(folded: string): ActionResult {
  if (QUESTION.test(folded)) {
    return { action: null, clear: false, flags: ["question"], pending: false };
  }
  const found = new Set<WaCalendarAction>();
  const blank = (m: string) => " ".repeat(m.length);
  let openPhrase = false;
  let rest = folded;
  for (const re of OPEN_PHRASES) {
    rest = rest.replace(re, (m) => {
      openPhrase = true;
      return blank(m);
    });
  }
  if (FILL_WORD.test(rest) && fillsNonCalendarObject(rest)) rest = rest.replace(FILL_WORD, blank);
  FILL_WORD.lastIndex = 0;
  let negatedPresence = false;
  rest = rest.replace(NEGATED_PRESENCE, (m) => {
    negatedPresence = true;
    return blank(m);
  });
  let negatedState = false;
  for (const n of NEGATED) {
    rest = rest.replace(n.re, (m) => {
      negatedState = true;
      found.add(n.action);
      return " ".repeat(m.length);
    });
  }
  const negated = new Set<WaCalendarAction>();
  for (const n of NEGATED_VERBS) {
    rest = rest.replace(n.re, (m) => {
      negated.add(n.action);
      return " ".repeat(m.length);
    });
  }
  let reservedPhrase = false;
  rest = rest.replace(RESERVED_PHRASES, (m) => {
    reservedPhrase = true;
    return blank(m);
  });
  if (openPhrase) found.add("open");
  if (reservedPhrase) found.add("close");
  const openWord = ACTION_WORDS.find((w) => w.action === "open")!.re;
  const withoutReference = rest.replace(CLOSE_REFERENCE, (m) => " ".repeat(m.length));
  if (withoutReference !== rest && openWord.test(withoutReference)) rest = withoutReference;
  for (const w of ACTION_WORDS) if (w.re.test(rest)) found.add(w.action);
  // "giriş … çıkış" tek başına rezervasyon anlamı taşır. Yalnız açık kapatma talimatıyla
  // ("10 Haziran giriş, 15 Haziran çıkış … kapat") birlikteyse tarih sınırını belirtir (v3).
  if (CHECK_IN_OUT.test(rest)) {
    const closeCommand = found.size === 1 && found.has("close") && CLOSE_COMMAND.test(rest);
    if (!closeCommand) found.add("reserve");
  }
  const pending = OPTION.test(rest);
  // Opsiyonlu (kesinleşmemiş) rezervasyon bildirimi: kapatma değil, elle değerlendirme (⚠️).
  if (pending && found.has("close") && !CLOSE_WORDS.test(rest)) {
    found.delete("close");
    found.add("reserve");
  }
  // Yalnız rezervasyon/misafir kalıbıyla gelen kapatma: aynı mesajdaki ad sözcüğü ("rezervasyon
  // alındı, misafir Ahmet Bey") ayrı bir eylem değildir.
  if (reservedPhrase && found.has("close") && found.has("reserve") && !pending) {
    found.delete("reserve");
  }
  // Aynı eylem hem olumlu hem olumsuz ("kiralandı ama kapatmayalım"): çelişkili, işlem yok.
  if ([...negated].some((a) => found.has(a) || (a === "close" && found.has("reserve")))) {
    return { action: null, clear: false, flags: ["action_ambiguous", "action_negated"], pending };
  }
  if (found.size === 0 && negated.size > 0) {
    return { action: null, clear: false, flags: ["action_negated"], pending, negatedOnly: true };
  }
  if (found.size === 0 && PRICE_QUESTION.test(rest)) {
    return { action: null, clear: false, flags: ["question"], pending };
  }
  if (negatedPresence) return { action: null, clear: false, flags: ["action_ambiguous"], pending };

  // İptal; rezervasyon sözcükleri ve "tekrar açalım" ile birlikte tek anlamlıdır (iptal tarihi
  // açar). "Kapat" ile birlikte çelişkilidir.
  // v5: iptal / vazgeçme takvimi AÇAR (yalnız bloklar; gerçek rezervasyon değişmez) ve yalnız
  // açık tarih aralığıyla. "Kapat" veya olumsuz açma ile birlikte çelişkilidir.
  if (found.has("cancel")) {
    if (found.has("close") || negated.has("open")) {
      return { action: null, clear: false, flags: ["action_ambiguous"], pending };
    }
    return { action: "open", clear: true, flags: [], pending: false, strictDates: true };
  }
  if (found.size === 0) return { action: null, clear: false, flags: ["action_missing"], pending };
  if (found.size > 1) return { action: null, clear: false, flags: ["action_ambiguous"], pending };
  const [action] = [...found] as [WaCalendarAction];
  const weak = action === "close" && !negatedState && !STRONG_CLOSE.test(rest);
  return { action, clear: true, flags: [], pending, strictDates: openPhrase, weak };
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
  /^(?:kapa(?:li|t|n)\w*|dolu|blok\w*|satma\w*|satil\w*|verme\w*|rezerv\w*|misafir\w*|opsiyon\w*|kiral(?:an|adi)\w*|kiraya|doldur\w*|tutul\w*|iptal\w*|vazgec\w*|musait\w*|bos|bosal\w*|serbest|uygun|ac(?:alim|in|iniz|ildi|ilsin|ik)?)$/;
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
  "date_order_reversed",
  "date_list",
  "date_unclear",
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

/** Segmentin katlanmış metni, villa adları ve (adlar çıkarılmış metinden) eylemi. */
function analyseSegment(seg: string) {
  const folded = foldTr(seg);
  const spans = findVillaNames(folded, seg);
  // Eylem, villa adları metinden çıkarılarak tanınır (ad ile eylem ayrı ayrıştırılır).
  let actionText = folded;
  for (const v of spans) {
    actionText =
      actionText.slice(0, v.start) + " ".repeat(v.end - v.start) + actionText.slice(v.end);
  }
  return { folded, spans, actionText, act: detectAction(actionText) };
}

/**
 * Noktalama ile ayrılmış "tarih" + "eylem" cümlelerini birleştirir ("20-25 Aralık. Kiralandı.",
 * "20-25 Aralık; kapat"). Yalnız biri YALNIZ tarih (eylemsiz), diğeri YALNIZ eylem (tarihsiz)
 * ise; aksi halde segmentler ayrı kalır (çok öğeli mesajlar değişmez).
 */
function joinDateAndAction(segs: string[], today: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    const a = segs[i]!;
    const b = segs[i + 1];
    if (b !== undefined) {
      const sa = analyseSegment(a);
      const sb = analyseSegment(b);
      const datesOf = (x: ReturnType<typeof analyseSegment>) =>
        findDateMentions(x.folded, { today, operational: true }).length > 0;
      const dateOnly = (x: ReturnType<typeof analyseSegment>) =>
        x.act.action === null &&
        !x.act.negatedOnly &&
        x.act.flags.length === 1 &&
        x.act.flags[0] === "action_missing" &&
        datesOf(x);
      const actionOnly = (x: ReturnType<typeof analyseSegment>) =>
        (x.act.action !== null || x.act.negatedOnly === true) && !datesOf(x);
      if ((dateOnly(sa) && actionOnly(sb)) || (actionOnly(sa) && dateOnly(sb))) {
        out.push(`${a} ${b}`);
        i++;
        continue;
      }
    }
    out.push(a);
  }
  return out;
}

/**
 * Mesajı takvim önerilerine ayrıştırır. `today`: "YYYY-MM-DD" (Europe/Istanbul). Takvimle
 * ilgisiz mesajda `items` boştur. Hiçbir sonuç kendiliğinden uygulanmaz.
 */
export function parseCalendarMessage(text: string, today: string): WaCalendarParseResult {
  if (!isIsoDate(today)) throw new Error("today: YYYY-MM-DD bekleniyor");
  const drafts: Draft[] = [];

  for (const seg of joinDateAndAction(splitSegments(text.slice(0, MAX_INPUT)), today)) {
    const { folded, spans, actionText, act } = analyseSegment(seg);
    const villas = spans.map((v) => v.name);
    // Yalnız olumsuz eylem ("kapatmayalım", "açmayın"): işlem de tepki de yok.
    if (act.negatedOnly) continue;
    // Tarihler YALNIZ merkezi modülden; ay yazılmamış sayılar ve göreli ifadeler yalnız takvim
    // komutu bağlamında tarih sayılır.
    const dates = findDateMentions(folded, {
      today,
      operational: OPERATIONAL_CONTEXT.test(actionText),
    });

    // Tarihi hiç anlaşılamayan takvim komutu (kapat/aç/iptal + sayı, "tarih", "hafta"…) ⚠️ alır.
    const commandWithoutDate =
      dates.length === 0 &&
      act.action !== null &&
      act.action !== "reserve" &&
      !act.weak &&
      DATE_TRACE.test(actionText);
    // Ne tarih ne de (villa + eylem) varsa sohbet mesajıdır.
    if (dates.length === 0 && !(villas.length > 0 && act.action !== null) && !commandWithoutDate) {
      continue;
    }

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
      // İptal kaynaklı açma yalnız açık tarih aralığıyla (göreli tarih / gece sayısı → ⚠️).
      if (act.strictDates && (flags.has("date_relative") || flags.has("nights_count"))) {
        flags.add("date_ambiguous");
      }
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

/**
 * Doğrudan (inceleme nedeni olmadan) uygulanabilecek eylemler: kapatma ve (Aşama 2) açma — açma
 * yalnız takvim BLOKLARINI kaldırır. Rezervasyon ve iptal her zaman elle incelenir.
 */
export const WA_QUICK_APPROVE_ACTIONS: readonly WaCalendarAction[] = ["close", "open"];

/** Tek tıkla onayı engellemeyen (yalnız bilgi veren) bayraklar. */
const INFO_ONLY_FLAGS: ReadonlySet<WaCalendarFlag> = new Set<WaCalendarFlag>([
  "year_inferred",
  "multiple_items",
  // Sürüm 4: tarih tek anlamlı çözüldü; yalnız nasıl çözüldüğünü anlatır.
  "end_inclusive",
  "month_inferred",
  "date_relative",
  "date_corrected",
  "nights_count",
  "day_list",
]);

export const WA_REVIEW_REASONS = [
  /** Eylem yok (belirsiz, soru, tarih değişikliği…). */
  "no_action",
  /** Rezervasyon veya iptal: puan ne olursa olsun elle inceleme (açma Aşama 2 ile doğrudan uygulanır). */
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
