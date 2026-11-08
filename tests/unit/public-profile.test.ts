import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  AMENITY_GROUPS,
  AMENITY_KEY_PATTERN,
  AMENITY_KEYS,
  formatWhatsapp,
  normalizeWhatsapp,
  orderAmenities,
  pageVisibility,
  PUBLIC_SLUG_PATTERN,
  publicVillaUrl,
  RESERVED_PUBLIC_SLUGS,
  shareMessage,
  slugProblem,
  suggestPublicSlug,
  toHhMm,
  unmetRequirements,
  type VisibilityInput,
  WHATSAPP_PATTERN,
} from "@/lib/public-profile-meta";
import { validateAuditEntry } from "@/server/audit/record";
import {
  publicProfileFormValues,
  publicProfileInput,
  whatsappInput,
} from "@/server/properties/public-profile-schema";

const migration = readFileSync("drizzle/0022_property_public_profile.sql", "utf8");

describe("sayfa adresi (slug)", () => {
  it("biçim kuralları", () => {
    expect(slugProblem("villa-defne-kas")).toBeNull();
    expect(slugProblem("v1")).toBe("format");
    expect(slugProblem("a".repeat(61))).toBe("format");
    expect(slugProblem("a".repeat(60))).toBeNull();
    expect(slugProblem("-villa")).toBe("format");
    expect(slugProblem("villa-")).toBe("format");
    expect(slugProblem("Villa")).toBe("format");
    expect(slugProblem("villa defne")).toBe("format");
    expect(slugProblem("villa_defne")).toBe("format");
    expect(slugProblem("çamlık")).toBe("format");
    expect(slugProblem("villa--defne")).toBe("double_dash");
  });

  it("ayrılmış adresler reddedilir", () => {
    for (const w of ["admin", "api", "panel", "kvkk", "villa", "kullanim-kosullari"]) {
      expect(slugProblem(w)).toBe("reserved");
    }
  });

  it("veritabanı CHECK'i aynı biçim ve aynı ayrılmış listeyle yazılmış", () => {
    expect(migration).toContain(`'${PUBLIC_SLUG_PATTERN}'`);
    const list = /<> all \(array\[([^\]]+)\]\)/.exec(migration)![1]!;
    const words = list.split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
    expect(words).toEqual([...RESERVED_PUBLIC_SLUGS]);
    for (const w of RESERVED_PUBLIC_SLUGS) expect(w).toMatch(/^[a-z0-9-]+$/);
  });

  it("ad ve ilçeden öneri (Türkçe karakterler)", () => {
    expect(suggestPublicSlug("Villa Defne", "Kaş")).toBe("villa-defne-kas");
    expect(suggestPublicSlug("Çağlayan Şirin Ev", "Fethiye")).toBe("caglayan-sirin-ev-fethiye");
    expect(suggestPublicSlug("  Villa   ---  Su ", null)).toBe("villa-su");
    expect(suggestPublicSlug("Demo", null)).toBe("demo-villa");
    expect(suggestPublicSlug("Ev", null)).toBe("");
    const long = suggestPublicSlug("Çok uzun bir villa adı ".repeat(5), "Kaş");
    expect(slugProblem(long)).toBeNull();
  });

  it("müşteri adresi ve paylaşım metni", () => {
    const url = publicVillaUrl("https://kiraligim.com", "villa-defne-kas");
    expect(url).toBe("https://kiraligim.com/villa/villa-defne-kas");
    expect(shareMessage("Villa Defne", url)).toContain(url);
  });
});

describe("olanak kataloğu", () => {
  it("anahtarlar benzersiz, biçime uygun; etiketler dolu", () => {
    const re = new RegExp(AMENITY_KEY_PATTERN);
    expect(new Set(AMENITY_KEYS).size).toBe(AMENITY_KEYS.length);
    expect(AMENITY_KEYS).toHaveLength(35);
    for (const g of AMENITY_GROUPS)
      for (const [k, l] of g.items) {
        expect(k).toMatch(re);
        expect(l.length).toBeGreaterThan(1);
      }
  });

  it("Revizyon 2: 'Genel' kategorisi yok; anahtar kümesi değişmedi (kayıtlı olanaklar kaybolmaz)", () => {
    expect(AMENITY_GROUPS.map((g) => g.key)).toEqual([
      "konfor",
      "eglence",
      "mutfak",
      "banyo",
      "havuz",
      "dis-alan",
      "manzara",
      "aile",
      "guvenlik",
    ]);
    expect(AMENITY_GROUPS.map((g) => g.label as string)).not.toContain("Genel");
    for (const g of AMENITY_GROUPS) expect(g.items.length, g.key).toBeGreaterThan(0);
    // Revizyon öncesi 35 anahtarın tamamı (veritabanında saklanan değerler) katalogda kalır.
    const before = [
      "wifi",
      "klima",
      "isitma",
      "somine",
      "televizyon",
      "calisma-alani",
      "camasir-makinesi",
      "kurutma-makinesi",
      "utu",
      "sac-kurutma",
      "havlu-nevresim",
      "tam-mutfak",
      "bulasik-makinesi",
      "firin",
      "mikrodalga",
      "kahve-makinesi",
      "buzdolabi",
      "bahce",
      "teras",
      "barbeku",
      "sezlong",
      "dis-dus",
      "otopark",
      "jakuzi",
      "sauna",
      "deniz-manzarasi",
      "doga-manzarasi",
      "muhafazakar",
      "bebek-yatagi",
      "mama-sandalyesi",
      "evcil-hayvan",
      "guvenlik-kamerasi",
      "yangin-sondurucu",
      "ilk-yardim",
      "duman-dedektoru",
    ];
    expect([...AMENITY_KEYS].sort()).toEqual([...before].sort());
  });

  it("havuzlar katalogda yok (mevcut havuz alanlarından gelir)", () => {
    expect(AMENITY_KEYS.some((k) => k.includes("havuz"))).toBe(false);
  });

  it("gösterim sırası katalog sırasıdır; bilinmeyen ve tekrar atlanır", () => {
    expect(orderAmenities(["otopark", "wifi", "bilinmeyen", "wifi"])).toEqual(["wifi", "otopark"]);
  });
});

describe("WhatsApp numarası", () => {
  it.each([
    ["0532 123 45 67", "+905321234567"],
    ["05321234567", "+905321234567"],
    ["532 123 4567", "+905321234567"],
    ["+90 (532) 123-45-67", "+905321234567"],
    ["905321234567", "+905321234567"],
    ["0090 532 123 45 67", "+905321234567"],
    ["+44 7700 900123", "+447700900123"],
  ])("%s → %s", (input, out) => {
    expect(normalizeWhatsapp(input)).toBe(out);
    expect(out).toMatch(new RegExp(WHATSAPP_PATTERN));
  });

  it.each(["", "123", "0532 123", "+90 532 123 45 678", "abc", "+0123456789", "0212 abc"])(
    "geçersiz: %s",
    (input) => {
      expect(normalizeWhatsapp(input)).toBeNull();
    },
  );

  it("gösterim biçimi", () => {
    expect(formatWhatsapp("+905321234567")).toBe("+90 532 123 45 67");
    expect(formatWhatsapp("+447700900123")).toBe("+447700900123");
  });

  it("form girdisi: boş → kaldır, geçersiz → hata", () => {
    expect(whatsappInput.parse("  ")).toBeNull();
    expect(whatsappInput.parse("0532 123 45 67")).toBe("+905321234567");
    expect(whatsappInput.safeParse("12").success).toBe(false);
  });
});

describe("yayın durumu", () => {
  const ok: VisibilityInput = {
    isPublic: true,
    propertyActive: true,
    slug: "villa-defne",
    photoCount: 1,
    hasWhatsapp: true,
    subscriptionCurrent: true,
  };

  it("tüm koşullar sağlanınca yayında", () => {
    expect(pageVisibility(ok)).toEqual({ state: "published" });
    expect(unmetRequirements(ok)).toEqual([]);
  });

  it("yayınlanmamışsa taslak (eksikler listelenir)", () => {
    expect(pageVisibility({ ...ok, isPublic: false })).toEqual({ state: "draft", unmet: [] });
    expect(pageVisibility({ ...ok, isPublic: false, slug: null, photoCount: 0 })).toEqual({
      state: "draft",
      unmet: ["slug", "photo"],
    });
  });

  it.each([
    [{ propertyActive: false }, "active"],
    [{ slug: null }, "slug"],
    [{ slug: "" }, "slug"],
    [{ photoCount: 0 }, "photo"],
    [{ hasWhatsapp: false }, "whatsapp"],
    [{ subscriptionCurrent: false }, "subscription"],
  ] as const)("yayında ama %o → kapalı (%s)", (over, reason) => {
    expect(pageVisibility({ ...ok, ...over })).toEqual({ state: "closed", unmet: [reason] });
  });

  it("birden fazla eksik sabit sırayla", () => {
    expect(
      unmetRequirements({
        ...ok,
        subscriptionCurrent: false,
        photoCount: 0,
        propertyActive: false,
      }),
    ).toEqual(["active", "photo", "subscription"]);
  });
});

describe("sayfa ayarları formu", () => {
  const base = {
    publicSlug: "  Villa-Defne ",
    amenities: ["wifi", "otopark", "wifi"],
    checkInTime: "16:00",
    checkOutTime: "",
    houseRules: "  Evcil hayvan yok.\r\nSessizlik 23:00  ",
    cancellationPolicy: "",
    paymentTerms: "%30 ön ödeme",
    confirmSlugChange: false,
  };

  it("normalleştirme: küçük harf, tekrarsız olanak, boş → null, satır sonu", () => {
    const v = publicProfileInput.parse(base);
    expect(v).toEqual({
      publicSlug: "villa-defne",
      amenities: ["wifi", "otopark"],
      checkInTime: "16:00",
      checkOutTime: null,
      houseRules: "Evcil hayvan yok.\nSessizlik 23:00",
      confirmSlugChange: false,
    });
    // Revizyon 2: iptal / ödeme koşulları kaldırıldı; gelse de çıktıda yer almaz.
    expect(v).not.toHaveProperty("cancellationPolicy");
    expect(v).not.toHaveProperty("paymentTerms");
  });

  it("boş adres serbest (taslak)", () => {
    expect(publicProfileInput.parse({ ...base, publicSlug: "" }).publicSlug).toBeNull();
  });

  it.each([
    [{ publicSlug: "admin" }, "publicSlug"],
    [{ publicSlug: "a--b" }, "publicSlug"],
    [{ amenities: ["wifi", "uzay-asansoru"] }, "amenities"],
    [{ checkInTime: "25:00" }, "checkInTime"],
    [{ checkOutTime: "10.00" }, "checkOutTime"],
    [{ houseRules: "x".repeat(2001) }, "houseRules"],
    [{ houseRules: "kötü\u0007karakter" }, "houseRules"],
  ])("geçersiz %o → %s alanında hata", (over, field) => {
    const r = publicProfileInput.safeParse({ ...base, ...over });
    expect(r.success).toBe(false);
    expect(r.error!.issues.some((i) => i.path[0] === field)).toBe(true);
  });

  it("FormData → ham değerler (çoklu olanak, onay kutusu)", () => {
    const fd = new FormData();
    fd.set("publicSlug", "villa-defne");
    fd.append("amenities", "wifi");
    fd.append("amenities", "klima");
    fd.set("confirmSlugChange", "on");
    const raw = publicProfileFormValues(fd);
    expect(raw.amenities).toEqual(["wifi", "klima"]);
    expect(raw.confirmSlugChange).toBe(true);
    expect(raw.houseRules).toBe("");
  });

  it("veritabanı saatinden gösterim", () => {
    expect(toHhMm("16:00:00")).toBe("16:00");
    expect(toHhMm("10:30")).toBe("10:30");
    expect(toHhMm(null)).toBeNull();
  });
});

describe("denetim kaydı", () => {
  it("yeni işlem türleri: alan ADLARI, değer yok", () => {
    expect(
      validateAuditEntry({
        action: "property.public_profile_updated",
        targetType: "property",
        metadata: { fields: ["public_slug", "amenities"] },
      }),
    ).toEqual({ fields: ["public_slug", "amenities"] });
    expect(
      validateAuditEntry({ action: "property.published", targetType: "property", metadata: {} }),
    ).toEqual({});
    expect(() =>
      validateAuditEntry({
        action: "property.published",
        targetType: "property",
        // Değer yazılamaz (strict şema): tip denetimini bilerek aşıyoruz.
        metadata: { slug: "villa-defne" } as never,
      }),
    ).toThrow();
    expect(
      validateAuditEntry({
        action: "workspace.updated",
        targetType: "workspace",
        metadata: { fields: ["contact_whatsapp"] },
      }),
    ).toEqual({ fields: ["contact_whatsapp"] });
  });
});
