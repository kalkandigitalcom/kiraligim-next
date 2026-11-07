import { describe, expect, it } from "vitest";

import { validateAuditEntry } from "@/server/audit/record";
import {
  addDays,
  addYears,
  balanceOf,
  checkInWindow,
  formatMoney,
  formatStay,
  isIsoDate,
  istanbulToday,
  minorToInput,
  nightsBetween,
  parseAmount,
  toMinor,
} from "@/lib/reservation-meta";
import { blockInput, reservationInput } from "@/server/reservations/schema";
import { conflictMessage } from "@/server/reservations/service";

const rules = { today: "2026-11-07", checkWindow: true };
const base = {
  checkIn: "2026-12-01",
  checkOut: "2026-12-05",
  guestName: "  Ayşe Yılmaz ",
  adults: "2",
};
const errorsOf = (input: Record<string, unknown>, r = rules) => {
  const p = reservationInput(r).safeParse({ ...base, ...input });
  return p.success
    ? {}
    : Object.fromEntries(p.error.issues.map((i) => [i.path.join("."), i.message]));
};

describe("tarih yardımcıları", () => {
  it("geçerli gün denetimi", () => {
    expect(isIsoDate("2026-02-28")).toBe(true);
    expect(isIsoDate("2028-02-29")).toBe(true);
    for (const bad of [
      "2026-02-29",
      "2026-13-01",
      "2026-1-1",
      "26-01-01",
      "2026-01-01T00:00",
      "",
    ]) {
      expect(isIsoDate(bad), bad).toBe(false);
    }
  });

  it("gece sayısı, gün ekleme (ay/yıl sınırı, yaz saati yok)", () => {
    expect(nightsBetween("2026-12-30", "2027-01-02")).toBe(3);
    expect(nightsBetween("2026-03-28", "2026-03-30")).toBe(2);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
  });

  it("yıl ekleme: 29 Şubat → 28 Şubat (PostgreSQL interval ile aynı)", () => {
    expect(addYears("2028-02-29", -1)).toBe("2027-02-28");
    expect(addYears("2026-11-07", 3)).toBe("2029-11-07");
    expect(checkInWindow("2026-11-07")).toEqual({ min: "2025-11-07", max: "2029-11-07" });
  });

  it("bugün Europe/Istanbul'a göre (UTC gece yarısından önce/sonra)", () => {
    expect(istanbulToday(new Date("2026-11-07T20:59:00Z"))).toBe("2026-11-07");
    expect(istanbulToday(new Date("2026-11-07T21:00:00Z"))).toBe("2026-11-08");
  });

  it("konaklama aralığı biçimi", () => {
    expect(formatStay("2026-07-12", "2026-07-15")).toBe("12–15 Temmuz 2026");
    expect(formatStay("2026-06-30", "2026-07-03")).toBe("30 Haziran – 3 Temmuz 2026");
    expect(formatStay("2026-12-30", "2027-01-02")).toBe("30 Aralık 2026 – 2 Ocak 2027");
  });
});

describe("tutar yardımcıları (kuruş)", () => {
  it.each([
    ["12.500,50", 12500.5],
    ["12500,5", 12500.5],
    ["12500.50", 12500.5],
    ["12.500", 12500],
    ["1.234.567,89", 1234567.89],
    ["0", 0],
    [" 750 ₺", 750],
    ["99,9", 99.9],
  ])("geçerli: %s", (input, n) => expect(parseAmount(input)).toBe(n));

  it.each(["abc", "12,500,00", "1.2.3", "-5", "12,345", "1e5", "12.5.6,00"])(
    "geçersiz: %s",
    (input) => expect(parseAmount(input)).toBeNaN(),
  );

  it("boş → undefined; kuruş dönüşümü ve gösterim", () => {
    expect(parseAmount("  ")).toBeUndefined();
    expect(toMinor(12500.5)).toBe(1250050);
    expect(toMinor(0.29)).toBe(29);
    expect(minorToInput(1250050)).toBe("12.500,50");
    expect(formatMoney(1250050, "TRY")).toBe("₺12.500,50");
    expect(formatMoney(99, "EUR")).toBe("€0,99");
    expect(balanceOf(1000000, 250000)).toBe(750000);
    expect(balanceOf(1000000, null)).toBe(1000000);
    expect(balanceOf(null, null)).toBeNull();
  });
});

describe("rezervasyon formu", () => {
  it("dönüşüm: kırpma, varsayılanlar (onaylı, doğrudan, 0 çocuk), tutar kuruş", () => {
    expect(
      reservationInput(rules).parse({
        ...base,
        guestPhone: " +90 532  123 45 67 ",
        guestEmail: " Ayse@Ornek.COM ",
        totalAmount: "12.500,00",
        depositAmount: "2.500",
        currency: "EUR",
        note: "  Geç giriş  ",
      }),
    ).toEqual({
      type: "reservation",
      checkIn: "2026-12-01",
      checkOut: "2026-12-05",
      status: "confirmed",
      source: "direct",
      guestName: "Ayşe Yılmaz",
      guestPhone: "+90 532 123 45 67",
      guestEmail: "ayse@ornek.com",
      adults: 2,
      children: 0,
      totalAmountMinor: 1250000,
      depositAmountMinor: 250000,
      currency: "EUR",
      note: "Geç giriş",
    });
  });

  it("tutar yoksa para birimi ve ön ödeme kaydedilmez", () => {
    const v = reservationInput(rules).parse({ ...base, currency: "TRY" });
    expect([v.totalAmountMinor, v.depositAmountMinor, v.currency]).toEqual([null, null, null]);
  });

  it("zorunlu alanlar ve biçimler", () => {
    expect(errorsOf({ guestName: "", adults: "", checkIn: "" })).toEqual({
      guestName: "Misafir adı gerekli.",
      adults: "Yetişkin sayısı gerekli.",
      checkIn: "Giriş tarihi gerekli.",
    });
    expect(errorsOf({ adults: "0" })).toEqual({ adults: "Yetişkin sayısı en az 1 olmalı." });
    expect(errorsOf({ children: "-1" })).toHaveProperty("children");
    expect(errorsOf({ guestPhone: "abc" })).toHaveProperty("guestPhone");
    expect(errorsOf({ guestEmail: "ayse@" })).toHaveProperty("guestEmail");
    expect(errorsOf({ source: "tripadvisor" })).toHaveProperty("source");
    expect(errorsOf({ status: "cancelled" })).toHaveProperty("status");
    expect(errorsOf({ checkIn: "2026-02-30" })).toEqual({
      checkIn: "Giriş tarihi geçerli bir tarih olmalı.",
    });
  });

  it("tarihler: çıkış girişten sonra, en fazla 365 gece, aynı gün değil", () => {
    expect(errorsOf({ checkOut: "2026-12-01" })).toEqual({
      checkOut: "Çıkış tarihi giriş tarihinden sonra olmalı.",
    });
    expect(errorsOf({ checkOut: "2026-11-30" })).toHaveProperty("checkOut");
    expect(errorsOf({ checkOut: "2027-12-02" })).toEqual({
      checkOut: "Konaklama en fazla 365 gece olabilir.",
    });
    expect(errorsOf({ checkOut: "2027-12-01" })).toEqual({});
  });

  it("giriş tarihi penceresi: 1 yıl geri, 3 yıl ileri (yalnız istenirse)", () => {
    expect(errorsOf({ checkIn: "2025-11-07", checkOut: "2025-11-10" })).toEqual({});
    expect(errorsOf({ checkIn: "2025-11-06", checkOut: "2025-11-10" })).toEqual({
      checkIn: "Giriş tarihi en fazla 1 yıl geçmişte ve 3 yıl ileride olabilir.",
    });
    expect(errorsOf({ checkIn: "2029-11-07", checkOut: "2029-11-10" })).toEqual({});
    expect(errorsOf({ checkIn: "2029-11-08", checkOut: "2029-11-10" })).toHaveProperty("checkIn");
    expect(
      errorsOf(
        { checkIn: "2020-01-01", checkOut: "2020-01-05" },
        { today: "2026-11-07", checkWindow: false },
      ),
    ).toEqual({});
  });

  it("tutarlar: ön ödeme toplamı aşamaz, toplam olmadan ön ödeme yok, para birimi zorunlu", () => {
    expect(errorsOf({ totalAmount: "1.000", depositAmount: "1.000,01", currency: "TRY" })).toEqual({
      depositAmount: "Ön ödeme toplam tutardan büyük olamaz.",
    });
    expect(errorsOf({ depositAmount: "100" })).toEqual({
      totalAmount: "Ön ödeme için önce toplam tutarı girin.",
    });
    expect(errorsOf({ totalAmount: "100" })).toEqual({ currency: "Para birimini seçin." });
    expect(errorsOf({ totalAmount: "100", currency: "JPY" })).toHaveProperty("currency");
    expect(errorsOf({ totalAmount: "12,345", currency: "TRY" })).toHaveProperty("totalAmount");
    expect(errorsOf({ totalAmount: "10.000.000.000", currency: "TRY" })).toEqual({
      totalAmount: "Toplam tutar çok büyük.",
    });
  });
});

describe("blok formu", () => {
  it("yalnız tarih ve açıklama; misafir/tutar alanları yok sayılır", () => {
    expect(
      blockInput(rules).parse({
        checkIn: "2026-12-01",
        checkOut: "2026-12-03",
        note: "Bakım",
        guestName: "X",
        totalAmount: "100",
      }),
    ).toEqual({ type: "block", checkIn: "2026-12-01", checkOut: "2026-12-03", note: "Bakım" });
    const r = blockInput(rules).safeParse({ checkIn: "2026-12-03", checkOut: "2026-12-03" });
    expect(r.success).toBe(false);
  });
});

describe("çakışma mesajı ve denetim kaydı", () => {
  it("çakışan kayıtlar tarih ve türüyle; misafir adı yok", () => {
    expect(
      conflictMessage([
        {
          id: "a",
          kind: "reservation",
          status: "confirmed",
          checkIn: "2026-07-12",
          checkOut: "2026-07-15",
        },
        {
          id: "b",
          kind: "block",
          status: "confirmed",
          checkIn: "2026-07-15",
          checkOut: "2026-07-16",
        },
        {
          id: "c",
          kind: "reservation",
          status: "pending",
          checkIn: "2026-07-20",
          checkOut: "2026-07-22",
        },
      ]),
    ).toBe(
      "Seçilen tarihler dolu: 12–15 Temmuz 2026 (onaylı rezervasyon); 15–16 Temmuz 2026 (blok); 20–22 Temmuz 2026 (beklemede rezervasyon).",
    );
  });

  it("denetim metadata'sı: alan adları ve durumlar; değer ve kişisel veri kabul edilmez", () => {
    const property = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    expect(
      validateAuditEntry({
        action: "reservation.created",
        metadata: { property, kind: "reservation", status: "pending", source: "airbnb" },
      }),
    ).toEqual({ property, kind: "reservation", status: "pending", source: "airbnb" });
    expect(
      validateAuditEntry({
        action: "reservation.updated",
        metadata: { property, fields: ["dates", "guest_name", "amounts"] },
      }),
    ).toEqual({ property, fields: ["dates", "guest_name", "amounts"] });
    expect(() =>
      validateAuditEntry({
        action: "reservation.created",
        // @ts-expect-error bilinmeyen alan
        metadata: { property, kind: "block", status: "confirmed", source: null, guestName: "A" },
      }),
    ).toThrow();
    expect(() =>
      validateAuditEntry({
        action: "reservation.updated",
        // @ts-expect-error değer yazılamaz
        metadata: { property, fields: ["dates"], total: 100 },
      }),
    ).toThrow();
  });
});
