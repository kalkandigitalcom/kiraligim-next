/**
 * iCalendar (RFC 5545) ayrıştırma ve üretme — saf, bağımlılıksız (yalnız tarih yardımcıları).
 *
 * İçe aktarma (parseIcs):
 *  - Satır katlama (CRLF + boşluk/sekme) açılır; VEVENT'lerden UID, DTSTART, DTEND, DURATION,
 *    STATUS, TRANSP ve RECURRENCE-ID okunur. Özet, açıklama, konum, katılımcı OKUNMAZ (veri azaltma:
 *    platformlar misafir adını özette verebilir).
 *  - Tarih kuralı (Europe/Istanbul): VALUE=DATE gün olduğu gibi; UTC (…Z) zaman Istanbul gününe
 *    çevrilir; TZID'li veya yüzer zaman yazıldığı yerel gün olarak alınır. DTEND HARİÇTİR
 *    ([başlangıç, bitiş)); bitiş ≤ başlangıç ise tek gece sayılır. DTEND yoksa DURATION (gün/hafta)
 *    ya da tek gece.
 *  - Atlananlar: STATUS:CANCELLED, TRANSP:TRANSPARENT (meşgul değil), geçmişte biten, 3 yıldan
 *    ileride başlayan, tarihi okunamayan ve Kiraligim'in kendi dışa aktardığı (UID @kiraligim.com)
 *    olaylar — sonuncusu senkron döngüsüne karşı ikinci emniyettir. RRULE açılmaz (yalnız ilk
 *    örnek; konaklama platformları yinelenen olay kullanmaz) ve sayılır.
 *  - UID yoksa tarihlerden kararlı bir anahtar üretilir; aynı UID'nin farklı örnekleri
 *    (RECURRENCE-ID) ayrı tutulur; çok uzun UID kısaltılır.
 *
 * Dışa aktarma (buildIcsFeed): VCALENDAR + tüm gün VEVENT'ler (DTSTART/DTEND;VALUE=DATE, DTEND
 * hariç), UID <kayıt-id>@kiraligim.com, DTSTAMP / CREATED / LAST-MODIFIED (UTC), CRLF ve 75 bayt
 * satır katlama. Özet sabittir; misafir adı, telefon, e-posta, tutar, not YAZILMAZ.
 */
import { ICAL_LIMITS, ICAL_UID_DOMAIN, isOwnExportUid } from "@/lib/ical-meta";
import { addDays, addYears, isIsoDate, TIME_ZONE } from "@/lib/reservation-meta";

/* ── İçe aktarma ─────────────────────────────────────────────────────────── */

export type IcsEvent = { uid: string; start: string; end: string };

export type IcsParseStats = {
  vevents: number;
  cancelled: number;
  transparent: number;
  past: number;
  farFuture: number;
  own: number;
  invalid: number;
  recurring: number;
};

export type IcsParseResult =
  | { ok: true; events: IcsEvent[]; stats: IcsParseStats }
  | { ok: false; error: "not_ical" | "too_many_events" };

/** Ham VEVENT sayısı için üst sınır (işlemci koruması); kabul edilen olay sınırı ayrıdır. */
const RAW_EVENT_LIMIT = 20_000;

type Prop = { name: string; params: Record<string, string>; value: string };

/** Katlanmış satırları açar (RFC 5545 §3.1). */
export function unfoldLines(text: string): string[] {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n");
}

/** "DTSTART;TZID=Europe/Istanbul:20270610T140000" → ad, parametreler, değer. */
export function parseProp(line: string): Prop | null {
  let i = 0;
  let inQuote = false;
  let colon = -1;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ":" && !inQuote) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts: string[] = [];
  let cur = "";
  inQuote = false;
  for (const c of head) {
    if (c === '"') inQuote = !inQuote;
    if (c === ";" && !inQuote) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  const name = (parts.shift() ?? "").trim().toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq <= 0) continue;
    params[p.slice(0, eq).trim().toUpperCase()] = p
      .slice(eq + 1)
      .trim()
      .replace(/^"|"$/g, "");
  }
  return { name, params, value: value.trim() };
}

const ISTANBUL_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * DTSTART/DTEND değeri → Istanbul iş günü ("YYYY-MM-DD") ve saat bilgisi var mı.
 * Geçersizse null.
 */
export function icsDate(prop: Prop): { date: string; timed: boolean } | null {
  const v = prop.value;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss, z] = m;
  const day = `${y}-${mo}-${d}`;
  if (!isIsoDate(day)) return null;
  if (hh === undefined) return { date: day, timed: false };
  if (Number(hh) > 23 || Number(mi) > 59 || Number(ss) > 60) return null;
  if (z) {
    const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi), Number(ss));
    return { date: ISTANBUL_DAY.format(new Date(ms)), timed: true };
  }
  // TZID'li veya yüzer zaman: yazıldığı yerel gün.
  return { date: day, timed: true };
}

/** DURATION'dan gün sayısı (yalnız gün/hafta; saatli süre en az bir gece). */
export function durationDays(value: string): number | null {
  const m = /^\+?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!m || value === "P" || value === "PT") return null;
  const weeks = Number(m[1] ?? 0);
  const days = Number(m[2] ?? 0);
  const hours = Number(m[3] ?? 0) + Number(m[4] ?? 0) / 60 + Number(m[5] ?? 0) / 3600;
  const total = weeks * 7 + days + Math.ceil(hours / 24);
  return total > 0 ? total : 1;
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** UID'yi veritabanı sınırına sığdırır (uzunsa kararlı özet). */
async function fitUid(uid: string): Promise<string> {
  if (uid.length <= ICAL_LIMITS.uidMax) return uid;
  return `h:${await sha256Hex(uid)}`;
}

/**
 * ICS metnini ayrıştırır. `today` Europe/Istanbul günüdür (istanbulToday()).
 * Hata yalnız biçim düzeyindedir: VCALENDAR değilse not_ical, çok fazla olay varsa too_many_events.
 */
export async function parseIcs(text: string, today: string): Promise<IcsParseResult> {
  const lines = unfoldLines(text);
  const firstContent = lines
    .find((l) => l.trim() !== "")
    ?.trim()
    .toUpperCase();
  if (firstContent !== "BEGIN:VCALENDAR") return { ok: false, error: "not_ical" };

  const stats: IcsParseStats = {
    vevents: 0,
    cancelled: 0,
    transparent: 0,
    past: 0,
    farFuture: 0,
    own: 0,
    invalid: 0,
    recurring: 0,
  };
  const horizon = addYears(today, 3);
  const out: IcsEvent[] = [];
  const seen = new Set<string>();

  let props: Prop[] | null = null;
  let depth = 0; // VEVENT içindeki alt bileşenler (VALARM) atlanır
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) continue;
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VEVENT") {
      stats.vevents++;
      if (stats.vevents > RAW_EVENT_LIMIT) return { ok: false, error: "too_many_events" };
      props = [];
      depth = 0;
      continue;
    }
    if (!props) continue;
    if (upper.startsWith("BEGIN:")) {
      depth++;
      continue;
    }
    if (upper === "END:VEVENT" && depth === 0) {
      const ev = await toEvent(props, today, horizon, stats);
      props = null;
      if (!ev) continue;
      let uid = ev.uid;
      // Aynı UID tekrar ederse (bozuk akış) tarihle ayrıştırılır; tamamen aynıysa tek kayıt.
      if (seen.has(uid)) {
        uid = await fitUid(`${ev.uid}#${ev.start}`);
        if (seen.has(uid)) continue;
      }
      seen.add(uid);
      out.push({ ...ev, uid });
      if (out.length > ICAL_LIMITS.maxEvents) return { ok: false, error: "too_many_events" };
      continue;
    }
    if (upper.startsWith("END:")) {
      if (depth > 0) depth--;
      continue;
    }
    if (depth > 0) continue;
    const p = parseProp(line);
    if (p) props.push(p);
  }
  out.sort((a, b) =>
    a.start === b.start ? a.uid.localeCompare(b.uid) : a.start < b.start ? -1 : 1,
  );
  return { ok: true, events: out, stats };
}

async function toEvent(
  props: Prop[],
  today: string,
  horizon: string,
  stats: IcsParseStats,
): Promise<IcsEvent | null> {
  const get = (name: string) => props.find((p) => p.name === name);
  if (get("STATUS")?.value.toUpperCase() === "CANCELLED") {
    stats.cancelled++;
    return null;
  }
  if (get("TRANSP")?.value.toUpperCase() === "TRANSPARENT") {
    stats.transparent++;
    return null;
  }
  const dtStart = get("DTSTART");
  const s = dtStart ? icsDate(dtStart) : null;
  if (!s) {
    stats.invalid++;
    return null;
  }
  let end: string | null = null;
  const dtEnd = get("DTEND");
  if (dtEnd) {
    const e = icsDate(dtEnd);
    if (!e) {
      stats.invalid++;
      return null;
    }
    end = e.date;
  } else {
    const dur = get("DURATION");
    const days = dur ? durationDays(dur.value) : null;
    end = addDays(s.date, days ?? 1);
  }
  const start = s.date;
  if (end <= start) end = addDays(start, 1);
  if (get("RRULE")) stats.recurring++;
  if (end <= today) {
    stats.past++;
    return null;
  }
  if (start >= horizon) {
    stats.farFuture++;
    return null;
  }
  if (end > horizon) end = horizon;

  const rawUid = get("UID")?.value.trim() ?? "";
  if (rawUid && isOwnExportUid(rawUid)) {
    stats.own++;
    return null;
  }
  const rid = get("RECURRENCE-ID");
  const base = rawUid || `nouid:${start}:${end}`;
  const uid = await fitUid(rid ? `${base}#${rid.value}` : base);
  return { uid, start, end };
}

/* ── Dışa aktarma ────────────────────────────────────────────────────────── */

export type ExportEvent = {
  /** Kiraligim kayıt kimliği (rezervasyon veya blok). */
  id: string;
  checkIn: string;
  checkOut: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Tüm olaylarda aynı özet: kayıt türü (rezervasyon/blok) ve misafir bilgisi dışarı çıkmaz. */
export const EXPORT_SUMMARY = "Dolu (Kiralığım)";

/** RFC 5545 TEXT kaçışı. */
export const escapeText = (v: string) =>
  v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** 75 bayt satır katlama (UTF-8 karakter ortasından bölmez). */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (curBytes + b > limit) {
      out.push(cur);
      cur = "";
      curBytes = 0;
      limit = 74; // devam satırları baştaki boşlukla 75 bayt
    }
    cur += ch;
    curBytes += b;
  }
  out.push(cur);
  return out.join("\r\n ");
}

const icsDay = (iso: string) => iso.replace(/-/g, "");

/** Date → 20261108T121314Z */
export const icsUtc = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

export function buildIcsFeed(input: {
  calendarName: string;
  events: readonly ExportEvent[];
  now: Date;
}): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Kiraligim//Takvim 1.0//TR",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(input.calendarName.slice(0, 80))}`,
  ];
  const stamp = icsUtc(input.now);
  for (const e of input.events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.id}@${ICAL_UID_DOMAIN}`,
      `DTSTAMP:${stamp}`,
      `CREATED:${icsUtc(e.createdAt)}`,
      `LAST-MODIFIED:${icsUtc(e.updatedAt)}`,
      `DTSTART;VALUE=DATE:${icsDay(e.checkIn)}`,
      `DTEND;VALUE=DATE:${icsDay(e.checkOut)}`,
      `SUMMARY:${escapeText(EXPORT_SUMMARY)}`,
      "STATUS:CONFIRMED",
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
