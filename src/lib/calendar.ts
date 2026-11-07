/**
 * Rezervasyon takvimi: ay ızgarası ve şerit yerleşimi. Saf ve bağımlılıksız (yalnız
 * reservation-meta); sunucu sayfası ızgarayı üretir, istemci bileşeni yalnız çizer.
 *
 * Model:
 *  - Hafta Pazartesi başlar; ızgara ayın ilk gününü içeren Pazartesi'den son gününü içeren
 *    Pazar'a kadardır (4–6 hafta). Tarihler saat dilimsiz "YYYY-MM-DD" metinleridir.
 *  - Konaklama [giriş, çıkış) gecelerdir. Görselde her gün iki yarımdır (sabah | akşam):
 *    şerit giriş gününün AKŞAM yarısında başlar, çıkış gününün SABAH yarısında biter. Böylece
 *    aynı gün çıkış + giriş (devir) iki yarım şerit olarak yan yana durur.
 *  - Bir mülkte aktif kayıtlar çakışamaz (veritabanı exclusion constraint'i), bu yüzden bir
 *    haftada tek şerit hattı yeterlidir; yerleşim algoritması gerekmez.
 *  - Takvime yalnız güvenli DTO (CalendarEntry) girer: telefon, e-posta, tutar yoktur.
 */
import {
  addDays,
  addYears,
  formatDay,
  isIsoDate,
  nightsBetween,
  RESERVATION_LIMITS,
  type ReservationKind,
  type ReservationStatus,
} from "@/lib/reservation-meta";

/** Görüntülenebilen ay aralığı (bugüne göre). Oluşturma kuralları ayrıdır (checkInWindow). */
export const CALENDAR_VIEW_LIMITS = { pastYears: 10, futureYears: 4 } as const;

/** Takvime giden kayıt: yalnız çizim ve bağlantı için gereken alanlar. */
export type CalendarEntry = {
  id: string;
  kind: ReservationKind;
  status: Exclude<ReservationStatus, "cancelled">;
  checkIn: string;
  checkOut: string;
  nights: number;
  /** Rezervasyonda misafir adı, blokta "Blok" ya da kısaltılmış açıklama. */
  label: string;
};

export type CalendarTone = "confirmed" | "pending" | "block";

export const LABEL_MAX = 60;

const shorten = (s: string) => {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > LABEL_MAX ? `${t.slice(0, LABEL_MAX - 1)}…` : t;
};

/** Servis kaydından (Reservation) takvim DTO'su; iptaller takvime girmez (null). */
export function toCalendarEntry(r: {
  id: string;
  kind: ReservationKind;
  status: ReservationStatus;
  checkIn: string;
  checkOut: string;
  nights: number;
  guestName: string | null;
  note: string | null;
}): CalendarEntry | null {
  if (r.status === "cancelled") return null;
  const label =
    r.kind === "block"
      ? r.note?.trim()
        ? `Blok · ${shorten(r.note)}`
        : "Blok"
      : shorten(r.guestName ?? "") || "Rezervasyon";
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    checkIn: r.checkIn,
    checkOut: r.checkOut,
    nights: r.nights,
    label,
  };
}

export const entryTone = (e: Pick<CalendarEntry, "kind" | "status">): CalendarTone =>
  e.kind === "block" ? "block" : e.status;

/* ── Ay anahtarı ("YYYY-MM") ─────────────────────────────────────────────── */

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;

export const isMonthKey = (v: string) => MONTH_KEY.test(v);

export const monthOf = (iso: string) => iso.slice(0, 7);

export function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + delta;
  const ny = Math.floor(idx / 12);
  const nm = idx - ny * 12 + 1;
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}`;
}

/** Görüntülenebilir ilk ve son ay. */
export function viewWindow(today: string) {
  return {
    min: monthOf(addYears(today, -CALENDAR_VIEW_LIMITS.pastYears)),
    max: monthOf(addYears(today, CALENDAR_VIEW_LIMITS.futureYears)),
  };
}

/** URL'deki ?ay değeri → geçerli ay; geçersizse bugünün ayı, pencere dışıysa sınıra kırpılır. */
export function resolveMonth(input: string | undefined, today: string): string {
  const current = monthOf(today);
  if (!input || !isMonthKey(input)) return current;
  const w = viewWindow(today);
  if (input < w.min) return w.min;
  if (input > w.max) return w.max;
  return input;
}

/** Önceki / sonraki ay bağlantıları (pencere dışında null) ve bugünün ayı. */
export function monthNav(key: string, today: string) {
  const w = viewWindow(today);
  const prev = shiftMonth(key, -1);
  const next = shiftMonth(key, 1);
  return {
    prev: prev >= w.min ? prev : null,
    next: next <= w.max ? next : null,
    current: monthOf(today),
  };
}

export const monthStart = (key: string) => `${key}-01`;
/** Ayın bitişi (hariç): sonraki ayın 1'i. */
export const monthEnd = (key: string) => `${shiftMonth(key, 1)}-01`;

const MONTH_FMT = new Intl.DateTimeFormat("tr-TR", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const WEEKDAY_FMT = new Intl.DateTimeFormat("tr-TR", { weekday: "long", timeZone: "UTC" });

const utc = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
};

/** "2026-11" → "Kasım 2026". */
export const formatMonth = (key: string) => MONTH_FMT.format(utc(monthStart(key)));

/** Pazartesi = 0 … Pazar = 6. */
export const weekdayIndex = (iso: string) => (utc(iso).getUTCDay() + 6) % 7;

export const WEEKDAYS = [
  { short: "Pzt", long: "Pazartesi" },
  { short: "Sal", long: "Salı" },
  { short: "Çar", long: "Çarşamba" },
  { short: "Per", long: "Perşembe" },
  { short: "Cum", long: "Cuma" },
  { short: "Cmt", long: "Cumartesi" },
  { short: "Paz", long: "Pazar" },
] as const;

/* ── Izgara ──────────────────────────────────────────────────────────────── */

export type CalendarDay = {
  date: string;
  /** Ayın günü (1–31). */
  day: number;
  inMonth: boolean;
  isToday: boolean;
  /** Pazartesi = 0 … Pazar = 6. */
  weekday: number;
};

/**
 * Bir haftadaki şerit parçası. Yarım-gün birimi: Pazartesi sabahı 0, Pazartesi akşamı 1 …
 * Pazar akşamı 13. [startHalf, endHalf) aralığıdır (endHalf en fazla 14).
 */
export type CalendarSegment = {
  entryId: string;
  startHalf: number;
  endHalf: number;
  /** Giriş bu haftada mı (değilse şerit önceki haftadan devam ediyor). */
  startsHere: boolean;
  /** Çıkış bu haftada mı (değilse sonraki haftaya devam ediyor). */
  endsHere: boolean;
};

export type CalendarWeek = { start: string; days: CalendarDay[]; segments: CalendarSegment[] };

export type MonthGrid = {
  month: string;
  /** Izgaranın ilk günü (Pazartesi). */
  from: string;
  /** Izgaranın bitişi (hariç; son Pazar'dan sonraki Pazartesi). Veri sorgusu [from, to). */
  to: string;
  weeks: { start: string; days: CalendarDay[] }[];
};

export function monthGrid(key: string, today: string): MonthGrid {
  const first = monthStart(key);
  const end = monthEnd(key);
  const from = addDays(first, -weekdayIndex(first));
  const lastDay = addDays(end, -1);
  const to = addDays(lastDay, 7 - weekdayIndex(lastDay));
  const weeks: MonthGrid["weeks"] = [];
  for (let ws = from; ws < to; ws = addDays(ws, 7)) {
    const days: CalendarDay[] = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(ws, i);
      days.push({
        date,
        day: Number(date.slice(8, 10)),
        inMonth: date >= first && date < end,
        isToday: date === today,
        weekday: i,
      });
    }
    weeks.push({ start: ws, days });
  }
  return { month: key, from, to, weeks };
}

/** Haftanın şerit parçaları (Pazartesi = weekStart), başlangıca göre sıralı. */
export function layoutWeek(
  weekStart: string,
  entries: readonly Pick<CalendarEntry, "id" | "checkIn" | "checkOut">[],
): CalendarSegment[] {
  const out: CalendarSegment[] = [];
  for (const e of entries) {
    const startHalf = 2 * nightsBetween(weekStart, e.checkIn) + 1;
    const endHalf = 2 * nightsBetween(weekStart, e.checkOut) + 1;
    const s = Math.max(0, startHalf);
    const t = Math.min(14, endHalf);
    if (t <= s) continue;
    out.push({
      entryId: e.id,
      startHalf: s,
      endHalf: t,
      startsHere: startHalf >= 0,
      endsHere: endHalf <= 14,
    });
  }
  return out.sort((a, b) => a.startHalf - b.startHalf);
}

export function layoutMonth(
  grid: MonthGrid,
  entries: readonly Pick<CalendarEntry, "id" | "checkIn" | "checkOut">[],
): CalendarWeek[] {
  return grid.weeks.map((w) => ({ ...w, segments: layoutWeek(w.start, entries) }));
}

/* ── Gün ayrıntısı ───────────────────────────────────────────────────────── */

export type DayActivity<E> = { checkOuts: E[]; checkIns: E[]; stays: E[] };

/** Bir güne dokunan kayıtlar: o gün çıkan, giren ve gece boyunca konaklayan. */
export function dayActivity<E extends Pick<CalendarEntry, "checkIn" | "checkOut">>(
  date: string,
  entries: readonly E[],
): DayActivity<E> {
  const res: DayActivity<E> = { checkOuts: [], checkIns: [], stays: [] };
  for (const e of entries) {
    if (e.checkOut === date) res.checkOuts.push(e);
    else if (e.checkIn === date) res.checkIns.push(e);
    else if (e.checkIn < date && date < e.checkOut) res.stays.push(e);
  }
  return res;
}

/** Ayla kesişen kayıtlar, girişe göre sıralı ("Bu ay" listesi). */
export function entriesInMonth<E extends Pick<CalendarEntry, "id" | "checkIn" | "checkOut">>(
  key: string,
  entries: readonly E[],
): E[] {
  const a = monthStart(key);
  const b = monthEnd(key);
  return entries
    .filter((e) => e.checkIn < b && e.checkOut > a)
    .sort((x, y) =>
      x.checkIn === y.checkIn ? x.id.localeCompare(y.id) : x.checkIn < y.checkIn ? -1 : 1,
    );
}

const TONE_WORDS: Record<CalendarTone, string> = {
  confirmed: "onaylı rezervasyon",
  pending: "beklemede rezervasyon",
  block: "blok",
};

/** "12 Temmuz 2026 Pazar". */
export const formatLongDay = (iso: string) => `${formatDay(iso)} ${WEEKDAY_FMT.format(utc(iso))}`;

/** Gün hücresinin erişilebilir adı: tarih, bugün ve o günün giriş/çıkış/konaklama özeti. */
export function dayLabel(day: CalendarDay, entries: readonly CalendarEntry[]): string {
  const act = dayActivity(day.date, entries);
  const part = (word: string, list: CalendarEntry[]) =>
    list.map((e) => `${word}: ${e.label} (${TONE_WORDS[entryTone(e)]})`);
  const parts = [
    ...part("çıkış", act.checkOuts),
    ...part("giriş", act.checkIns),
    ...part("dolu", act.stays),
  ];
  const head = `${formatLongDay(day.date)}${day.isToday ? ", bugün" : ""}`;
  return parts.length ? `${head}; ${parts.join("; ")}` : `${head}; boş`;
}

/* ── Tarih aralığı seçimi (3.0c-3) ───────────────────────────────────────── */

/**
 * Takvimden yeni kayıt için aralık seçimi. Birinci tıklama giriş, ikinci tıklama çıkış günüdür.
 * Buradaki denetimler yalnız kullanıcıya erken geri bildirim içindir; kayıt mevcut formdan geçer
 * ve form doğrulaması, servis (rol, aktif mülk, çakışma) ve veritabanı (exclusion constraint,
 * tarih penceresi tetikleyicisi) kuralları aynen geçerlidir.
 */
export type RangeSelection = { start: string | null; end: string | null };

export type SelectionRules = {
  /** Giriş tarihi penceresi (checkInWindow): [min, max]. */
  min: string;
  max: string;
  /** Aktif kayıtlar (seçim aralığını kapsayacak şekilde yüklenmiş). */
  entries: readonly Pick<CalendarEntry, "id" | "checkIn" | "checkOut">[];
};

export type SelectionError = "window" | "occupied" | "same-day" | "conflict" | "too-long";

export const SELECTION_ERRORS: Record<SelectionError, string> = {
  window: "Giriş tarihi en fazla 1 yıl geçmişte ve 3 yıl ileride olabilir.",
  occupied: "Bu gece dolu; giriş için boş bir gün seçin.",
  "same-day": "Çıkış tarihi giriş tarihinden sonra olmalı.",
  conflict: "Seçilen aralıkta dolu gece var; daha erken bir çıkış günü seçin.",
  "too-long": `Konaklama en fazla ${RESERVATION_LIMITS.maxNights} gece olabilir.`,
};

export const EMPTY_SELECTION: RangeSelection = { start: null, end: null };

/** [start, end) aralığıyla kesişen kayıtlar (çıkış günü = başka girişin günü serbesttir). */
export function rangeConflicts<E extends Pick<CalendarEntry, "checkIn" | "checkOut">>(
  start: string,
  end: string,
  entries: readonly E[],
): E[] {
  return entries.filter((e) => e.checkIn < end && e.checkOut > start);
}

/** O günün gecesi boş mu (giriş günü olarak seçilebilir mi)? */
export const nightIsFree = (
  date: string,
  entries: readonly Pick<CalendarEntry, "checkIn" | "checkOut">[],
) => rangeConflicts(date, addDays(date, 1), entries).length === 0;

function startAt(
  date: string,
  rules: SelectionRules,
): { selection: RangeSelection; error?: SelectionError } {
  if (date < rules.min || date > rules.max) return { selection: EMPTY_SELECTION, error: "window" };
  if (!nightIsFree(date, rules.entries)) return { selection: EMPTY_SELECTION, error: "occupied" };
  return { selection: { start: date, end: null } };
}

/**
 * Tıklanan güne göre yeni seçim. Seçim yoksa ya da tamamlanmışsa tıklama yeni giriş günüdür;
 * giriş seçiliyken daha önceki bir gün girişi değiştirir, aynı gün reddedilir, sonraki bir gün
 * (aralık boşsa ve en fazla 365 geceyse) çıkış olur. Hatalı tıklamada mevcut giriş korunur.
 */
export function selectDay(
  current: RangeSelection,
  date: string,
  rules: SelectionRules,
): { selection: RangeSelection; error?: SelectionError } {
  const { start, end } = current;
  if (!start || end || date < start) {
    const next = startAt(date, rules);
    // Erken bir güne tıklanıp geçersizse bekleyen giriş kaybolmasın.
    return next.error && start && !end ? { selection: current, error: next.error } : next;
  }
  if (date === start) return { selection: current, error: "same-day" };
  if (nightsBetween(start, date) > RESERVATION_LIMITS.maxNights) {
    return { selection: current, error: "too-long" };
  }
  if (rangeConflicts(start, date, rules.entries).length) {
    return { selection: current, error: "conflict" };
  }
  return { selection: { start, end: date } };
}

/** Gün seçim durumundaki rolü: giriş, çıkış, aralık içi ya da yok. */
export function selectionRole(date: string, s: RangeSelection): "start" | "end" | "inside" | null {
  if (!s.start) return null;
  if (date === s.start) return "start";
  if (s.end && date === s.end) return "end";
  if (s.end && date > s.start && date < s.end) return "inside";
  return null;
}

/** Seçilen aralıkla mevcut forma bağlantı (yalnız mülk kimliği ve tarihler; kişisel veri yok). */
export function createHref(
  kind: "reservation" | "block",
  propertyId: string,
  start: string,
  end: string,
): string {
  const p = new URLSearchParams();
  if (kind === "block") p.set("tur", "blok");
  p.set("mulk", propertyId);
  p.set("giris", start);
  p.set("cikis", end);
  return `/rezervasyonlar/yeni?${p.toString()}`;
}

/**
 * Ay değiştirirken bekleyen giriş günü (?baslangic). Geçerli bir tarih olmalı, giriş penceresinde
 * kalmalı ve görüntülenen ızgaranın sonundan en fazla 365 gece önce olmalı; aksi halde yok sayılır.
 */
export function resolvePendingStart(
  input: string | undefined,
  window: { min: string; max: string },
  gridTo: string,
): string | null {
  if (!input || !isIsoDate(input)) return null;
  if (input < window.min || input > window.max) return null;
  if (nightsBetween(input, gridTo) > RESERVATION_LIMITS.maxNights + 1) return null;
  return input;
}
