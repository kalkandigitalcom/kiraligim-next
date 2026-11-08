import { describe, expect, it } from "vitest";

import { plainTextToHtml } from "@/lib/rich-text";
import { pickPropertyFields, propertyToRaw } from "@/server/properties/property-fields";
import {
  publicProfileInput,
  publicSlugFormValues,
  publicSlugInput,
  stayDetailsFormValues,
  stayDetailsInput,
} from "@/server/properties/public-profile-schema";
import { PROPERTY_FIELDS, propertyInput } from "@/server/properties/schema";
import type { Property } from "@/server/properties/service";

/** Aşama 2: ayrık şemalar, form çözümleme ve kayıt → form çevirisi (saf). */

describe("ayrık şemalar aynı kuralları kullanır", () => {
  it("olanak ve konaklama: sıralama, boş → null, hatalar", () => {
    const ok = stayDetailsInput.parse({
      amenities: ["otopark", "wifi", "wifi"],
      checkInTime: "16:00",
      checkOutTime: "",
      houseRules: "  Kural.\r\nİkinci satır.  ",
      // Revizyon 2: kaldırılan alanlar gelse de yok sayılır.
      cancellationPolicy: "Eski iptal metni",
      paymentTerms: "Eski ödeme metni",
    });
    expect(ok).toEqual({
      amenities: ["wifi", "otopark"],
      checkInTime: "16:00",
      checkOutTime: null,
      houseRules: "Kural.\nİkinci satır.",
    });
    const bad = stayDetailsInput.safeParse({ amenities: ["yok"], checkInTime: "7:00" });
    expect(bad.success).toBe(false);
    expect(bad.error!.issues.map((i) => i.path.join(".")).sort()).toEqual([
      "amenities",
      "checkInTime",
    ]);
  });

  it("sayfa adresi: küçük harfe çevrilir; boş → null; geçersiz reddedilir; onay kutusu", () => {
    expect(publicSlugInput.parse({ publicSlug: " Villa-Defne ", confirmSlugChange: "on" })).toEqual(
      {
        publicSlug: "villa-defne",
        confirmSlugChange: true,
      },
    );
    expect(publicSlugInput.parse({ publicSlug: "", confirmSlugChange: false })).toEqual({
      publicSlug: null,
      confirmSlugChange: false,
    });
    for (const s of ["a--b", "admin", "-x-"]) {
      expect(publicSlugInput.safeParse({ publicSlug: s }).success, s).toBe(false);
    }
  });

  it("birleşik şema (uyumluluk) iki parçanın birleşimiyle aynı sonucu verir", () => {
    const input = {
      publicSlug: "deniz-villa",
      amenities: ["wifi"],
      checkInTime: "15:00",
      checkOutTime: "11:00",
      houseRules: "Kural",
      cancellationPolicy: "",
      paymentTerms: "Ödeme",
      confirmSlugChange: "on",
    };
    expect(publicProfileInput.parse(input)).toEqual({
      ...publicSlugInput.parse(input),
      ...stayDetailsInput.parse(input),
    });
  });

  it("form çözümleme: her form yalnız kendi alanlarını okur", () => {
    const fd = new FormData();
    fd.append("publicSlug", "x-villa");
    fd.append("amenities", "wifi");
    fd.append("amenities", "klima");
    fd.append("checkInTime", "16:00");
    fd.append("houseRules", "K");
    expect(stayDetailsFormValues(fd)).toEqual({
      amenities: ["wifi", "klima"],
      houseRuleKeys: [],
      priceIncludes: [],
      checkInTime: "16:00",
      checkOutTime: "",
      houseRules: "K",
    });
    expect(publicSlugFormValues(fd)).toEqual({ publicSlug: "x-villa", confirmSlugChange: false });
  });
});

describe("kayıt → form değerleri (parça kayıt için)", () => {
  const base: Property = {
    id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
    name: "Defne",
    propertyType: "villa",
    status: "active",
    maxGuests: 8,
    bedrooms: 4,
    bathrooms: 3,
    province: "Antalya",
    district: "Kaş",
    description: "Eski metin.\nİkinci satır.",
    descriptionHtml: plainTextToHtml("Eski metin.\nİkinci satır."),
    tourismLicenseNo: null,
    youtubeVideoIds: ["aBcDeFgHiJ0"],
    pools: {
      swimming: { present: true, depth: 1.5, width: 4, length: 9.25 },
      indoor: { present: false, depth: null, width: null, length: null },
      kids: { present: false, depth: null, width: null, length: null },
      swimmingProtected: true,
    },
    countryCode: "TR",
    neighborhood: null,
    mapMode: null,
    mapEmbedUrl: "https://www.google.com/maps?q=36.500000,29.123456&z=16&output=embed",
    mapPin: { lat: 36.2655, lng: 29.414712 },
    distanceUnits: {
      distanceMarketKm: null,
      distanceRestaurantKm: null,
      distanceCenterKm: "km",
      distanceBeachKm: null,
      distanceAirportAytKm: null,
      distanceAirportDlmKm: "km",
      distanceHealthKm: null,
    },
    distances: {
      distanceMarketKm: 0.4,
      distanceRestaurantKm: null,
      distanceCenterKm: 2.5,
      distanceBeachKm: null,
      distanceAirportAytKm: 190,
      distanceAirportDlmKm: 112.25,
      distanceHealthKm: null,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Property;

  it("tüm form alanları üretilir; eski açıklama HTML'e çevrilmiş hâliyle; ölçek korunur", () => {
    const raw = propertyToRaw(base);
    expect(Object.keys(raw).sort()).toEqual([...PROPERTY_FIELDS].sort());
    expect(raw).toMatchObject({
      description: "<p>Eski metin.<br />İkinci satır.</p>",
      // Eski kayıt (yöntem NULL, Google adresi var) → Google; iğne de forma gelir (korunur).
      mapMode: "google",
      mapLocation: "https://www.google.com/maps?q=36.500000,29.123456&z=16&output=embed",
      mapPinLat: "36.2655",
      mapPinLng: "29.414712",
      // Eski kayıt (birim NULL): 1 km altı metre, üstü km (önceki gösterimle aynı).
      distanceMarketKm: "400",
      distanceMarketUnit: "m",
      distanceCenterKm: "2,5",
      distanceCenterUnit: "km",
      distanceAirportAytKm: "190",
      distanceAirportAytUnit: "km",
      distanceAirportDlmKm: "112,25",
      distanceBeachKm: "",
      distanceBeachUnit: "km",
      poolSwimming: "yes",
      poolSwimmingDepth: "1,50",
      poolSwimmingLength: "9,25",
      poolSwimmingProtected: "yes",
      poolIndoor: "no",
      poolIndoorDepth: "",
      neighborhood: "",
      youtubeUrl: "https://www.youtube.com/watch?v=aBcDeFgHiJ0",
    });
  });

  it("kayıt → form → doğrulama gidiş-dönüşü değer değiştirmez (harita, mesafeler)", () => {
    const parsed = propertyInput.parse(propertyToRaw(base));
    expect(parsed.map).toEqual({ mode: "google", embedUrl: base.mapEmbedUrl, pin: base.mapPin });
    expect(parsed.distances.km).toEqual(base.distances);
    // Kayıtlı birim korunur; eski kaydın birimi otomatik birimle açıkça yazılır.
    expect(parsed.distances.unit).toMatchObject({
      distanceMarketKm: "m",
      distanceCenterKm: "km",
      distanceAirportAytKm: "km",
      distanceBeachKm: null,
    });
    // İğne yöntemi seçili kayıt da gidiş-dönüşte aynı kalır.
    const pinRec = { ...base, mapMode: "pin" as const, mapEmbedUrl: null };
    expect(propertyInput.parse(propertyToRaw(pinRec)).map).toEqual({
      mode: "pin",
      embedUrl: null,
      pin: base.mapPin,
    });
    // Metre birimli kayıt 1 m hassasiyetle döner.
    const mRec = {
      ...base,
      distances: { ...base.distances, distanceHealthKm: 1.255 },
      distanceUnits: { ...base.distanceUnits, distanceHealthKm: "m" as const },
    };
    const mRaw = propertyToRaw(mRec);
    expect(mRaw.distanceHealthKm).toBe("1255");
    expect(propertyInput.parse(mRaw).distances.km.distanceHealthKm).toBe(1.255);
  });

  it("parça seçici yalnız bilinen metin alanlarını alır (eski alanlar dahil değil)", () => {
    expect(
      pickPropertyFields({
        name: "Yeni",
        maxGuests: 5,
        is_public: true,
        publicSlug: "x",
        youtubeUrl: "https://youtu.be/dQw4w9WgXcQ",
        youtubeUrls: ["a"],
        latitude: "36.1",
        bedsDouble: "2",
      }),
    ).toEqual({ name: "Yeni", youtubeUrl: "https://youtu.be/dQw4w9WgXcQ" });
    expect(pickPropertyFields(null)).toEqual({});
  });
});
