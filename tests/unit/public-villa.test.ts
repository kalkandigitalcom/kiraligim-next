import { describe, expect, it } from "vitest";

import {
  canCheckIn,
  canCheckOut,
  checkStay,
  isNightBusy,
  latestCheckOut,
  normalizeBusy,
  overlapsBusy,
} from "@/lib/availability";
import { quoteStay } from "@/lib/pricing";
import { busyQueryWindow, lastCheckInDay, PUBLIC_BOOKING } from "@/lib/public-villa";
import { PUBLIC_VILLA_KEYS, toPublicPhotos, toRatePeriods } from "@/server/public/villa";
import { createMemoryStorage } from "@/server/storage/memory";

const W = { today: "2027-06-10", lastCheckIn: "2028-12-10", maxNights: 60 };
// Birleşik dolu aralıklar: [12, 18) ve [25, 27)
const BUSY = [
  { start: "2027-06-12", end: "2027-06-18" },
  { start: "2027-06-25", end: "2027-06-27" },
];

describe("takvim penceresi", () => {
  it("son giriş günü: bugün + 18 ay; ay sonu taşması ayın son gününe", () => {
    expect(PUBLIC_BOOKING.monthsAhead).toBe(18);
    expect(lastCheckInDay("2027-06-10")).toBe("2028-12-10");
    expect(lastCheckInDay("2026-08-31")).toBe("2028-02-29");
    expect(lastCheckInDay("2027-08-31")).toBe("2029-02-28");
    expect(lastCheckInDay("2026-12-31")).toBe("2028-06-30");
  });

  it("dolu tarih sorgu penceresi: bugün … son giriş + en uzun konaklama + 1", () => {
    expect(busyQueryWindow("2027-06-10")).toEqual({ from: "2027-06-10", to: "2029-02-09" });
  });
});

describe("dolu aralıklar", () => {
  it("normalleştirme: sıralar, boş/ters olanları atar, kesişen ve bitişikleri birleştirir", () => {
    expect(
      normalizeBusy([
        { start: "2027-06-15", end: "2027-06-18" },
        { start: "2027-06-12", end: "2027-06-15" },
        { start: "2027-06-20", end: "2027-06-20" },
        { start: "2027-06-30", end: "2027-06-29" },
        { start: "2027-06-16", end: "2027-06-17" },
      ]),
    ).toEqual([{ start: "2027-06-12", end: "2027-06-18" }]);
  });

  it("gece doluluğu: başlangıç dahil, bitiş (çıkış günü) hariç", () => {
    expect(isNightBusy("2027-06-11", BUSY)).toBe(false);
    expect(isNightBusy("2027-06-12", BUSY)).toBe(true);
    expect(isNightBusy("2027-06-17", BUSY)).toBe(true);
    expect(isNightBusy("2027-06-18", BUSY)).toBe(false);
    expect(isNightBusy("2027-06-26", BUSY)).toBe(true);
    expect(isNightBusy("2027-06-27", BUSY)).toBe(false);
    expect(isNightBusy("2027-06-01", [])).toBe(false);
  });

  it("kesişme", () => {
    expect(overlapsBusy("2027-06-10", "2027-06-12", BUSY)).toBe(false);
    expect(overlapsBusy("2027-06-18", "2027-06-25", BUSY)).toBe(false);
    expect(overlapsBusy("2027-06-17", "2027-06-19", BUSY)).toBe(true);
  });
});

describe("giriş ve çıkış seçimi", () => {
  it("aynı gün giriş (gece boşsa); geçmiş ve ufuk ötesi kapalı", () => {
    expect(canCheckIn("2027-06-10", BUSY, W)).toBe(true);
    expect(canCheckIn("2027-06-09", BUSY, W)).toBe(false);
    expect(canCheckIn("2028-12-10", BUSY, W)).toBe(true);
    expect(canCheckIn("2028-12-11", BUSY, W)).toBe(false);
    expect(canCheckIn("2027-06-12", BUSY, W)).toBe(false);
    expect(canCheckIn("2027-06-18", BUSY, W)).toBe(true); // önceki misafirin çıkış günü
  });

  it("çıkış: sonraki dolu aralığın başlangıç gününe kadar (dahil)", () => {
    expect(latestCheckOut("2027-06-10", BUSY, W)).toBe("2027-06-12");
    expect(canCheckOut("2027-06-10", "2027-06-12", BUSY, W)).toBe(true);
    expect(canCheckOut("2027-06-10", "2027-06-13", BUSY, W)).toBe(false);
    expect(canCheckOut("2027-06-10", "2027-06-10", BUSY, W)).toBe(false);
    expect(latestCheckOut("2027-06-12", BUSY, W)).toBeNull();
  });

  it("en uzun konaklama sınırı", () => {
    expect(latestCheckOut("2027-07-01", BUSY, W)).toBe("2027-08-30");
    expect(checkStay("2027-07-01", "2027-08-31", BUSY, W)).toEqual({
      ok: false,
      reason: "too_long",
    });
  });

  it("konaklama denetimi", () => {
    expect(checkStay("2027-06-18", "2027-06-25", BUSY, W)).toEqual({ ok: true, nights: 7 });
    expect(checkStay("2027-06-17", "2027-06-20", BUSY, W)).toEqual({ ok: false, reason: "busy" });
    expect(checkStay("2027-06-05", "2027-06-08", BUSY, W)).toEqual({ ok: false, reason: "past" });
    expect(checkStay("2029-01-01", "2029-01-03", BUSY, W)).toEqual({
      ok: false,
      reason: "too_far",
    });
    expect(checkStay("2027-06-20", "2027-06-20", BUSY, W)).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(checkStay("bozuk", "2027-06-20", BUSY, W)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("veritabanı satırlarından public biçime", () => {
  const rows = [
    {
      start_date: "2027-06-01",
      end_date: "2027-07-01",
      nightly_amount_minor: "850000",
      weekly_amount_minor: "5500000",
      currency: "TRY",
      min_nights: 5,
      cleaning_fee_minor: "250000",
      cleaning_fee_free_nights: 7,
    },
    {
      start_date: "2027-07-01",
      end_date: "2027-09-01",
      nightly_amount_minor: 1100000,
      weekly_amount_minor: null,
      currency: "TRY",
      min_nights: null,
      cleaning_fee_minor: null,
      cleaning_fee_free_nights: null,
    },
    {
      start_date: "2027-09-01",
      end_date: "2027-10-01",
      nightly_amount_minor: 1,
      weekly_amount_minor: null,
      currency: "XXX",
      min_nights: null,
      cleaning_fee_minor: null,
      cleaning_fee_free_nights: null,
    },
  ];

  it("fiyat dönemleri: sentetik kimlik, sayı tutarlar, bilinmeyen para birimi atlanır", () => {
    const periods = toRatePeriods(rows);
    expect(periods.map((p) => p.id)).toEqual(["d1", "d2"]);
    expect(periods[0]).toEqual({
      id: "d1",
      startDate: "2027-06-01",
      endDate: "2027-07-01",
      nightlyAmountMinor: 850000,
      weeklyAmountMinor: 5500000,
      currency: "TRY",
      minNights: 5,
      cleaningFeeMinor: 250000,
      cleaningFeeFreeNights: 7,
    });
  });

  it("quoteStay ile panel kartıyla aynı sonuç: dönem geçişi, haftalık, temizlik", () => {
    const periods = toRatePeriods(rows);
    // 27 Haz – 5 Tem: 4 gece Haziran (8.500) + 4 gece Temmuz (11.000); 8 gece → temizlik yok.
    expect(quoteStay("2027-06-27", "2027-07-05", periods).totalMinor).toBe(7800000);
    // 14–19 Haz: 5 gece × 8.500 + temizlik 2.500
    const q = quoteStay("2027-06-14", "2027-06-19", periods);
    expect(q.totalMinor).toBe(4500000);
    expect(q.minNights).toBeNull();
    // 1–8 Haz: 1 hafta (55.000), 7 gece → temizlik yok
    expect(quoteStay("2027-06-01", "2027-06-08", periods).totalMinor).toBe(5500000);
    // Fiyatsız dönem (bilinmeyen para birimi atlandı) → toplam yok
    expect(quoteStay("2027-08-30", "2027-09-02", periods).ok).toBe(false);
  });

  it("fotoğraflar: herkese açık adresler ve boyut; depolama yoksa liste boş", () => {
    const storage = createMemoryStorage("https://img.test.invalid");
    const prefix =
      "w/018f0000-0000-7000-8000-000000000001/p/018f0000-0000-7000-8000-000000000002/018f0000-0000-7000-8000-000000000003";
    const out = toPublicPhotos(
      [{ storage_prefix: prefix, width: 1800, height: 1200, is_cover: true }],
      storage,
    );
    expect(out).toEqual([
      {
        src: `https://img.test.invalid/${prefix}/1200.webp`,
        thumb: `https://img.test.invalid/${prefix}/400.webp`,
        large: `https://img.test.invalid/${prefix}/2000.webp`,
        srcSet: `https://img.test.invalid/${prefix}/400.webp 400w, https://img.test.invalid/${prefix}/1200.webp 1200w, https://img.test.invalid/${prefix}/2000.webp 2000w`,
        width: 1800,
        height: 1200,
        isCover: true,
      },
    ]);
    expect(
      toPublicPhotos([{ storage_prefix: prefix, width: 1, height: 1, is_cover: false }], null),
    ).toEqual([]);
  });

  it("sayfa nesnesi anahtar listesi sabit (yeni alan eklemek bilinçli bir değişiklik olmalı)", () => {
    // Revizyon: yataklar çıktı; harita, mesafeler, hazır kurallar ve fiyata dahil olanlar eklendi;
    // çoklu video tek videoya indi. Revizyon 2: harita iki yöntemli `map` oldu; iptal ve ödeme
    // koşulları çıktı.
    expect([...PUBLIC_VILLA_KEYS]).toEqual([
      "slug",
      "name",
      "propertyType",
      "descriptionHtml",
      "descriptionText",
      "youtubeVideoId",
      "maxGuests",
      "bedrooms",
      "bathrooms",
      "location",
      "map",
      "distances",
      "pools",
      "amenities",
      "checkInTime",
      "checkOutTime",
      "houseRuleKeys",
      "houseRules",
      "priceIncludes",
      "whatsapp",
      "photos",
      "rates",
      "currency",
      "busy",
      "window",
      "updatedAt",
    ]);
    for (const k of PUBLIC_VILLA_KEYS)
      expect(k).not.toMatch(/^guest|address|postal|^lat|^lng|beds|license|workspace|status/i);
  });
});
