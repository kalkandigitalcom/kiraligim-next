import { describe, expect, it } from "vitest";

import { PROPERTY_TYPE_LABELS, PROPERTY_TYPES } from "@/lib/property-meta";
import { TR_PROVINCES, TR_PROVINCES_SORTED } from "@/lib/tr-provinces";
import { propertyFormValues, propertyInput } from "@/server/properties/schema";

const base = {
  name: "  Deniz Villa  ",
  propertyType: "villa",
  description: "",
  maxGuests: "6",
  bedrooms: "3",
  bathrooms: "2",
  province: "Antalya",
  district: "Kaş",
  neighborhood: "",
  mapLocation: "",
  distanceMarketKm: "",
};

const errorsOf = (input: Record<string, unknown>) => {
  const r = propertyInput.safeParse(input);
  return r.success ? {} : Object.fromEntries(r.error.issues.map((i) => [i.path[0], i.message]));
};

const NO_DISTANCES = {
  distanceMarketKm: null,
  distanceRestaurantKm: null,
  distanceCenterKm: null,
  distanceBeachKm: null,
  distanceAirportAytKm: null,
  distanceAirportDlmKm: null,
  distanceHealthKm: null,
};

describe("propertyInput", () => {
  it("form metinlerini dönüştürür: boşluk kırpma, sayılar, boş isteğe bağlılar", () => {
    const r = propertyInput.parse(base);
    expect(r).toEqual({
      name: "Deniz Villa",
      propertyType: "villa",
      description: undefined,
      maxGuests: 6,
      bedrooms: 3,
      bathrooms: 2,
      province: "Antalya",
      district: "Kaş",
      neighborhood: undefined,
      mapLocation: null,
      ...NO_DISTANCES,
      youtubeUrl: [],
    });
  });

  it("eski alanlar (yatak, açık adres, posta kodu, koordinat) artık okunmaz", () => {
    const r = propertyInput.parse({
      ...base,
      bedsDouble: "3",
      addressLine: "Gizli adres",
      postalCode: "07960",
      latitude: "36.2",
      longitude: "29.4",
    });
    for (const k of ["bedsDouble", "addressLine", "postalCode", "latitude", "longitude"]) {
      expect(r, k).not.toHaveProperty(k);
    }
  });

  it("mesafeler: virgül/nokta, en fazla 2 ondalık, 0'dan büyük, en fazla 9999,99", () => {
    const r = propertyInput.parse({
      ...base,
      distanceMarketKm: "0,4",
      distanceAirportDlmKm: "112.25",
      distanceBeachKm: " 2 ",
    });
    expect(r).toMatchObject({
      distanceMarketKm: 0.4,
      distanceAirportDlmKm: 112.25,
      distanceBeachKm: 2,
    });
    for (const bad of ["0", "-1", "1,234", "abc", "10000", "1e3", "2 km"]) {
      expect(errorsOf({ ...base, distanceCenterKm: bad }), bad).toHaveProperty("distanceCenterKm");
    }
    expect(errorsOf({ ...base, distanceCenterKm: "9999,99" })).toEqual({});
  });

  it("harita: iframe kodundan güvenli adres; kısa bağlantı ve başka site anlaşılır hata", () => {
    const iframe =
      '<iframe src="https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3200!2d29.41!3d36.26!2m3!1f0!2f0!3f0" width="600" height="450" style="border:0;" allowfullscreen="" loading="lazy"></iframe>';
    expect(propertyInput.parse({ ...base, mapLocation: iframe }).mapLocation).toBe(
      "https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3200!2d29.41!3d36.26!2m3!1f0!2f0!3f0",
    );
    expect(
      errorsOf({ ...base, mapLocation: "https://maps.app.goo.gl/abc123" }).mapLocation,
    ).toMatch(/Kısa paylaşım bağlantıları desteklenmiyor/);
    expect(
      errorsOf({ ...base, mapLocation: "https://evil.example/maps/embed?pb=!1" }),
    ).toHaveProperty("mapLocation");
  });

  it("YouTube: tek bağlantı; boş → video yok; geçersiz → hata", () => {
    expect(
      propertyInput.parse({ ...base, youtubeUrl: "https://youtu.be/dQw4w9WgXcQ" }).youtubeUrl,
    ).toEqual(["dQw4w9WgXcQ"]);
    expect(propertyInput.parse({ ...base, youtubeUrl: "  " }).youtubeUrl).toEqual([]);
    expect(errorsOf({ ...base, youtubeUrl: "https://vimeo.com/1" })).toEqual({
      youtubeUrl: "Geçerli bir YouTube video bağlantısı girin.",
    });
  });

  it("sınırlar: veritabanı kısıtlarıyla aynı", () => {
    expect(errorsOf({ ...base, maxGuests: "0" })).toHaveProperty("maxGuests");
    expect(errorsOf({ ...base, maxGuests: "51" })).toHaveProperty("maxGuests");
    expect(errorsOf({ ...base, maxGuests: "2.5" })).toHaveProperty("maxGuests");
    expect(errorsOf({ ...base, bedrooms: "-1" })).toHaveProperty("bedrooms");
    expect(errorsOf({ ...base, name: "A" })).toHaveProperty("name");
    expect(errorsOf({ ...base, name: "x".repeat(121) })).toHaveProperty("name");
    expect(errorsOf({ ...base, description: "x".repeat(5001) })).toHaveProperty("description");
  });

  it("mülk türü ve il yalnız listeden", () => {
    expect(errorsOf({ ...base, propertyType: "otel" })).toHaveProperty("propertyType");
    expect(errorsOf({ ...base, province: "Atlantis" })).toHaveProperty("province");
    for (const t of PROPERTY_TYPES) expect(errorsOf({ ...base, propertyType: t })).toEqual({});
  });

  it("propertyFormValues yalnız bilinen alanları alır", () => {
    const fd = new FormData();
    fd.set("name", "Ev");
    fd.set("workspaceId", "başka-işletme");
    fd.set("createdBy", "başkası");
    const v = propertyFormValues(fd);
    expect(v.name).toBe("Ev");
    expect(v).not.toHaveProperty("workspaceId");
    expect(v).not.toHaveProperty("createdBy");
    expect(v.province).toBe("");
  });
});

describe("sabitler", () => {
  it("81 il, tekrarsız; alfabetik liste aynı elemanları içerir", () => {
    expect(TR_PROVINCES).toHaveLength(81);
    expect(new Set(TR_PROVINCES).size).toBe(81);
    expect([...TR_PROVINCES_SORTED].sort()).toEqual([...TR_PROVINCES].sort());
    expect(TR_PROVINCES_SORTED[0]).toBe("Adana");
  });

  it("türler: Villa, Apart, Bungalow, Ev", () => {
    expect(PROPERTY_TYPES.map((t) => PROPERTY_TYPE_LABELS[t])).toEqual([
      "Villa",
      "Apart",
      "Bungalow",
      "Ev",
    ]);
  });
});

describe("hata mesajları", () => {
  it("boş zorunlu alan 'gerekli', sayı olmayan 'bir sayı olmalı', kısa metin 'en az'", () => {
    const e = errorsOf({ ...base, maxGuests: "", bedrooms: "abc", district: "", name: "A" });
    expect(e).toMatchObject({
      maxGuests: "Kişi kapasitesi gerekli.",
      bedrooms: "Yatak odası sayısı bir sayı olmalı.",
      district: "İlçe gerekli.",
      name: "Mülk adı en az 2 karakter olmalı.",
    });
    expect(errorsOf({ ...base, province: "" })).toEqual({ province: "İl seçin." });
  });
});
