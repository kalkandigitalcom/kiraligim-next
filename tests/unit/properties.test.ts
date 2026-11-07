import { describe, expect, it } from "vitest";

import { mapLink, PROPERTY_TYPE_LABELS, PROPERTY_TYPES } from "@/lib/property-meta";
import { TR_PROVINCES, TR_PROVINCES_SORTED } from "@/lib/tr-provinces";
import { propertyFormValues, propertyInput } from "@/server/properties/schema";

const base = {
  name: "  Deniz Villa  ",
  propertyType: "villa",
  description: "",
  maxGuests: "6",
  bedrooms: "3",
  bathrooms: "2",
  bedsDouble: "",
  bedsSingle: "2",
  bedsSofa: "",
  province: "Antalya",
  district: "Kaş",
  neighborhood: "",
  addressLine: "",
  postalCode: "",
  latitude: "",
  longitude: "",
};

const errorsOf = (input: Record<string, unknown>) => {
  const r = propertyInput.safeParse(input);
  return r.success ? {} : Object.fromEntries(r.error.issues.map((i) => [i.path[0], i.message]));
};

describe("propertyInput", () => {
  it("form metinlerini dönüştürür: boşluk kırpma, sayılar, boş isteğe bağlılar, yatak varsayılanı 0", () => {
    const r = propertyInput.parse(base);
    expect(r).toEqual({
      name: "Deniz Villa",
      propertyType: "villa",
      description: undefined,
      maxGuests: 6,
      bedrooms: 3,
      bathrooms: 2,
      bedsDouble: 0,
      bedsSingle: 2,
      bedsSofa: 0,
      province: "Antalya",
      district: "Kaş",
      neighborhood: undefined,
      addressLine: undefined,
      postalCode: undefined,
      latitude: undefined,
      longitude: undefined,
    });
  });

  it("koordinat: virgül kabul edilir, 6 ondalığa yuvarlanır, aralık denetlenir", () => {
    const r = propertyInput.parse({ ...base, latitude: "36,2651234", longitude: "29.4143" });
    expect(r.latitude).toBe(36.265123);
    expect(r.longitude).toBe(29.4143);
    expect(errorsOf({ ...base, latitude: "91", longitude: "0" })).toHaveProperty("latitude");
    expect(errorsOf({ ...base, latitude: "0", longitude: "-181" })).toHaveProperty("longitude");
    expect(errorsOf({ ...base, latitude: "abc", longitude: "1" })).toHaveProperty("latitude");
  });

  it("enlem ve boylam birlikte girilmeli", () => {
    expect(errorsOf({ ...base, latitude: "36.2" })).toEqual({
      longitude: "Enlem ve boylam birlikte girilmeli.",
    });
    expect(errorsOf({ ...base, longitude: "29.4" })).toEqual({
      latitude: "Enlem ve boylam birlikte girilmeli.",
    });
  });

  it("sınırlar: veritabanı kısıtlarıyla aynı", () => {
    expect(errorsOf({ ...base, maxGuests: "0" })).toHaveProperty("maxGuests");
    expect(errorsOf({ ...base, maxGuests: "51" })).toHaveProperty("maxGuests");
    expect(errorsOf({ ...base, maxGuests: "2.5" })).toHaveProperty("maxGuests");
    expect(errorsOf({ ...base, bedrooms: "-1" })).toHaveProperty("bedrooms");
    expect(errorsOf({ ...base, bedsSofa: "51" })).toHaveProperty("bedsSofa");
    expect(errorsOf({ ...base, name: "A" })).toHaveProperty("name");
    expect(errorsOf({ ...base, name: "x".repeat(121) })).toHaveProperty("name");
    expect(errorsOf({ ...base, description: "x".repeat(5001) })).toHaveProperty("description");
    expect(errorsOf({ ...base, postalCode: "0796" })).toHaveProperty("postalCode");
    expect(errorsOf({ ...base, postalCode: "07960" })).toEqual({});
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

  it("Haritada aç bağlantısı OpenStreetMap, 6 ondalık", () => {
    expect(mapLink(36.2651, 29.4143)).toBe(
      "https://www.openstreetmap.org/?mlat=36.265100&mlon=29.414300#map=16/36.265100/29.414300",
    );
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
