import { describe, expect, it } from "vitest";

import { validateAuditEntry } from "@/server/audit/record";
import {
  adjacentSamePrice,
  endFromLastNight,
  formatNights,
  formatPeriod,
  lastNightOf,
  nightsWithPeriods,
  overlappingPeriods,
  periodForNight,
  periodGaps,
  periodNights,
  type RatePeriod,
  sortPeriods,
  weeklyAboveNightly,
} from "@/lib/rate-meta";
import { rateFormValues, rateInput } from "@/server/rates/schema";
import { rateConflictMessage } from "@/server/rates/service";

const rules = { today: "2026-11-07", checkWindow: true };
// Arayüz girişi: başlangıç ve bitiş DAHİL (Haziran'ın 30 gecesi).
const base = { startDate: "2027-06-01", lastNight: "2027-06-30", currency: "EUR" };
const parse = (input: Record<string, unknown>, r = rules) =>
  rateInput(r).safeParse({ ...base, ...input });
const errorsOf = (input: Record<string, unknown>, r = rules) => {
  const p = parse(input, r);
  return p.success
    ? {}
    : Object.fromEntries(p.error.issues.map((i) => [i.path.join("."), i.message]));
};

describe("fiyat dönemi formu", () => {
  it("yalnız gecelik, yalnız haftalık, ikisi birlikte", () => {
    // Çıktı veritabanı biçiminde: endDate = son gece + 1 (hariç).
    expect(rateInput(rules).parse({ ...base, nightlyAmount: "5.000" })).toEqual({
      startDate: "2027-06-01",
      endDate: "2027-07-01",
      nightlyAmountMinor: 500000,
      weeklyAmountMinor: null,
      currency: "EUR",
      minNights: null,
    });
    expect(rateInput(rules).parse({ ...base, weeklyAmount: "35.000" })).toMatchObject({
      nightlyAmountMinor: null,
      weeklyAmountMinor: 3500000,
    });
    expect(
      rateInput(rules).parse({
        ...base,
        nightlyAmount: "5.000",
        weeklyAmount: "35.000",
        minNights: " 3 ",
      }),
    ).toMatchObject({ nightlyAmountMinor: 500000, weeklyAmountMinor: 3500000, minNights: 3 });
  });

  it("iki fiyat da boşsa reddedilir", () => {
    expect(errorsOf({ nightlyAmount: "", weeklyAmount: "  " })).toEqual({
      nightlyAmount: "Gecelik veya haftalık fiyattan en az birini girin.",
    });
  });

  it("küsurat hassasiyeti: kuruş/sent tam sayı", () => {
    const minor = (s: string) => parse({ nightlyAmount: s }).data?.nightlyAmountMinor;
    expect(minor("12.500,50")).toBe(1250050);
    expect(minor("12500.5")).toBe(1250050);
    expect(minor("0,29")).toBe(29);
    expect(minor("0,01")).toBe(1);
    expect(minor("9.999.999.999,99")).toBe(999_999_999_999);
    expect(minor("1.234.567,89")).toBe(123456789);
  });

  it("geçersiz tutarlar: sıfır, negatif, biçim, üst sınır", () => {
    expect(errorsOf({ nightlyAmount: "0" })).toEqual({
      nightlyAmount: "Gecelik fiyat sıfırdan büyük olmalı.",
    });
    expect(errorsOf({ nightlyAmount: "-5" })).toHaveProperty("nightlyAmount");
    expect(errorsOf({ nightlyAmount: "12,345" })).toHaveProperty("nightlyAmount");
    expect(errorsOf({ weeklyAmount: "abc" })).toHaveProperty("weeklyAmount");
    expect(errorsOf({ weeklyAmount: "1,001" })).toHaveProperty("weeklyAmount");
    expect(errorsOf({ nightlyAmount: "10.000.000.000" })).toEqual({
      nightlyAmount: "Gecelik fiyat çok büyük.",
    });
  });

  it("para birimi zorunlu ve yalnız TRY/EUR/USD/GBP", () => {
    expect(errorsOf({ nightlyAmount: "100", currency: "" })).toEqual({
      currency: "Para birimini seçin.",
    });
    expect(errorsOf({ nightlyAmount: "100", currency: "JPY" })).toHaveProperty("currency");
    for (const c of ["TRY", "EUR", "USD", "GBP"]) {
      expect(parse({ nightlyAmount: "100", currency: c }).success, c).toBe(true);
    }
  });

  it("minimum konaklama: isteğe bağlı, 1–365 tam sayı", () => {
    expect(parse({ nightlyAmount: "100", minNights: "" }).data?.minNights).toBeNull();
    expect(parse({ nightlyAmount: "100", minNights: "365" }).data?.minNights).toBe(365);
    expect(errorsOf({ nightlyAmount: "100", minNights: "0" })).toEqual({
      minNights: "Minimum konaklama en az 1 gece olmalı.",
    });
    expect(errorsOf({ nightlyAmount: "100", minNights: "366" })).toHaveProperty("minNights");
    expect(errorsOf({ nightlyAmount: "100", minNights: "2.5" })).toHaveProperty("minNights");
    expect(errorsOf({ nightlyAmount: "100", minNights: "x" })).toHaveProperty("minNights");
  });

  it("tarihler: bitiş dahil (son gece), en fazla 366 gece, geçerli takvim günü", () => {
    // Aynı gün başlangıç ve bitiş: tek gece; veritabanı aralığı [1 Haz, 2 Haz).
    expect(parse({ nightlyAmount: "1", lastNight: "2027-06-01" }).data).toMatchObject({
      startDate: "2027-06-01",
      endDate: "2027-06-02",
    });
    expect(errorsOf({ nightlyAmount: "1", lastNight: "2027-05-31" })).toEqual({
      lastNight: "Bitiş tarihi başlangıç tarihinden önce olamaz.",
    });
    expect(
      errorsOf({ nightlyAmount: "1", startDate: "2027-01-01", lastNight: "2028-01-01" }),
    ).toEqual({}); // 366 gece
    expect(
      errorsOf({ nightlyAmount: "1", startDate: "2027-01-01", lastNight: "2028-01-02" }),
    ).toEqual({ lastNight: "Bir fiyat dönemi en fazla 366 gün olabilir." });
    expect(errorsOf({ nightlyAmount: "1", startDate: "2027-02-30" })).toEqual({
      startDate: "Başlangıç tarihi geçerli bir tarih olmalı.",
    });
  });

  it("dahil bitiş → hariç sınır: 1–30 Nisan = 30 gece, 1–31 Mayıs = 31 gece, bitişik", () => {
    const apr = rateInput(rules).parse({
      startDate: "2027-04-01",
      lastNight: "2027-04-30",
      nightlyAmount: "5.000",
      currency: "TRY",
    });
    const may = rateInput(rules).parse({
      startDate: "2027-05-01",
      lastNight: "2027-05-31",
      nightlyAmount: "6.000",
      currency: "TRY",
    });
    expect([apr.startDate, apr.endDate, may.startDate, may.endDate]).toEqual([
      "2027-04-01",
      "2027-05-01",
      "2027-05-01",
      "2027-06-01",
    ]);
    expect(periodNights(apr)).toBe(30);
    expect(periodNights(may)).toBe(31);
    const both = [
      { id: "apr", ...apr },
      { id: "may", ...may },
    ];
    expect(periodGaps(both)).toEqual([]); // 30 Nisan – 1 Mayıs arasında fiyatsız gece yok
    expect(overlappingPeriods(apr.startDate, apr.endDate, [{ id: "may", ...may }])).toEqual([]);
    expect(periodForNight("2027-04-30", both)?.id).toBe("apr");
    expect(periodForNight("2027-05-01", both)?.id).toBe("may");
    expect(formatPeriod(apr)).toBe("1–30 Nisan 2027");
    expect(formatPeriod(may)).toBe("1–31 Mayıs 2027");
    expect(lastNightOf(apr)).toBe("2027-04-30");
    expect(endFromLastNight("2027-04-30")).toBe("2027-05-01");
  });

  it("dahil gösterim: tek gece, ay ve yıl geçişi", () => {
    expect(formatNights("2027-04-30", "2027-05-01")).toBe("30 Nisan 2027");
    expect(formatNights("2027-06-28", "2027-07-03")).toBe("28 Haziran – 2 Temmuz 2027");
    expect(formatNights("2027-12-30", "2028-01-02")).toBe("30 Aralık 2027 – 1 Ocak 2028");
  });

  it("başlangıç penceresi: 1 yıl geri, 3 yıl ileri (yalnız istenirse)", () => {
    expect(
      errorsOf({ nightlyAmount: "1", startDate: "2025-11-07", lastNight: "2025-11-09" }),
    ).toEqual({});
    expect(
      errorsOf({ nightlyAmount: "1", startDate: "2025-11-06", lastNight: "2025-11-09" }),
    ).toEqual({ startDate: "Başlangıç tarihi en fazla 1 yıl geçmişte ve 3 yıl ileride olabilir." });
    expect(
      errorsOf({ nightlyAmount: "1", startDate: "2029-11-08", lastNight: "2029-11-09" }),
    ).toHaveProperty("startDate");
    expect(
      errorsOf(
        { nightlyAmount: "1", startDate: "2020-01-01", lastNight: "2020-01-31" },
        { today: "2026-11-07", checkWindow: false },
      ),
    ).toEqual({});
  });

  it("FormData'dan alanlar (bilinmeyen alanlar alınmaz)", () => {
    const fd = new FormData();
    fd.set("startDate", "2027-06-01");
    fd.set("nightlyAmount", "5.000");
    fd.set("propertyId", "x");
    expect(rateFormValues(fd)).toEqual({
      startDate: "2027-06-01",
      lastNight: "",
      nightlyAmount: "5.000",
      weeklyAmount: "",
      currency: "",
      minNights: "",
    });
  });
});

describe("dönem yardımcıları", () => {
  const periods = [
    { id: "c", startDate: "2027-07-16", endDate: "2027-08-01" },
    { id: "a", startDate: "2027-06-01", endDate: "2027-07-01" },
    { id: "b", startDate: "2027-07-01", endDate: "2027-07-15" },
  ];

  it("sıralama, gece sayısı, son gece", () => {
    expect(sortPeriods(periods).map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(periodNights(periods[1]!)).toBe(30);
    expect(lastNightOf(periods[1]!)).toBe("2027-06-30");
  });

  it("çakışma: kesişen var, bitişik yok ([başlangıç, bitiş))", () => {
    expect(overlappingPeriods("2027-07-10", "2027-07-20", periods).map((p) => p.id)).toEqual([
      "c",
      "b",
    ]);
    expect(overlappingPeriods("2027-07-15", "2027-07-16", periods)).toEqual([]);
    expect(overlappingPeriods("2027-08-01", "2027-08-05", periods)).toEqual([]);
    expect(overlappingPeriods("2027-05-20", "2027-06-01", periods)).toEqual([]);
  });

  it("fiyatsız geceler: '1–15' ve '16–31' gibi bitişi dahil sanılan girişte 1 gece boşluk", () => {
    expect(periodGaps(periods)).toEqual([
      { afterId: "b", from: "2027-07-15", to: "2027-07-16", nights: 1 },
    ]);
    expect(periodGaps([periods[1]!, periods[2]!])).toEqual([]);
  });

  it("takvim altyapısı: gece → dönem", () => {
    expect(periodForNight("2027-06-30", periods)?.id).toBe("a");
    expect(periodForNight("2027-07-01", periods)?.id).toBe("b");
    expect(periodForNight("2027-07-15", periods)).toBeNull();
    expect(
      nightsWithPeriods("2027-06-30", "2027-07-02", periods).map((n) => [n.date, n.period?.id]),
    ).toEqual([
      ["2027-06-30", "a"],
      ["2027-07-01", "b"],
    ]);
  });

  it("çakışma mesajı tarihleri gösterir", () => {
    expect(rateConflictMessage([{ startDate: "2027-07-01", endDate: "2027-07-16" }])).toBe(
      "Bu tarihler mevcut fiyat dönemiyle çakışıyor: 1–15 Temmuz 2027. Yeni dönem, mevcut dönemin son gecesinden sonraki gün başlayabilir.",
    );
  });
});

describe("denetim kaydı", () => {
  const property = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
  it("yalnız mülk kimliği ve alan adları; tutar/tarih değeri kabul edilmez", () => {
    expect(validateAuditEntry({ action: "property.rate_created", metadata: { property } })).toEqual(
      { property },
    );
    expect(
      validateAuditEntry({
        action: "property.rate_updated",
        metadata: { property, fields: ["dates", "nightly_amount", "min_nights"] },
      }),
    ).toEqual({ property, fields: ["dates", "nightly_amount", "min_nights"] });
    expect(() =>
      validateAuditEntry({
        action: "property.rate_created",
        // @ts-expect-error değer yazılamaz
        metadata: { property, nightly: 500000 },
      }),
    ).toThrow();
    expect(() =>
      validateAuditEntry({
        action: "property.rate_updated",
        // @ts-expect-error bilinmeyen alan adı
        metadata: { property, fields: ["price"] },
      }),
    ).toThrow();
  });
});

describe("uyarı yardımcıları (3.2)", () => {
  const base: RatePeriod = {
    id: "a",
    startDate: "2027-06-01",
    endDate: "2027-06-15",
    nightlyAmountMinor: 500000,
    weeklyAmountMinor: 3500000,
    currency: "EUR",
    minNights: null,
  };
  it("haftalık > 7 × gecelik", () => {
    expect(weeklyAboveNightly(base)).toBe(false); // eşit
    expect(weeklyAboveNightly({ ...base, weeklyAmountMinor: 3500001 })).toBe(true);
    expect(weeklyAboveNightly({ ...base, nightlyAmountMinor: null })).toBe(false);
    expect(weeklyAboveNightly({ ...base, weeklyAmountMinor: null })).toBe(false);
  });
  it("aynı fiyatlı bitişik dönemler", () => {
    const b = { ...base, id: "b", startDate: "2027-06-15", endDate: "2027-07-01" };
    expect(adjacentSamePrice([b, base])).toEqual(["a"]);
    expect(adjacentSamePrice([base, { ...b, nightlyAmountMinor: 1 }])).toEqual([]);
    expect(adjacentSamePrice([base, { ...b, startDate: "2027-06-16" }])).toEqual([]);
    expect(adjacentSamePrice([base, { ...b, minNights: 2 }])).toEqual([]);
  });
});
