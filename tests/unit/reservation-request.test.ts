import { describe, expect, it } from "vitest";

import { quoteStay } from "@/lib/pricing";
import { cleaningNote, evaluateStay, stayWhatsappText } from "@/lib/public-stay";
import type { RatePeriod } from "@/lib/rate-meta";
import {
  MANUAL_RESERVATION_SOURCES,
  RESERVATION_SOURCE_LABELS,
  RESERVATION_SOURCES,
  requestReference,
} from "@/lib/reservation-meta";
import { clampGuests, defaultGuests, REQUEST_ERROR_MESSAGES } from "@/lib/reservation-request";
import { createMemoryRateLimit } from "@/server/public/memory-rate-limit";
import { reservationRequestEmail } from "@/server/public/reservation-request-email";
import { reservationRequestInput } from "@/server/public/reservation-request";

/** F3: villa sayfası rezervasyon talebi — saf kurallar. */

const base = {
  slug: "villa-defne",
  checkIn: "2027-07-10",
  checkOut: "2027-07-14",
  guests: "2",
  name: "  Ayşe Yılmaz ",
  phone: "0532 111 22 33",
  email: "",
  note: "",
  consent: true,
};
const errs = (over: Record<string, unknown>) => {
  const r = reservationRequestInput.safeParse({ ...base, ...over });
  return r.success ? {} : Object.fromEntries(r.error.issues.map((i) => [i.path[0], i.message]));
};

describe("talep formu şeması (sunucu)", () => {
  it("normalleştirme: ad kırpılır, telefon uluslararası biçim, boş e-posta/not yok sayılır", () => {
    const v = reservationRequestInput.parse(base);
    expect(v).toMatchObject({ name: "Ayşe Yılmaz", phone: "+905321112233", guests: 2 });
    expect(v.email).toBeUndefined();
    expect(v.note).toBeUndefined();
    expect(reservationRequestInput.parse({ ...base, phone: "+44 7700 900123" }).phone).toBe(
      "+447700900123",
    );
    expect(reservationRequestInput.parse({ ...base, email: "A@B.Co" }).email).toBe("a@b.co");
  });

  it("tutar/işletme/mülk alanı şemada yok: istemci gönderse de çıktıya girmez", () => {
    const v = reservationRequestInput.parse({
      ...base,
      totalMinor: 1,
      currency: "TRY",
      workspaceId: "x",
      propertyId: "y",
    });
    for (const k of ["totalMinor", "currency", "workspaceId", "propertyId"]) {
      expect(v, k).not.toHaveProperty(k);
    }
  });

  it("hatalar: zorunlu alanlar, telefon, e-posta, onay, kişi, tarih sırası, tuzak alan", () => {
    expect(errs({ name: " " })).toHaveProperty("name");
    expect(errs({ phone: "" })).toHaveProperty("phone");
    expect(errs({ phone: "12345" })).toHaveProperty("phone");
    expect(errs({ email: "x@" })).toHaveProperty("email");
    expect(errs({ consent: false })).toHaveProperty("consent");
    expect(errs({ consent: "on" })).toHaveProperty("consent");
    expect(errs({ guests: "0" })).toHaveProperty("guests");
    expect(errs({ guests: "2.5" })).toHaveProperty("guests");
    expect(errs({ checkOut: "2027-07-10" })).toHaveProperty("checkIn");
    expect(errs({ checkIn: "2027-02-30" })).toHaveProperty("checkIn");
    expect(errs({ note: "x".repeat(1001) })).toHaveProperty("note");
    expect(errs({ note: "kötü\u0007" })).toHaveProperty("note");
    expect(errs({ website: "spam" })).toHaveProperty("website");
  });
});

describe("kişi sayısı", () => {
  it("varsayılan 2, kapasiteyle sınırlı; sıkıştırma 1 … kapasite", () => {
    expect(defaultGuests(8)).toBe(2);
    expect(defaultGuests(1)).toBe(1);
    expect(clampGuests(0, 6)).toBe(1);
    expect(clampGuests(9, 6)).toBe(6);
    expect(clampGuests(3, 6)).toBe(3);
  });
});

describe("kaynak ve talep numarası", () => {
  it("'web' yalnız sistemde; elle eklemede seçenek değil", () => {
    expect(RESERVATION_SOURCES).toContain("web");
    expect(MANUAL_RESERVATION_SOURCES).not.toContain("web");
    expect(RESERVATION_SOURCE_LABELS.web).toBe("Web sitesi talebi");
  });

  it("talep numarası UUID'nin rastgele son 8 hanesi", () => {
    expect(requestReference("0190a1b2-c3d4-7e5f-8a9b-0c1d3fa9c21b")).toBe("TLP-3FA9C21B");
  });
});

const RATES: RatePeriod[] = [
  {
    id: "r1",
    startDate: "2027-07-01",
    endDate: "2027-08-01",
    nightlyAmountMinor: 500000,
    weeklyAmountMinor: 3000000,
    currency: "EUR",
    minNights: 3,
    cleaningFeeMinor: 20000,
    cleaningFeeFreeNights: 7,
  },
];
const W = { today: "2027-06-01", lastCheckIn: "2028-12-01", maxNights: 60 };

describe("fiyat (mevcut quoteStay) ve temizlik açıklaması", () => {
  it("4 gece: gecelik + temizlik ücreti; 7 gece ve üzeri ücretsiz notu", () => {
    const q = quoteStay("2027-07-10", "2027-07-14", RATES);
    expect(q.totalMinor).toBe(4 * 500000 + 20000);
    expect(cleaningNote(q, RATES)).toEqual({ kind: "charged", freeFromNights: 7 });
  });

  it("7 gece: haftalık fiyat; temizlik ücretsiz", () => {
    const q = quoteStay("2027-07-10", "2027-07-17", RATES);
    expect(q.totalMinor).toBe(3000000);
    expect(cleaningNote(q, RATES)).toEqual({ kind: "free", freeFromNights: 7 });
  });

  it("minimum gece karşılanmazsa toplam yok", () => {
    const e = evaluateStay({ checkIn: "2027-07-10", checkOut: "2027-07-12" }, [], W, RATES);
    expect(e).toMatchObject({ state: "min-nights", required: 3 });
  });

  it("WhatsApp mesajı: tarih, gece, kişi ve toplam; fiyat yoksa tutar yok", () => {
    const e = evaluateStay({ checkIn: "2027-07-10", checkOut: "2027-07-14" }, [], W, RATES);
    const t = stayWhatsappText({
      villaName: "Villa Defne",
      pageUrl: null,
      evaluation: e,
      guests: 3,
    });
    expect(t).toContain("4 gece, 3 kişi");
    expect(t).toMatch(/20\.200,00/);
    const u = evaluateStay({ checkIn: "2027-09-10", checkOut: "2027-09-14" }, [], W, RATES);
    const t2 = stayWhatsappText({
      villaName: "Villa Defne",
      pageUrl: null,
      evaluation: u,
      guests: 3,
    });
    expect(t2).toContain("4 gece, 3 kişi");
    expect(t2).not.toMatch(/€|tutar/);
  });
});

describe("bildirim e-postası", () => {
  it("misafir bilgisi ve tutar içermez; talep no ve panel bağlantısı içerir; HTML kaçışlı", () => {
    const m = reservationRequestEmail({
      brand: "Kiralığım",
      villaName: "Villa <Defne>",
      checkIn: "2027-07-10",
      checkOut: "2027-07-14",
      guests: 3,
      reference: "TLP-3FA9C21B",
      url: "https://app.example/rezervasyonlar/abc",
    });
    expect(m.subject).toContain("yeni rezervasyon talebi");
    expect(m.text).toContain("TLP-3FA9C21B");
    expect(m.text).toContain("https://app.example/rezervasyonlar/abc");
    expect(m.text).toContain("4 gece, 3 kişi");
    expect(m.html).toContain("Villa &lt;Defne&gt;");
    expect(m.html).not.toContain("<Defne>");
  });
});

describe("süreç içi hız sınırı", () => {
  it("pencerede sınır, pencere sonunda sıfırlanır; anahtarlar ayrı", () => {
    const rl = createMemoryRateLimit({ limit: 2, windowMs: 1000 });
    expect(rl.take("a", 0)).toBe(true);
    expect(rl.take("a", 10)).toBe(true);
    expect(rl.take("a", 20)).toBe(false);
    expect(rl.take("b", 20)).toBe(true);
    expect(rl.take("a", 1001)).toBe(true);
  });

  it("hata metinleri teknik ayrıntı içermez", () => {
    for (const m of Object.values(REQUEST_ERROR_MESSAGES)) {
      expect(m).not.toMatch(/sql|postgres|constraint|exception|23P01|stack/i);
    }
  });
});
