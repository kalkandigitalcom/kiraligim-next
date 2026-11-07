import { describe, expect, it } from "vitest";

import { quoteMessage, quoteStay, segmentFormula, unpricedSummary } from "@/lib/pricing";
import type { RatePeriod } from "@/lib/rate-meta";

const eur = (n: number) => n * 100;
const P: RatePeriod[] = [
  // A: Haziran — gecelik 5.000 €, haftalık 35.000 €, min 3
  {
    id: "A",
    startDate: "2027-06-01",
    endDate: "2027-07-01",
    nightlyAmountMinor: eur(5000),
    weeklyAmountMinor: eur(35000),
    currency: "EUR",
    minNights: 3,
  },
  // B: 1–15 Temmuz geceleri — gecelik 7.000 €, haftalık 45.000 €, min 5
  {
    id: "B",
    startDate: "2027-07-01",
    endDate: "2027-07-16",
    nightlyAmountMinor: eur(7000),
    weeklyAmountMinor: eur(45000),
    currency: "EUR",
    minNights: 5,
  },
  // C: 16–31 Temmuz geceleri — yalnız gecelik 9.000 €
  {
    id: "C",
    startDate: "2027-07-16",
    endDate: "2027-08-01",
    nightlyAmountMinor: eur(9000),
    weeklyAmountMinor: null,
    currency: "EUR",
    minNights: null,
  },
  // D: Eylül — yalnız haftalık 50.000 €
  {
    id: "D",
    startDate: "2027-09-01",
    endDate: "2027-10-01",
    nightlyAmountMinor: null,
    weeklyAmountMinor: eur(50000),
    currency: "EUR",
    minNights: null,
  },
];
const q = (a: string, b: string, periods: RatePeriod[] = P) => quoteStay(a, b, periods);
const parts = (a: string, b: string) =>
  q(a, b).segments.map((s) => [s.periodId, s.nights, s.weeks, s.extraNights, s.subtotalMinor]);

describe("tek dönem içinde", () => {
  it.each([
    ["S1 5 gece: yalnız gecelik", "2027-06-20", "2027-06-25", 25000],
    ["S2 7 gece: 1 hafta", "2027-06-10", "2027-06-17", 35000],
    ["S3 10 gece: 1 hafta + 3 gece", "2027-06-10", "2027-06-20", 50000],
    ["S4 14 gece: 2 hafta", "2027-06-01", "2027-06-15", 70000],
    ["6 gece: hafta yok", "2027-06-01", "2027-06-07", 30000],
    ["S14 çıkış günü yeni dönemin başlangıcı: yalnız 1 gece", "2027-06-30", "2027-07-01", 5000],
    ["S10 yalnız haftalık dönem, 7 gece", "2027-09-01", "2027-09-08", 50000],
    ["yalnız haftalık dönem, 28 gece", "2027-09-01", "2027-09-29", 200000],
  ])("%s", (_name, a, b, total) => {
    const r = q(a, b);
    expect(r).toMatchObject({ ok: true, totalMinor: eur(total), currency: "EUR", issues: [] });
  });

  it("döküm alanları (S3)", () => {
    expect(q("2027-06-10", "2027-06-20").segments).toEqual([
      {
        periodId: "A",
        from: "2027-06-10",
        to: "2027-06-20",
        nights: 10,
        weeks: 1,
        weeklyAmountMinor: eur(35000),
        extraNights: 3,
        nightlyAmountMinor: eur(5000),
        subtotalMinor: eur(50000),
      },
    ]);
  });
});

describe("dönemlere yayılan konaklama: haftalık blok dönem sınırını aşmaz", () => {
  it("S5 7 gece, 4+3: iki dönemde de hafta yok", () => {
    expect(parts("2027-06-27", "2027-07-04")).toEqual([
      ["A", 4, 0, 4, eur(20000)],
      ["B", 3, 0, 3, eur(21000)],
    ]);
    expect(q("2027-06-27", "2027-07-04").totalMinor).toBe(eur(41000));
  });

  it("S6 14 gece, 7+7: her dönemde bir hafta", () => {
    expect(parts("2027-06-24", "2027-07-08")).toEqual([
      ["A", 7, 1, 0, eur(35000)],
      ["B", 7, 1, 0, eur(45000)],
    ]);
    expect(q("2027-06-24", "2027-07-08").totalMinor).toBe(eur(80000));
  });

  it("S7 16 gece, 5+11: hafta yalnız uzun parçada", () => {
    expect(parts("2027-06-26", "2027-07-12")).toEqual([
      ["A", 5, 0, 5, eur(25000)],
      ["B", 11, 1, 4, eur(73000)],
    ]);
    expect(q("2027-06-26", "2027-07-12").totalMinor).toBe(eur(98000));
  });

  it("S8 haftalığı olmayan döneme geçiş: 6+4", () => {
    expect(parts("2027-07-10", "2027-07-20")).toEqual([
      ["B", 6, 0, 6, eur(42000)],
      ["C", 4, 0, 4, eur(36000)],
    ]);
    expect(q("2027-07-10", "2027-07-20").totalMinor).toBe(eur(78000));
  });

  it("S15 üç dönem, 21 gece: 3 + (2 hafta + 1) + 3", () => {
    expect(parts("2027-06-28", "2027-07-19")).toEqual([
      ["A", 3, 0, 3, eur(15000)],
      ["B", 15, 2, 1, eur(97000)],
      ["C", 3, 0, 3, eur(27000)],
    ]);
    expect(q("2027-06-28", "2027-07-19").totalMinor).toBe(eur(139000));
  });

  it("aynı fiyatlı bitişik dönemler de ayrı parçadır (otomatik birleştirme yok)", () => {
    const twin: RatePeriod[] = [
      { ...P[0]!, id: "X", endDate: "2027-06-15" },
      { ...P[0]!, id: "Y", startDate: "2027-06-15" },
    ];
    const r = q("2027-06-11", "2027-06-18", twin); // 4 + 3 gece
    expect(r.segments.map((s) => [s.periodId, s.weeks])).toEqual([
      ["X", 0],
      ["Y", 0],
    ]);
    expect(r.totalMinor).toBe(eur(35000)); // 7 × 5.000; haftalık uygulanmadı
  });

  it("haftalık 7 × gecelikten pahalıysa da haftalık kullanılır", () => {
    const pricey: RatePeriod[] = [{ ...P[0]!, weeklyAmountMinor: eur(40000) }];
    expect(q("2027-06-01", "2027-06-07", pricey).totalMinor).toBe(eur(30000)); // 6 gece
    expect(q("2027-06-01", "2027-06-08", pricey).totalMinor).toBe(eur(40000)); // 7 gece
  });
});

describe("hesaplanamayan durumlar", () => {
  it("S9 tanımsız geceler: toplam yok, kısmi döküm ve özet", () => {
    const r = q("2027-07-28", "2027-08-03");
    expect(r).toMatchObject({ ok: false, totalMinor: null });
    expect(r.issues).toEqual([
      { kind: "unpriced", from: "2027-08-01", to: "2027-08-03", nights: 2 },
    ]);
    expect(r.segments.map((s) => [s.periodId, s.subtotalMinor])).toEqual([["C", eur(36000)]]);
    expect(unpricedSummary(r)).toBe("1–3 Ağustos 2027 (2 gece)");
    expect(quoteMessage(r, "Deniz Villa")).toBeNull();
  });

  it("tek bir fiyatsız gece bile yeterli (ortada boşluk)", () => {
    const holes: RatePeriod[] = [
      { ...P[0]!, endDate: "2027-06-10" },
      { ...P[0]!, id: "A2", startDate: "2027-06-11" },
    ];
    const r = q("2027-06-08", "2027-06-13", holes);
    expect(r.ok).toBe(false);
    expect(r.issues).toEqual([
      { kind: "unpriced", from: "2027-06-10", to: "2027-06-11", nights: 1 },
    ]);
  });

  it("hiç dönem yok", () => {
    const r = q("2027-12-01", "2027-12-05");
    expect(r).toMatchObject({ ok: false, totalMinor: null, currency: null, segments: [] });
    expect(r.issues).toEqual([
      { kind: "unpriced", from: "2027-12-01", to: "2027-12-05", nights: 4 },
    ]);
  });

  it("S11 yalnız haftalık dönemde 7'ye bölünmeyen geceler", () => {
    const r = q("2027-09-01", "2027-09-10");
    expect(r.ok).toBe(false);
    expect(r.issues).toEqual([
      { kind: "nightly-missing", periodId: "D", from: "2027-09-08", to: "2027-09-10", nights: 2 },
    ]);
    expect(r.segments[0]).toMatchObject({ weeks: 1, extraNights: 2, subtotalMinor: null });
  });

  it("farklı para birimi (eski veri) hesaplanmaz", () => {
    const mixed: RatePeriod[] = [P[0]!, { ...P[1]!, currency: "GBP" }];
    const r = q("2027-06-28", "2027-07-03", mixed);
    expect(r.ok).toBe(false);
    expect(r.issues).toContainEqual({ kind: "currency-mismatch" });
    expect(r.currency).toBeNull();
  });

  it("toplam rezervasyon tutar sınırını aşarsa kullanılamaz", () => {
    const huge: RatePeriod[] = [{ ...P[0]!, nightlyAmountMinor: 900_000_000_000 }];
    const r = q("2027-06-01", "2027-06-03", huge);
    expect(r.ok).toBe(false);
    expect(r.issues).toContainEqual({ kind: "too-large" });
  });
});

describe("minimum konaklama (giriş gecesinin dönemi; uyarı)", () => {
  it("S12 A'da 2 gece < 3: uyarı, toplam yine hesaplanır", () => {
    expect(q("2027-06-28", "2027-06-30")).toMatchObject({
      ok: true,
      totalMinor: eur(10000),
      minNights: { required: 3, periodId: "A" },
    });
  });

  it("S13 A→B 2 gece: giriş dönemi A (3) esas; B'nin 5'i dikkate alınmaz", () => {
    expect(q("2027-06-30", "2027-07-02").minNights).toEqual({ required: 3, periodId: "A" });
    expect(q("2027-06-28", "2027-07-02").minNights).toBeNull(); // 4 gece ≥ 3
  });

  it("giriş gecesi fiyatsızsa minimum denetlenmez", () => {
    expect(q("2027-08-30", "2027-09-02").minNights).toBeNull();
  });
});

describe("döküm ve teklif metni", () => {
  it("parça formülü", () => {
    const [b] = q("2027-07-01", "2027-07-12").segments;
    expect(segmentFormula(b!, "EUR")).toBe("1 hafta × €45.000,00 + 4 gece × €7.000,00");
  });

  it("teklif metni: dönemler, toplam; kişisel bilgi yok", () => {
    expect(quoteMessage(q("2027-06-26", "2027-07-12"), "Deniz Villa")).toBe(
      [
        "Merhaba,",
        "",
        "Deniz Villa için 26 Haziran – 12 Temmuz 2027 (16 gece) konaklama teklifimiz:",
        "",
        "• 26 Haziran – 1 Temmuz 2027 (5 gece): 5 gece × €5.000,00 = €25.000,00",
        "• 1–12 Temmuz 2027 (11 gece): 1 hafta × €45.000,00 + 4 gece × €7.000,00 = €73.000,00",
        "",
        "Toplam: €98.000,00",
        "",
        "Fiyatlar konaklama tarihlerine göre hesaplanmıştır. Rezervasyon için bize yanıt verebilirsiniz.",
      ].join("\n"),
    );
  });

  it("küsuratlı fiyatlarda kuruş hassasiyeti", () => {
    const cents: RatePeriod[] = [
      { ...P[0]!, nightlyAmountMinor: 333333, weeklyAmountMinor: 2000001, currency: "TRY" },
    ];
    expect(q("2027-06-01", "2027-06-11", cents)).toMatchObject({
      totalMinor: 2000001 + 3 * 333333,
      currency: "TRY",
    });
  });
});
