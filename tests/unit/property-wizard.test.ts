import { describe, expect, it } from "vitest";

import {
  BASICS_FIELDS,
  EMPTY_PROPERTY_VALUES,
  nextStep,
  parseWizardStep,
  prevStep,
  STEP_PROPERTY_FIELDS,
  STEP_STAY_FIELDS,
  stepHref,
  stepOfField,
  WIZARD_STEP_LABELS,
  WIZARD_STEPS,
  wizardFormValues,
} from "@/lib/property-wizard";
import { DISTANCE_KEYS, DISTANCE_UNIT_FIELDS } from "@/lib/villa-extras";
import { STAY_LIST_FIELDS, STAY_TEXT_FIELDS } from "@/server/properties/public-profile-schema";
import { PROPERTY_FIELDS } from "@/server/properties/schema";

/** Aşama 3: sihirbaz adımları ve adım alanları (saf). */

const EDIT = ["temel", "aciklama", "olanaklar", "konaklama"] as const;

describe("adımlar", () => {
  it("beş adım, sırayla; geçersiz/boş parametre → kontrol", () => {
    expect(WIZARD_STEPS).toEqual(["temel", "aciklama", "olanaklar", "konaklama", "kontrol"]);
    expect(Object.keys(WIZARD_STEP_LABELS)).toEqual([...WIZARD_STEPS]);
    expect(parseWizardStep(undefined)).toBe("kontrol");
    expect(parseWizardStep("")).toBe("kontrol");
    expect(parseWizardStep("fotograflar")).toBe("kontrol");
    expect(parseWizardStep(["olanaklar", "temel"])).toBe("olanaklar");
    expect(parseWizardStep("aciklama")).toBe("aciklama");
  });

  it("önceki / sonraki ve adres", () => {
    expect(prevStep("temel")).toBeNull();
    expect(nextStep("temel")).toBe("aciklama");
    expect(prevStep("kontrol")).toBe("konaklama");
    expect(nextStep("kontrol")).toBeNull();
    expect(stepHref("abc", "olanaklar")).toBe("/villalar/abc?adim=olanaklar");
  });
});

describe("adım alanları", () => {
  it("mülk alanlarının her biri tam olarak bir adımda", () => {
    const all = EDIT.flatMap((s) => STEP_PROPERTY_FIELDS[s]);
    expect([...all].sort()).toEqual([...PROPERTY_FIELDS].sort());
    expect(new Set(all).size).toBe(all.length);
  });

  it("olanak/konaklama alanlarının her biri tam olarak bir adımda", () => {
    const all = EDIT.flatMap((s) => STEP_STAY_FIELDS[s]);
    expect([...all].sort()).toEqual([...STAY_LIST_FIELDS, ...STAY_TEXT_FIELDS].sort());
  });

  it("harita ve mesafeler 1. adımda, video 2. adımda; eski gizli alanlar hiçbir adımda yok", () => {
    for (const k of [
      "mapMode",
      "mapLocation",
      "mapPinLat",
      "mapPinLng",
      ...DISTANCE_KEYS,
      ...DISTANCE_UNIT_FIELDS,
    ])
      expect(BASICS_FIELDS).toContain(k);
    expect(STEP_STAY_FIELDS.konaklama).toEqual([
      "checkInTime",
      "checkOutTime",
      "houseRuleKeys",
      "houseRules",
      "priceIncludes",
    ]);
    expect(STEP_PROPERTY_FIELDS.aciklama).toEqual(["description", "youtubeUrl"]);
    const all = Object.values(STEP_PROPERTY_FIELDS).flat();
    for (const k of ["addressLine", "postalCode", "latitude", "longitude", "bedsDouble"]) {
      expect(all, k).not.toContain(k);
    }
    expect(Object.keys(EMPTY_PROPERTY_VALUES).sort()).toEqual([...PROPERTY_FIELDS].sort());
    expect(EMPTY_PROPERTY_VALUES).toMatchObject({
      poolSwimming: "no",
      description: "",
      mapMode: "google",
      distanceMarketUnit: "km",
    });
  });

  it("hata alanı → adım", () => {
    expect(stepOfField("name")).toBe("temel");
    expect(stepOfField("latitude")).toBeNull(); // kaldırılan alan
    expect(stepOfField("youtubeUrl")).toBe("aciklama");
    expect(stepOfField("mapLocation")).toBe("temel");
    expect(stepOfField("distanceBeachKm")).toBe("temel");
    expect(stepOfField("houseRuleKeys")).toBe("konaklama");
    expect(stepOfField("priceIncludes")).toBe("konaklama");
    expect(stepOfField("description")).toBe("aciklama");
    expect(stepOfField("poolKidsDepth")).toBe("olanaklar");
    expect(stepOfField("amenities")).toBe("olanaklar");
    // Revizyon 2: iptal / ödeme koşulları kaldırıldı.
    expect(stepOfField("paymentTerms")).toBeNull();
    expect(stepOfField("cancellationPolicy")).toBeNull();
    expect(stepOfField("mapMode")).toBe("temel");
    expect(stepOfField("mapPinLat")).toBe("temel");
    expect(stepOfField("distanceMarketUnit")).toBe("temel");
    expect(stepOfField("publicSlug")).toBeNull();
  });
});

describe("form çözümleme: her adım yalnız kendi alanlarını okur", () => {
  const fd = () => {
    const f = new FormData();
    f.append("name", "Villa");
    f.append("description", "<p>x</p>");
    f.append("youtubeUrl", "https://youtu.be/aBcDeFgHiJ0");
    f.append("houseRuleKeys", "sigara-icilmez");
    f.append("houseRuleKeys", "parti-yok");
    f.append("priceIncludes", "elektrik");
    f.append("poolSwimming", "yes");
    f.append("amenities", "wifi");
    f.append("amenities", "klima");
    f.append("houseRules", "Kural");
    return f;
  };

  it("temel: yalnız 1. adım alanları; formda olmayanlar boş metin", () => {
    const v = wizardFormValues("temel", fd());
    expect(Object.keys(v).sort()).toEqual([...BASICS_FIELDS].sort());
    expect(v.name).toBe("Villa");
    expect(v.district).toBe("");
  });

  it("açıklama: açıklama + video listesi", () => {
    expect(wizardFormValues("aciklama", fd())).toEqual({
      description: "<p>x</p>",
      youtubeUrl: "https://youtu.be/aBcDeFgHiJ0",
    });
  });

  it("olanaklar: havuz alanları + olanak listesi (hiç seçilmezse boş liste)", () => {
    const v = wizardFormValues("olanaklar", fd());
    expect(v.amenities).toEqual(["wifi", "klima"]);
    expect(v.poolSwimming).toBe("yes");
    expect(v).not.toHaveProperty("name");
    expect(v).not.toHaveProperty("houseRules");
    expect(wizardFormValues("olanaklar", new FormData()).amenities).toEqual([]);
  });

  it("konaklama: yalnız saatler ve metinler; olanak listesi yok", () => {
    const v = wizardFormValues("konaklama", fd());
    expect(Object.keys(v).sort()).toEqual(
      [...STAY_TEXT_FIELDS, "houseRuleKeys", "priceIncludes"].sort(),
    );
    expect(v.houseRuleKeys).toEqual(["sigara-icilmez", "parti-yok"]);
    expect(v.priceIncludes).toEqual(["elektrik"]);
    expect(wizardFormValues("konaklama", new FormData()).houseRuleKeys).toEqual([]);
    expect(v.houseRules).toBe("Kural");
  });
});
