import { describe, expect, it } from "vitest";

import type { RatePeriod } from "@/lib/rate-meta";
import {
  amenityGroups,
  coverFirst,
  locationLabel,
  metaDescription,
  propertyTypeLabel,
  rateRows,
  startingNightly,
  whatsappHref,
} from "@/lib/public-villa-view";

/** F2b: villa sayfası gösterim yardımcıları (saf). */

const rate = (o: Partial<RatePeriod> & Pick<RatePeriod, "id" | "startDate" | "endDate">) =>
  ({
    nightlyAmountMinor: 650000,
    weeklyAmountMinor: null,
    currency: "TRY",
    minNights: 3,
    cleaningFeeMinor: null,
    cleaningFeeFreeNights: null,
    ...o,
  }) as RatePeriod;

describe("villa sayfası gösterimi", () => {
  it("konum yalnız mahalle, ilçe ve il; tür etiketi", () => {
    expect(locationLabel({ province: "Antalya", district: "Kaş", neighborhood: "Kalkan" })).toBe(
      "Kalkan, Kaş / Antalya",
    );
    expect(locationLabel({ province: "Muğla", district: "Fethiye", neighborhood: null })).toBe(
      "Fethiye / Muğla",
    );
    expect(propertyTypeLabel("apart")).toBe("Apart");
    expect(propertyTypeLabel("bilinmeyen")).toBe("Villa");
  });

  it("olanaklar katalog grup sırasıyla; boş grup ve katalog dışı anahtar yok", () => {
    const g = amenityGroups(["otopark", "wifi", "bilinmeyen", "klima", "wifi"]);
    // Revizyon 2: "Genel" yok; klima İklimlendirme'de, Wi-Fi İnternet ve eğlence'de.
    expect(g.map((x) => x.key)).toEqual(["konfor", "eglence", "dis-alan"]);
    expect(g[0]!.items.map((i) => i.key)).toEqual(["klima"]);
    expect(g[1]!.items.map((i) => i.key)).toEqual(["wifi"]);
    expect(g[2]!.items).toEqual([{ key: "otopark", label: "Otopark" }]);
    expect(amenityGroups([])).toEqual([]);
  });

  it("başlangıç fiyatı: sayfanın para biriminde en düşük gecelik; fiyatsız dönem atlanır", () => {
    const rates = [
      rate({
        id: "d1",
        startDate: "2027-06-01",
        endDate: "2027-07-01",
        nightlyAmountMinor: 850000,
      }),
      rate({ id: "d2", startDate: "2027-07-01", endDate: "2027-08-01", nightlyAmountMinor: null }),
      rate({
        id: "d3",
        startDate: "2027-08-01",
        endDate: "2027-09-01",
        nightlyAmountMinor: 600000,
      }),
      rate({
        id: "d4",
        startDate: "2027-09-01",
        endDate: "2027-10-01",
        nightlyAmountMinor: 1000,
        currency: "EUR",
      }),
    ];
    expect(startingNightly(rates, "TRY")).toBe(600000);
    expect(startingNightly(rates, "EUR")).toBe(1000);
    expect(startingNightly([], "TRY")).toBeNull();
    expect(startingNightly(rates, null)).toBeNull();
  });

  it("sezon tablosu: geçmiş dönem yok, bugünü kapsayan dönem bugünden başlar", () => {
    const rows = rateRows(
      [
        rate({ id: "d1", startDate: "2026-10-01", endDate: "2026-11-01" }),
        rate({
          id: "d2",
          startDate: "2026-11-01",
          endDate: "2026-12-01",
          weeklyAmountMinor: 4200000,
          cleaningFeeMinor: 250000,
          cleaningFeeFreeNights: 7,
        }),
        rate({
          id: "d3",
          startDate: "2026-12-01",
          endDate: "2027-01-01",
          nightlyAmountMinor: null,
        }),
      ],
      "2026-11-08",
    );
    expect(rows.map((r) => [r.id, r.startDate, r.endDate])).toEqual([
      ["d2", "2026-11-08", "2026-12-01"],
      ["d3", "2026-12-01", "2027-01-01"],
    ]);
    expect(rows[0]).toMatchObject({
      nightly: "₺6.500,00",
      weekly: "₺42.000,00",
      minNights: 3,
      cleaning: "₺2.500,00",
      cleaningFreeFrom: 7,
    });
    expect(rows[1]).toMatchObject({ nightly: null, cleaning: null, cleaningFreeFrom: null });
  });

  it("WhatsApp bağlantısı: yalnız villa adı ve sayfa adresi; misafir bilgisi yok", () => {
    const href = whatsappHref("+905321234567", "Villa Defne", "https://kiraligim.com/villa/defne");
    const u = new URL(href);
    expect(u.origin + u.pathname).toBe("https://wa.me/905321234567");
    expect(u.searchParams.get("text")).toBe(
      "Merhaba, Villa Defne hakkında bilgi almak istiyorum. https://kiraligim.com/villa/defne",
    );
    expect([...u.searchParams.keys()]).toEqual(["text"]);
  });

  it("meta açıklama: kelime sınırında kısaltılır; açıklama yoksa özet", () => {
    const base = {
      name: "Villa Defne",
      propertyType: "villa",
      location: { province: "Antalya", district: "Kaş", neighborhood: "Kalkan" },
      maxGuests: 8,
      bedrooms: 4,
    };
    expect(metaDescription({ ...base, descriptionText: null })).toBe(
      "Kalkan, Kaş / Antalya · Villa, 8 kişilik, 4 yatak odası.",
    );
    expect(metaDescription({ ...base, descriptionText: "  Kısa   açıklama. " })).toBe(
      "Kısa açıklama.",
    );
    const long = "Denize yakın, özel havuzlu ve bahçeli villa. ".repeat(10);
    const m = metaDescription({ ...base, descriptionText: long });
    expect(m.length).toBeLessThanOrEqual(160);
    expect(m.endsWith("…")).toBe(true);
    expect(m).not.toMatch(/\s…$/);
  });

  it("kapak fotoğrafı öne alınır, diğer sıra korunur", () => {
    const p = (id: string, isCover = false) => ({ id, isCover });
    expect(coverFirst([p("a"), p("b", true), p("c")]).map((x) => x.id)).toEqual(["b", "a", "c"]);
    expect(coverFirst([p("a", true), p("b")]).map((x) => x.id)).toEqual(["a", "b"]);
    expect(coverFirst([p("a"), p("b")]).map((x) => x.id)).toEqual(["a", "b"]);
  });
});
