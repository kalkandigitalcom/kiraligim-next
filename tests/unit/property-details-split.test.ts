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
import { PROPERTY_FIELDS } from "@/server/properties/schema";
import type { Property } from "@/server/properties/service";

/** Aşama 2: ayrık şemalar, form çözümleme ve kayıt → form çevirisi (saf). */

describe("ayrık şemalar aynı kuralları kullanır", () => {
  it("olanak ve konaklama: sıralama, boş → null, hatalar", () => {
    const ok = stayDetailsInput.parse({
      amenities: ["otopark", "wifi", "wifi"],
      checkInTime: "16:00",
      checkOutTime: "",
      houseRules: "  Kural.\r\nİkinci satır.  ",
      cancellationPolicy: "",
      paymentTerms: undefined,
    });
    expect(ok).toEqual({
      amenities: ["wifi", "otopark"],
      checkInTime: "16:00",
      checkOutTime: null,
      houseRules: "Kural.\nİkinci satır.",
      cancellationPolicy: null,
      paymentTerms: null,
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
      checkInTime: "16:00",
      checkOutTime: "",
      houseRules: "K",
      cancellationPolicy: "",
      paymentTerms: "",
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
    bedsDouble: 2,
    bedsSingle: 1,
    bedsSofa: 0,
    countryCode: "TR",
    neighborhood: null,
    addressLine: null,
    postalCode: null,
    latitude: 36.5,
    longitude: 29.123456,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Property;

  it("tüm form alanları üretilir; eski açıklama HTML'e çevrilmiş hâliyle; ölçek korunur", () => {
    const raw = propertyToRaw(base);
    expect(Object.keys(raw).sort()).toEqual([...PROPERTY_FIELDS, "youtubeUrls"].sort());
    expect(raw).toMatchObject({
      description: "<p>Eski metin.<br />İkinci satır.</p>",
      latitude: "36.500000",
      longitude: "29.123456",
      poolSwimming: "yes",
      poolSwimmingDepth: "1,50",
      poolSwimmingLength: "9,25",
      poolSwimmingProtected: "yes",
      poolIndoor: "no",
      poolIndoorDepth: "",
      neighborhood: "",
      youtubeUrls: ["https://www.youtube.com/watch?v=aBcDeFgHiJ0"],
    });
  });

  it("parça seçici yalnız bilinen metin alanlarını ve video listesini alır", () => {
    expect(
      pickPropertyFields({
        name: "Yeni",
        maxGuests: 5,
        is_public: true,
        publicSlug: "x",
        youtubeUrls: ["a", 1],
      }),
    ).toEqual({ name: "Yeni", youtubeUrls: ["a"] });
    expect(pickPropertyFields(null)).toEqual({});
  });
});
