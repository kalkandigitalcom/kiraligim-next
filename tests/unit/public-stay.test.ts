import { describe, expect, it } from "vitest";

import type { AvailabilityWindow } from "@/lib/availability";
import { quoteStay } from "@/lib/pricing";
import {
  dayView,
  EMPTY_STAY,
  evaluateStay,
  selectStayDay,
  stayMonthRange,
  stayWhatsappText,
  whatsappLink,
} from "@/lib/public-stay";
import { lastCheckInDay } from "@/lib/public-villa";
import type { RatePeriod } from "@/lib/rate-meta";
import { addDays } from "@/lib/reservation-meta";

/** F2c: public takvim seçimi, değerlendirme (checkStay + quoteStay) ve WhatsApp mesajı. */

const T = "2027-03-10";
const W: AvailabilityWindow = { today: T, lastCheckIn: lastCheckInDay(T), maxNights: 60 };
// Dolu: 15–17 Mart geceleri (18'i çıkış), 25–26 Mart geceleri.
const BUSY = [
  { start: "2027-03-15", end: "2027-03-18" },
  { start: "2027-03-25", end: "2027-03-27" },
];
const rate = (o: Partial<RatePeriod> & Pick<RatePeriod, "id" | "startDate" | "endDate">) =>
  ({
    nightlyAmountMinor: null,
    weeklyAmountMinor: null,
    currency: "TRY",
    minNights: null,
    cleaningFeeMinor: null,
    cleaningFeeFreeNights: null,
    ...o,
  }) as RatePeriod;
const RATES: RatePeriod[] = [
  rate({
    id: "d1",
    startDate: "2027-03-01",
    endDate: "2027-04-01",
    nightlyAmountMinor: 500000,
    weeklyAmountMinor: 3000000,
    minNights: 2,
    cleaningFeeMinor: 200000,
    cleaningFeeFreeNights: 7,
  }),
  rate({
    id: "d2",
    startDate: "2027-04-01",
    endDate: "2027-05-01",
    nightlyAmountMinor: 800000,
    minNights: 3,
    cleaningFeeMinor: 300000,
  }),
  // 1–9 Mayıs: fiyat yok.
  rate({ id: "d3", startDate: "2027-05-10", endDate: "2027-06-01", nightlyAmountMinor: 900000 }),
];
const sel = (checkIn: string | null, checkOut: string | null = null) => ({ checkIn, checkOut });
const ev = (ci: string, co: string) => evaluateStay(sel(ci, co), BUSY, W, RATES);

describe("tarih seçimi", () => {
  it("dolu gün giriş olarak seçilemez; seçim değişmez", () => {
    expect(dayView("2027-03-16", EMPTY_STAY, BUSY, W)).toMatchObject({
      busy: true,
      selectable: false,
    });
    expect(selectStayDay(EMPTY_STAY, "2027-03-16", BUSY, W)).toEqual(EMPTY_STAY);
    expect(selectStayDay(EMPTY_STAY, "2027-03-15", BUSY, W)).toEqual(EMPTY_STAY);
  });

  it("dolu aralığı kapsayan çıkış seçilemez ve değerlendirme reddeder", () => {
    const s = selectStayDay(sel("2027-03-12"), "2027-03-20", BUSY, W);
    // 20 Mart çıkış olamaz (aradaki geceler dolu) ama boş bir gün: yeni giriş olur.
    expect(s).toEqual(sel("2027-03-20"));
    expect(dayView("2027-03-20", sel("2027-03-12"), BUSY, W).checkoutOnly).toBe(false);
    expect(ev("2027-03-12", "2027-03-20")).toMatchObject({ state: "invalid", reason: "busy" });
    expect(dayView("2027-03-16", sel("2027-03-12"), BUSY, W).selectable).toBe(false);
  });

  it("çıkış günü dolu aralığın başlangıcı olabilir (önceki konaklamaya engel değil)", () => {
    const v = dayView("2027-03-15", sel("2027-03-12"), BUSY, W);
    expect(v).toMatchObject({ busy: true, selectable: true, checkoutOnly: true });
    expect(selectStayDay(sel("2027-03-12"), "2027-03-15", BUSY, W)).toEqual(
      sel("2027-03-12", "2027-03-15"),
    );
    expect(ev("2027-03-12", "2027-03-15").state).toBe("quote");
    // Dolu aralığın çıkış günü (18 Mart) yeni giriş olabilir.
    expect(dayView("2027-03-18", EMPTY_STAY, BUSY, W)).toMatchObject({
      busy: false,
      selectable: true,
    });
  });

  it("aynı gün giriş serbest; geçmiş gün seçilemez", () => {
    expect(dayView(T, EMPTY_STAY, BUSY, W).selectable).toBe(true);
    expect(selectStayDay(EMPTY_STAY, T, BUSY, W)).toEqual(sel(T));
    expect(ev(T, "2027-03-12").state).toBe("quote");
    expect(dayView("2027-03-09", EMPTY_STAY, BUSY, W)).toMatchObject({
      outside: true,
      selectable: false,
    });
  });

  it("en fazla 60 gece: 61. gece çıkış olarak seçilemez, değerlendirme reddeder", () => {
    const ci = "2027-06-01";
    expect(dayView(addDays(ci, 60), sel(ci), [], W).selectable).toBe(true);
    expect(dayView(addDays(ci, 61), sel(ci), [], W).role).toBeNull();
    // 61. gün çıkış olamaz: tıklama yeni giriş başlatır.
    expect(selectStayDay(sel(ci), addDays(ci, 61), [], W)).toEqual(sel(addDays(ci, 61)));
    expect(selectStayDay(sel(ci), addDays(ci, 60), [], W)).toEqual(sel(ci, addDays(ci, 60)));
    expect(evaluateStay(sel(ci, addDays(ci, 61)), [], W, RATES)).toMatchObject({
      state: "invalid",
      reason: "too_long",
    });
  });

  it("son giriş gününden sonrası giriş olamaz; takvim ayları ufukla sınırlı", () => {
    const after = addDays(W.lastCheckIn, 1);
    expect(dayView(after, EMPTY_STAY, [], W).selectable).toBe(false);
    expect(dayView(after, sel(W.lastCheckIn), [], W)).toMatchObject({
      selectable: true,
      checkoutOnly: true,
    });
    expect(stayMonthRange(W)).toEqual({
      min: "2027-03",
      max: addDays(W.lastCheckIn, 60).slice(0, 7),
    });
  });

  it("çıkış seçiliyken yeni tıklama yeni giriş başlatır; giriş/çıkış/ara rolleri", () => {
    const s = sel("2027-03-11", "2027-03-14");
    expect(dayView("2027-03-11", s, BUSY, W).role).toBe("checkin");
    expect(dayView("2027-03-12", s, BUSY, W).role).toBe("inside");
    expect(dayView("2027-03-14", s, BUSY, W).role).toBe("checkout");
    expect(selectStayDay(s, "2027-03-20", BUSY, W)).toEqual(sel("2027-03-20"));
  });
});

describe("fiyat teklifi (mevcut quoteStay)", () => {
  it("farklı sezon dönemlerini kapsayan hesap ve temizlik ücreti giriş döneminden", () => {
    const e = ev("2027-03-28", "2027-04-04");
    expect(e.state).toBe("quote");
    if (e.state !== "quote") return;
    // 4 gece × 5.000 (Mart) + 3 gece × 8.000 (Nisan) + temizlik 2.000 (Mart dönemi, 7 gece = ücretsiz sınırı)
    expect(e.quote.segments.map((s) => [s.periodId, s.nights, s.subtotalMinor])).toEqual([
      ["d1", 4, 2000000],
      ["d2", 3, 2400000],
    ]);
    // 7 gece: Mart döneminde "7 ve üzeri ücretsiz" → temizlik yok.
    expect(e.quote.cleaningFee).toBeNull();
    expect(e.quote.totalMinor).toBe(4400000);
    // Sonuç birebir quoteStay ile aynı (yeni kural yok).
    expect(e.quote).toEqual(quoteStay("2027-03-28", "2027-04-04", RATES));
  });

  it("temizlik ücreti giriş gecesinin döneminden: Mart girişi 2.000, Nisan girişi 3.000", () => {
    const march = ev("2027-03-29", "2027-04-02");
    const april = ev("2027-04-02", "2027-04-06");
    expect(march.state === "quote" && march.quote.cleaningFee).toMatchObject({
      amountMinor: 200000,
      periodId: "d1",
    });
    expect(april.state === "quote" && april.quote.cleaningFee).toMatchObject({
      amountMinor: 300000,
      periodId: "d2",
    });
    expect(april.state === "quote" && april.quote.totalMinor).toBe(4 * 800000 + 300000);
  });

  it("haftalık blok dönem içinde uygulanır", () => {
    const e = ev("2027-03-18", "2027-03-25");
    expect(e.state === "quote" && e.quote.totalMinor).toBe(3000000);
  });

  it("fiyatı eksik aralıkta toplam yok", () => {
    const e = ev("2027-04-28", "2027-05-12");
    expect(e.state).toBe("unpriced");
    expect("quote" in e && e.quote.totalMinor).toBeNull();
    // Hiç dönem olmayan gelecek tarih
    const far = evaluateStay(sel("2027-08-01", "2027-08-05"), [], W, RATES);
    expect(far.state).toBe("unpriced");
  });

  it("minimum konaklama karşılanmazsa toplam yok (public sayfada zorunlu)", () => {
    const e = ev("2027-04-05", "2027-04-07");
    expect(e).toMatchObject({ state: "min-nights", nights: 2, required: 3 });
    expect("quote" in e).toBe(false);
  });

  it("giriş seçili, çıkış bekleniyor: en geç çıkış bir sonraki dolu aralığın başı", () => {
    expect(evaluateStay(sel("2027-03-19"), BUSY, W, RATES)).toEqual({
      state: "checkout",
      checkIn: "2027-03-19",
      latest: "2027-03-25",
    });
    expect(evaluateStay(EMPTY_STAY, BUSY, W, RATES)).toEqual({ state: "empty" });
  });
});

describe("WhatsApp mesajı", () => {
  const base = { villaName: "Villa Defne", pageUrl: "https://kiraligim.com/villa/defne" };

  it("geçerli teklif: tarih, gece, kişi ve toplam; misafir bilgisi yok", () => {
    const text = stayWhatsappText({
      ...base,
      evaluation: ev("2027-03-28", "2027-04-04"),
      guests: 4,
    });
    expect(text).toBe(
      [
        "Merhaba, Villa Defne için 28 Mart – 4 Nisan 2027 (7 gece, 4 kişi) konaklamak istiyorum.",
        "Sayfadaki hesaplamaya göre toplam tutar ₺44.000,00.",
        "Müsaitliği ve fiyatı teyit edebilir misiniz?",
        "https://kiraligim.com/villa/defne",
      ].join("\n"),
    );
    const href = whatsappLink("+905321234567", text);
    const u = new URL(href);
    expect(u.origin + u.pathname).toBe("https://wa.me/905321234567");
    expect(u.searchParams.get("text")).toBe(text);
    expect([...u.searchParams.keys()]).toEqual(["text"]);
  });

  it("tutar hesaplanamayan seçimde mesajda tutar yok", () => {
    for (const e of [ev("2027-04-28", "2027-05-12"), ev("2027-04-05", "2027-04-07")]) {
      const text = stayWhatsappText({ ...base, evaluation: e });
      expect(text).toMatch(/konaklama hakkında bilgi almak istiyorum/);
      expect(text).not.toMatch(/₺|toplam/i);
    }
    expect(stayWhatsappText({ ...base, evaluation: ev("2027-04-28", "2027-05-12") })).toContain(
      "(14 gece)",
    );
  });

  it("önizlemede sayfa adresi yoksa (null) mesaja adres eklenmez", () => {
    const text = stayWhatsappText({
      villaName: "Villa Defne",
      pageUrl: null,
      evaluation: ev("2027-03-28", "2027-04-04"),
    });
    expect(text.split("\n")).toHaveLength(3);
    expect(text).not.toMatch(/https?:/);
    expect(
      stayWhatsappText({ villaName: "V", pageUrl: null, evaluation: { state: "empty" } }),
    ).toBe("Merhaba, V hakkında bilgi almak istiyorum.");
  });

  it("seçim yoksa genel mesaj (F2b ile aynı)", () => {
    expect(stayWhatsappText({ ...base, evaluation: { state: "empty" } })).toBe(
      "Merhaba, Villa Defne hakkında bilgi almak istiyorum. https://kiraligim.com/villa/defne",
    );
    expect(stayWhatsappText({ ...base, evaluation: ev("2027-03-12", "2027-03-20") })).not.toMatch(
      /Mart/,
    );
  });
});
