import { describe, expect, it } from "vitest";

import { MAP_EMBED_DB_PATTERN, mapOpenUrl, parseMapInput, safeMapEmbedUrl } from "@/lib/map-embed";
import { buildCsp } from "@/lib/security-headers";
import {
  DISTANCE_KEYS,
  DISTANCE_LABELS,
  distanceFormUnit,
  distanceToInput,
  formatDistance,
  HOUSE_RULES,
  parseDistanceInput,
  RETIRED_HOUSE_RULES,
  RETIRED_PRICE_INCLUDES,
  orderHouseRules,
  orderPriceIncludes,
  PRICE_INCLUDES,
} from "@/lib/villa-extras";

/** Villa sihirbazı revizyonu: Google Haritalar ayrıştırma ve güvenlik (saf). */

const PB =
  "!1m18!1m12!1m3!1d3196.123!2d29.414301!3d36.265512!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x14c1d8%3A0xabc!2sVilla%20Defne!5e0!3m2!1str!2str!4v1700000000000!5m2!1str!2str";
const EMBED = `https://www.google.com/maps/embed?pb=${PB}`;
const IFRAME = `<iframe src="${EMBED}" width="600" height="450" style="border:0;" allowfullscreen="" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>`;
const Q = (lat: string, lng: string) =>
  `https://www.google.com/maps?q=${lat},${lng}&z=16&output=embed`;

const ok = (input: string) => {
  const r = parseMapInput(input);
  if (!r.ok) throw new Error(`beklenmeyen hata: ${r.error}`);
  return r.url;
};
const err = (input: string) => {
  const r = parseMapInput(input);
  return r.ok ? `ok:${r.url}` : r.error;
};

describe("Google Haritalar: geçerli girdiler", () => {
  it("'Haritayı yerleştir' iframe kodu → yalnız src (pb) adresi", () => {
    expect(ok(IFRAME)).toBe(EMBED);
    expect(ok(`  ${IFRAME}\n`)).toBe(EMBED);
    expect(ok(IFRAME.replace(/"/g, "'"))).toBe(EMBED);
    // HTML kaçışlı & (bazı editörler kopyalarken üretir)
    expect(ok(`<iframe src="${EMBED}&amp;hl=tr"></iframe>`)).toBe(EMBED);
  });

  it("gömme adresinin kendisi; google.com.tr ve maps. alt alanı; http → https", () => {
    expect(ok(EMBED)).toBe(EMBED);
    expect(ok(EMBED.replace("www.google.com", "www.google.com.tr"))).toBe(EMBED);
    expect(ok(EMBED.replace("https://www.google.com", "http://maps.google.com"))).toBe(EMBED);
  });

  it("tam paylaşım bağlantısı → koordinattan gömme adresi (iğne !3d!4d öncelikli)", () => {
    expect(
      ok(
        "https://www.google.com/maps/place/Villa+Defne/@36.2600000,29.4100000,17z/data=!3m1!4b1!4m6!3m5!1s0x14c1:0x1!8m2!3d36.2655123!4d29.4143012!16s%2Fg%2F11",
      ),
    ).toBe(Q("36.265512", "29.414301"));
    expect(ok("https://www.google.com/maps/@36.2651,29.4143,15z")).toBe(
      Q("36.265100", "29.414300"),
    );
    expect(ok("https://www.google.com/maps?q=36.2651,29.4143")).toBe(Q("36.265100", "29.414300"));
    expect(ok("https://www.google.com/maps/search/?api=1&query=36.2651%2C29.4143")).toBe(
      Q("36.265100", "29.414300"),
    );
    expect(ok("https://maps.google.com.tr/maps?ll=36.2651,29.4143&z=14")).toBe(
      Q("36.265100", "29.414300"),
    );
    // Şemasız yapıştırma
    expect(ok("www.google.com/maps/@36.2651,29.4143,15z")).toBe(Q("36.265100", "29.414300"));
  });
});

describe("Google Haritalar: reddedilenler", () => {
  it("kısa paylaşım bağlantıları → short_link (sunucu dışarı istek atmaz)", () => {
    for (const u of [
      "https://maps.app.goo.gl/AbCdEf123",
      "maps.app.goo.gl/AbCdEf123",
      "https://goo.gl/maps/xyz",
      "https://g.co/kgs/abc",
    ]) {
      expect(err(u), u).toBe("short_link");
    }
  });

  it("Google dışı alan adları ve taklitleri → not_google", () => {
    for (const u of [
      "https://evil.example/maps/embed?pb=!1m2",
      "https://www.google.com.evil.example/maps/embed?pb=!1m2",
      "https://google.com-evil.example/maps/embed?pb=!1m2",
      "https://evilgoogle.com/maps/embed?pb=!1m2",
      "https://www.openstreetmap.org/#map=16/36.26/29.41",
      '<iframe src="https://evil.example/x"></iframe>',
      "https://www.google.com/search?q=villa",
    ]) {
      expect(err(u), u).toBe("not_google");
    }
  });

  it("tehlikeli şemalar, kimlik bilgisi, port, bozuk pb, betik → invalid", () => {
    for (const u of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "https://user:pw@www.google.com/maps/embed?pb=!1m2",
      "https://www.google.com:8443/maps/embed?pb=!1m2",
      'https://www.google.com/maps/embed?pb=!1m2"><script>alert(1)</script>',
      "https://www.google.com/maps/embed?pb=",
      "https://www.google.com/maps/embed",
      `https://www.google.com/maps/embed?pb=${"!1m2".repeat(400)}`,
      "<iframe></iframe>",
      '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
      "",
      "   ",
      "x".repeat(4001),
    ]) {
      expect(err(u), u.slice(0, 60)).toBe("invalid");
    }
  });

  it("konum bilgisi olmayan Google Haritalar bağlantısı → no_location; geçersiz koordinat da", () => {
    expect(err("https://www.google.com/maps/place/Kalkan")).toBe("no_location");
    expect(err("https://www.google.com/maps?q=Villa+Defne")).toBe("no_location");
    expect(err("https://www.google.com/maps/@95.1,29.4,15z")).toBe("no_location");
    expect(err("https://www.google.com/maps/@0,0,15z")).toBe("no_location");
  });

  it("çıktı her zaman sıfırdan üretilir: gelen ek parametreler taşınmaz", () => {
    expect(ok(`${EMBED}&onload=x&q=evil`)).toBe(EMBED);
    expect(ok("https://www.google.com/maps?q=36.2,29.4&output=embed&callback=x")).toBe(
      Q("36.200000", "29.400000"),
    );
  });
});

describe("kayıtlı adresin gösterimden önce doğrulanması", () => {
  it("yalnız iki kalıp; başka her şey null", () => {
    expect(safeMapEmbedUrl(EMBED)).toBe(EMBED);
    expect(safeMapEmbedUrl(Q("36.265100", "29.414300"))).toBe(Q("36.265100", "29.414300"));
    for (const bad of [
      null,
      "",
      "https://evil.example/maps/embed?pb=!1",
      `${EMBED}&x=1`,
      "https://www.google.com/maps?q=36.2,29.4&z=16&output=embed", // 6 ondalık değil (kanonik değil)
      "javascript:alert(1)",
    ]) {
      expect(safeMapEmbedUrl(bad), String(bad)).toBeNull();
    }
  });

  it("veritabanı kalıbı ayrıştırıcının ürettiği her adresi kabul eder", () => {
    const re = new RegExp(MAP_EMBED_DB_PATTERN);
    expect(re.test(EMBED)).toBe(true);
    expect(re.test(Q("-33.865143", "151.209900"))).toBe(true);
    expect(re.test(`${EMBED}&x=1`)).toBe(false);
  });

  it("'Google Haritalar'da aç' bağlantısı koordinattan", () => {
    expect(mapOpenUrl(Q("36.265100", "29.414300"))).toBe(
      "https://www.google.com/maps/search/?api=1&query=36.265100,29.414300",
    );
    expect(mapOpenUrl(EMBED)).toBe(
      "https://www.google.com/maps/search/?api=1&query=36.265512,29.414301",
    );
    expect(mapOpenUrl("https://www.google.com/maps/embed?pb=!1m2")).toBeNull();
  });

  it("CSP: iframe yalnız https://www.google.com'dan; diğer yönergeler değişmedi", () => {
    const csp = buildCsp("n", { isDev: false });
    expect(csp).toContain("frame-src https://www.google.com;");
    // Revizyon 2: yalnız OSM karo kökeni eklendi (joker / başka köken yok).
    expect(csp).toContain("img-src 'self' blob: data: https://tile.openstreetmap.org;");
    expect(csp).toContain("default-src 'self';");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });
});

describe("mesafeler, kurallar, fiyata dahil olanlar", () => {
  it("7 sabit mesafe, sırayla", () => {
    expect(DISTANCE_KEYS.map((k) => DISTANCE_LABELS[k])).toEqual([
      "Market",
      "Restoran",
      "Merkez",
      "Plaj",
      "Antalya Havalimanı",
      "Dalaman Havalimanı",
      "Sağlık Merkezi",
    ]);
  });

  it("mesafe gösterimi (Revizyon 2): seçilen birimle; birimsiz eski kayıtta otomatik", () => {
    expect(formatDistance(0.5, "m")).toBe("500 m");
    expect(formatDistance(1.25, "m")).toBe("1.250 m");
    expect(formatDistance(2, "km")).toBe("2 km");
    expect(formatDistance(1.5, "km")).toBe("1,5 km");
    expect(formatDistance(0.35, "km")).toBe("0,35 km");
    expect(formatDistance(112.25, "km")).toBe("112,25 km");
    expect(formatDistance(0.35, null)).toBe("350 m");
  });

  it("mesafe girişi: birim başına sınırlar, km'ye çeviri, form gösterimi", () => {
    expect(parseDistanceInput("500", "m")).toEqual({ ok: true, km: 0.5 });
    expect(parseDistanceInput("1,5", "km")).toEqual({ ok: true, km: 1.5 });
    expect(parseDistanceInput("", "m")).toEqual({ ok: true, km: null });
    expect(parseDistanceInput("1,5", "m")).toEqual({ ok: false, error: "format" });
    expect(parseDistanceInput("0", "km")).toEqual({ ok: false, error: "zero" });
    expect(parseDistanceInput("100000", "m")).toEqual({ ok: false, error: "format" });
    expect(distanceToInput(0.5, "m")).toBe("500");
    expect(distanceToInput(1.5, "km")).toBe("1,5");
    expect(distanceFormUnit(0.4, null)).toBe("m");
    expect(distanceFormUnit(2.5, null)).toBe("km");
    expect(distanceFormUnit(0.4, "km")).toBe("km");
    expect(distanceFormUnit(null, null)).toBe("km");
  });

  it("Revizyon 2: kaldırılan kural ve dahil olanlar katalogda yok; eski kayıtta gösterilmez", () => {
    const rules = HOUSE_RULES.map(([k]) => k as string);
    const incl = PRICE_INCLUDES.map(([k]) => k as string);
    for (const k of RETIRED_HOUSE_RULES) expect(rules).not.toContain(k);
    for (const k of RETIRED_PRICE_INCLUDES) expect(incl).not.toContain(k);
    expect(rules).toEqual([
      "evcil-hayvan-yok",
      "sigara-icilmez",
      "parti-yok",
      "cocuklar-uygun",
      "sessizlik-saatleri",
      "ziyaretci-yok",
    ]);
    expect(incl).toEqual(["elektrik", "su", "internet", "havuz-bakimi", "bahce-bakimi", "klima"]);
    expect(
      orderHouseRules(["kimlik-zorunlu", "parti-yok", "havuz-gozetim"]).map((r) => r.key),
    ).toEqual(["parti-yok"]);
    expect(orderPriceIncludes(["temizlik", "su", "isitma"]).map((r) => r.key)).toEqual(["su"]);
  });

  it("mesafe gösterimi: 1 km altı metre, 10 km altı bir ondalık", () => {
    expect(formatDistance(0.35)).toBe("350 m");
    expect(formatDistance(0.004)).toBe("10 m");
    expect(formatDistance(1)).toBe("1 km");
    expect(formatDistance(2.46)).toBe("2,5 km");
    expect(formatDistance(112.25)).toBe("112 km");
  });

  it("kataloglar tekrarsız; katalog sırası, bilinmeyen anahtar atlanır", () => {
    for (const c of [HOUSE_RULES, PRICE_INCLUDES]) {
      expect(new Set(c.map(([k]) => k)).size).toBe(c.length);
      for (const [k] of c) expect(k).toMatch(/^[a-z][a-z0-9-]{1,31}$/);
    }
    expect(orderHouseRules(["parti-yok", "x", "sigara-icilmez"]).map((r) => r.key)).toEqual([
      "sigara-icilmez",
      "parti-yok",
    ]);
    expect(orderPriceIncludes(["su", "elektrik"]).map((r) => r.label)).toEqual(["Elektrik", "Su"]);
  });
});
