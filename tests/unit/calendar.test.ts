import { describe, expect, it } from "vitest";

import {
  type CalendarEntry,
  dayActivity,
  dayLabel,
  entriesInMonth,
  entryTone,
  formatLongDay,
  formatMonth,
  isMonthKey,
  layoutMonth,
  layoutWeek,
  monthEnd,
  monthGrid,
  monthNav,
  resolveMonth,
  shiftMonth,
  toCalendarEntry,
  viewWindow,
  weekdayIndex,
} from "@/lib/calendar";

const TODAY = "2026-11-07";

const entry = (
  id: string,
  checkIn: string,
  checkOut: string,
  over: Partial<CalendarEntry> = {},
): CalendarEntry => ({
  id,
  kind: "reservation",
  status: "confirmed",
  checkIn,
  checkOut,
  nights: 0,
  label: id,
  ...over,
});

describe("ay anahtarı", () => {
  it("biçim denetimi", () => {
    expect(isMonthKey("2026-11")).toBe(true);
    for (const bad of ["2026-13", "2026-00", "2026-1", "26-11", "2026-11-01", "", "abcd-ef"]) {
      expect(isMonthKey(bad), bad).toBe(false);
    }
  });

  it("ay kaydırma: yıl geçişi ve çok aylık", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2027-01", -1)).toBe("2026-12");
    expect(shiftMonth("2026-11", -23)).toBe("2024-12");
    expect(shiftMonth("2026-11", 14)).toBe("2028-01");
    expect(monthEnd("2026-12")).toBe("2027-01-01");
  });

  it("?ay çözümleme: geçersiz → bugünün ayı; pencere dışı → sınır", () => {
    expect(viewWindow(TODAY)).toEqual({ min: "2016-11", max: "2030-11" });
    expect(resolveMonth(undefined, TODAY)).toBe("2026-11");
    expect(resolveMonth("2026-13", TODAY)).toBe("2026-11");
    expect(resolveMonth("<script>", TODAY)).toBe("2026-11");
    expect(resolveMonth("2025-03", TODAY)).toBe("2025-03");
    expect(resolveMonth("1999-01", TODAY)).toBe("2016-11");
    expect(resolveMonth("2099-01", TODAY)).toBe("2030-11");
  });

  it("gezinme: pencere sınırında bağlantı yok; geçmiş aylar açık", () => {
    expect(monthNav("2026-11", TODAY)).toEqual({
      prev: "2026-10",
      next: "2026-12",
      current: "2026-11",
    });
    expect(monthNav("2016-11", TODAY).prev).toBeNull();
    expect(monthNav("2030-11", TODAY).next).toBeNull();
    expect(monthNav("2020-05", TODAY).prev).toBe("2020-04");
  });

  it("Türkçe ay adı ve gün adı", () => {
    expect(formatMonth("2026-11")).toBe("Kasım 2026");
    expect(formatMonth("2027-02")).toBe("Şubat 2027");
    expect(formatLongDay("2026-07-12")).toBe("12 Temmuz 2026 Pazar");
    expect(weekdayIndex("2026-11-02")).toBe(0);
    expect(weekdayIndex("2026-11-01")).toBe(6);
  });
});

describe("ay ızgarası", () => {
  it("1'i Pazar olan ay: 6 hafta, önceki/sonraki aydan taşan günler", () => {
    const g = monthGrid("2026-11", TODAY);
    expect([g.from, g.to, g.weeks.length]).toEqual(["2026-10-26", "2026-12-07", 6]);
    const first = g.weeks[0]!.days;
    expect(first.map((d) => d.inMonth)).toEqual([false, false, false, false, false, false, true]);
    expect(first[6]).toMatchObject({ date: "2026-11-01", day: 1, weekday: 6 });
    const last = g.weeks[5]!.days;
    expect(last[0]).toMatchObject({ date: "2026-11-30", inMonth: true });
    expect(last[1]).toMatchObject({ date: "2026-12-01", inMonth: false });
    expect(
      g.weeks
        .flatMap((w) => w.days)
        .filter((d) => d.isToday)
        .map((d) => d.date),
    ).toEqual([TODAY]);
  });

  it("1'i Pazartesi olan ay: taşma yok başta; 5 hafta", () => {
    const g = monthGrid("2026-06", TODAY);
    expect([g.from, g.to, g.weeks.length]).toEqual(["2026-06-01", "2026-07-06", 5]);
  });

  it("Şubat: 28 gün ve Pazartesi başlangıç → 4 hafta; artık yıl", () => {
    const g = monthGrid("2027-02", TODAY);
    expect([g.from, g.to, g.weeks.length]).toEqual(["2027-02-01", "2027-03-01", 4]);
    const leap = monthGrid("2028-02", TODAY);
    const inMonth = leap.weeks.flatMap((w) => w.days).filter((d) => d.inMonth);
    expect(inMonth.length).toBe(29);
    expect(inMonth.at(-1)!.date).toBe("2028-02-29");
  });

  it("Aralık → Ocak yıl geçişi ve her hafta 7 gün, Pazartesi başlar", () => {
    const g = monthGrid("2026-12", TODAY);
    expect([g.from, g.to]).toEqual(["2026-11-30", "2027-01-04"]);
    for (const w of g.weeks) {
      expect(w.days).toHaveLength(7);
      expect(weekdayIndex(w.start)).toBe(0);
    }
    expect(g.weeks.flatMap((w) => w.days).some((d) => d.isToday)).toBe(false);
  });
});

describe("şerit yerleşimi (yarım gün)", () => {
  const WEEK = "2026-11-02"; // Pazartesi

  it("hafta içinde kalan konaklama: giriş akşamı → çıkış sabahı", () => {
    // Salı giriş, Cuma çıkış: yarımlar 3 (Salı akşamı) … 8 (Cuma sabahı) dahil.
    expect(layoutWeek(WEEK, [entry("a", "2026-11-03", "2026-11-06")])).toEqual([
      { entryId: "a", startHalf: 3, endHalf: 9, startsHere: true, endsHere: true },
    ]);
  });

  it("bir gecelik konaklama iki yarım (bir gün genişliği)", () => {
    const [s] = layoutWeek(WEEK, [entry("a", "2026-11-04", "2026-11-05")]);
    expect([s!.startHalf, s!.endHalf]).toEqual([5, 7]);
  });

  it("aynı gün çıkış ve giriş: iki parça bitişik, çakışmaz", () => {
    const segs = layoutWeek(WEEK, [
      entry("b", "2026-11-05", "2026-11-07"),
      entry("a", "2026-11-03", "2026-11-05"),
    ]);
    expect(segs.map((s) => [s.entryId, s.startHalf, s.endHalf])).toEqual([
      ["a", 3, 7],
      ["b", 7, 11],
    ]);
  });

  it("önceki haftadan gelen ve sonraki haftaya taşan konaklama", () => {
    expect(layoutWeek(WEEK, [entry("a", "2026-10-30", "2026-11-12")])).toEqual([
      { entryId: "a", startHalf: 0, endHalf: 14, startsHere: false, endsHere: false },
    ]);
    // Pazar girişi: yalnız Pazar akşamı, sonraki haftaya devam.
    expect(layoutWeek(WEEK, [entry("b", "2026-11-08", "2026-11-10")])).toEqual([
      { entryId: "b", startHalf: 13, endHalf: 14, startsHere: true, endsHere: false },
    ]);
    // Pazartesi çıkışı: yalnız Pazartesi sabahı, önceki haftadan gelir.
    expect(layoutWeek(WEEK, [entry("c", "2026-10-31", "2026-11-02")])).toEqual([
      { entryId: "c", startHalf: 0, endHalf: 1, startsHere: false, endsHere: true },
    ]);
  });

  it("haftaya dokunmayan kayıtlar atlanır (Pazartesi girişi önceki haftada görünmez)", () => {
    expect(layoutWeek(WEEK, [entry("a", "2026-11-09", "2026-11-11")])).toEqual([]);
    expect(layoutWeek(WEEK, [entry("b", "2026-10-25", "2026-11-01")])).toEqual([]);
  });

  it("ay boyunca: hafta sınırında parçalanma, 60 gecelik kayıt her haftada", () => {
    const g = monthGrid("2026-11", TODAY);
    const weeks = layoutMonth(g, [
      entry("long", "2026-10-15", "2026-12-14"),
      entry("x", "2026-11-07", "2026-11-10"),
    ]);
    expect(weeks.map((w) => w.segments.filter((s) => s.entryId === "long").length)).toEqual([
      1, 1, 1, 1, 1, 1,
    ]);
    const x = weeks.flatMap((w) => w.segments.filter((s) => s.entryId === "x"));
    expect(x).toEqual([
      { entryId: "x", startHalf: 11, endHalf: 14, startsHere: true, endsHere: false },
      { entryId: "x", startHalf: 0, endHalf: 3, startsHere: false, endsHere: true },
    ]);
  });
});

describe("gün ayrıntısı ve liste", () => {
  const list = [
    entry("a", "2026-11-03", "2026-11-05", { label: "Ayşe" }),
    entry("b", "2026-11-05", "2026-11-08", { label: "Mehmet", status: "pending" }),
    entry("c", "2026-10-28", "2026-11-02", { kind: "block", label: "Blok · Bakım" }),
    entry("d", "2026-11-28", "2026-12-03", { label: "Can" }),
  ];

  it("giriş, çıkış ve konaklama ayrımı", () => {
    const a = dayActivity("2026-11-05", list);
    expect(a.checkOuts.map((e) => e.id)).toEqual(["a"]);
    expect(a.checkIns.map((e) => e.id)).toEqual(["b"]);
    expect(a.stays).toEqual([]);
    expect(dayActivity("2026-11-06", list).stays.map((e) => e.id)).toEqual(["b"]);
    expect(dayActivity("2026-11-15", list)).toEqual({ checkOuts: [], checkIns: [], stays: [] });
  });

  it("bu ay listesi: ayla kesişenler, girişe göre; ızgaranın taşan günleri dahil değil", () => {
    expect(entriesInMonth("2026-11", list).map((e) => e.id)).toEqual(["c", "a", "b", "d"]);
    // 1 Kasım çıkışlı kayıt Kasım'ın gecelerini kapsamaz.
    expect(entriesInMonth("2026-11", [entry("z", "2026-10-28", "2026-11-01")])).toEqual([]);
  });

  it("erişilebilir gün adı", () => {
    const g = monthGrid("2026-11", TODAY);
    const day = (date: string) => g.weeks.flatMap((w) => w.days).find((d) => d.date === date)!;
    expect(dayLabel(day("2026-11-05"), list)).toBe(
      "5 Kasım 2026 Perşembe; çıkış: Ayşe (onaylı rezervasyon); giriş: Mehmet (beklemede rezervasyon)",
    );
    expect(dayLabel(day("2026-11-01"), list)).toBe("1 Kasım 2026 Pazar; dolu: Blok · Bakım (blok)");
    expect(dayLabel(day(TODAY), list)).toBe(
      "7 Kasım 2026 Cumartesi, bugün; dolu: Mehmet (beklemede rezervasyon)",
    );
    expect(dayLabel(day("2026-11-20"), list)).toBe("20 Kasım 2026 Cuma; boş");
  });

  it("renk tonu: blok her durumda blok", () => {
    expect(entryTone({ kind: "reservation", status: "confirmed" })).toBe("confirmed");
    expect(entryTone({ kind: "reservation", status: "pending" })).toBe("pending");
    expect(entryTone({ kind: "block", status: "confirmed" })).toBe("block");
  });
});

describe("takvim DTO'su", () => {
  const base = {
    id: "r1",
    kind: "reservation" as const,
    status: "confirmed" as const,
    checkIn: "2026-11-03",
    checkOut: "2026-11-05",
    nights: 2,
    guestName: "  Ayşe   Yılmaz ",
    note: "kapı kodu 1234",
    // Servis kaydındaki diğer alanlar DTO'ya geçmemeli.
    guestPhone: "+90 532 123 45 67",
    guestEmail: "ayse@ornek.com",
    totalAmountMinor: 1250000,
    depositAmountMinor: 250000,
    currency: "TRY",
  };

  it("yalnız güvenli alanlar; rezervasyon notu gönderilmez", () => {
    const dto = toCalendarEntry(base);
    expect(dto).toEqual({
      id: "r1",
      kind: "reservation",
      status: "confirmed",
      checkIn: "2026-11-03",
      checkOut: "2026-11-05",
      nights: 2,
      label: "Ayşe Yılmaz",
    });
    expect(JSON.stringify(dto)).not.toMatch(/532|ornek|1250000|1234/);
  });

  it("blok etiketi açıklamayla, uzun metin kısaltılır; iptal takvime girmez", () => {
    expect(toCalendarEntry({ ...base, kind: "block", guestName: null, note: "Bakım" })!.label).toBe(
      "Blok · Bakım",
    );
    expect(toCalendarEntry({ ...base, kind: "block", guestName: null, note: null })!.label).toBe(
      "Blok",
    );
    const long = toCalendarEntry({ ...base, guestName: "A".repeat(200) })!.label;
    expect(long).toHaveLength(60);
    expect(long.endsWith("…")).toBe(true);
    expect(toCalendarEntry({ ...base, status: "cancelled" })).toBeNull();
  });
});
