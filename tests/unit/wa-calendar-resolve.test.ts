import { describe, expect, it } from "vitest";

import { parseCalendarMessage, reviewRequirement } from "@/lib/wa-calendar-parse";
import {
  resolveProposal,
  type ResolveContext,
  type ResolverVilla,
  VillaWorkspaceMismatchError,
  villaReviewContext,
  WA_VILLA_SERVER_FLAGS,
} from "@/server/whatsapp/calendar/resolve";

/**
 * A2b: öneri villasının çözülmesi. Saf fonksiyon: villa listesi (işletmenin AKTİF villaları),
 * grubun villası ve takma adlar parametredir.
 */
const TODAY = "2026-11-10";
const WS = "ws-1";

const v = (id: string, name: string, aliases?: string[]): ResolverVilla => ({
  id,
  workspaceId: WS,
  name,
  ...(aliases ? { aliases } : {}),
});

const VILLAS: ResolverVilla[] = [
  v("mavi", "Villa Mavi"),
  v("lavanta", "Villa Lavanta"),
  v("zeytin", "Villa Zeytin Evi"),
  v("zbahce", "Villa Zeytin Bahçe Evi"),
  v("cinar", "Villa Çınar"),
  v("isik", "Işık Konağı"),
  v("deniz", "Villa Deniz Yıldızı Evi"),
  v("deniz2", "Deniz Kızı Villa"),
];

const ctx = (over: Partial<ResolveContext> = {}): ResolveContext => ({
  workspaceId: WS,
  villas: VILLAS,
  groupPropertyId: null,
  ...over,
});

const item = (villaName: string | null, flags: string[] = []) =>
  ({ villaName, flags }) as Parameters<typeof resolveProposal>[0];

const fromMessage = (text: string) => {
  const items = parseCalendarMessage(text, TODAY).items;
  expect(items, text).toHaveLength(1);
  return items[0]!;
};

describe("tam ad", () => {
  it('villa adı ("Villa" sözcüğü ve ekler olmadan) tekil eşleşir', () => {
    for (const name of ["Mavi", "Villa Mavi", "mavi", "MAVİ", "Mavi'yi", "Mavi villası"]) {
      expect(resolveProposal(item(name), ctx()), name).toEqual({
        resolution: "named",
        propertyId: "mavi",
        candidateIds: [],
        tier: "exact",
        serverFlags: [],
      });
    }
  });

  it("mesajdan gelen ad", () => {
    const r = resolveProposal(
      fromMessage("Villa Lavanta 1-7 Haziran arası kapatalım lütfen"),
      ctx(),
    );
    expect([r.resolution, r.propertyId, r.tier]).toEqual(["named", "lavanta", "exact"]);
  });

  it("tam ad, ilk sözcük eşleşmesinden önce gelir", () => {
    const villas = [v("z1", "Villa Zeytin"), v("z2", "Villa Zeytin Evi")];
    const r = resolveProposal(item("Zeytin"), ctx({ villas }));
    expect([r.resolution, r.propertyId, r.tier]).toEqual(["named", "z1", "exact"]);
  });

  it("çok sözcüklü tam ad", () => {
    const r = resolveProposal(item("Zeytin Bahçe Evi"), ctx());
    expect([r.resolution, r.propertyId, r.tier]).toEqual(["named", "zbahce", "exact"]);
  });
});

describe("tekil ilk sözcük", () => {
  it("tek sözcük yalnız bir villanın adının ilk sözcüğüyse eşleşir", () => {
    const r = resolveProposal(item("Işık"), ctx());
    expect([r.resolution, r.propertyId, r.tier]).toEqual(["named", "isik", "first_word"]);
  });

  it("ilk sözcük birden çok villada varsa seçim yapılmaz", () => {
    const r = resolveProposal(item("Zeytin"), ctx());
    expect(r).toEqual({
      resolution: "ambiguous",
      propertyId: null,
      candidateIds: ["zbahce", "zeytin"],
      tier: "first_word",
      serverFlags: [],
    });
    const d = resolveProposal(item("Deniz"), ctx());
    expect([d.resolution, d.candidateIds]).toEqual(["ambiguous", ["deniz2", "deniz"]]);
  });

  it("ilk sözcük dışındaki sözcükle eşleşme yapılmaz", () => {
    for (const name of ["Evi", "Bahçe", "Yıldızı", "Konağı"]) {
      expect(resolveProposal(item(name), ctx()).resolution, name).toBe("none");
    }
  });
});

describe("baş sözcükler", () => {
  it("çok sözcüklü ad, villa adının baş sözcükleriyse eşleşir", () => {
    const r = resolveProposal(item("Zeytin Bahçe"), ctx());
    expect([r.resolution, r.propertyId, r.tier]).toEqual(["named", "zbahce", "prefix"]);
    const d = resolveProposal(item("Deniz Yıldızı"), ctx());
    expect([d.resolution, d.propertyId, d.tier]).toEqual(["named", "deniz", "prefix"]);
  });

  it("baş sözcükler birden çok villaya uyarsa seçim yapılmaz", () => {
    const villas = [v("a", "Villa Ege Mavi Ev"), v("b", "Villa Ege Mavi Konak")];
    const r = resolveProposal(item("Ege Mavi"), ctx({ villas }));
    expect([r.resolution, r.propertyId, r.candidateIds, r.tier]).toEqual([
      "ambiguous",
      null,
      ["a", "b"],
      "prefix",
    ]);
  });
});

describe("aynı isimli birden fazla villa", () => {
  const villas = [v("m2", "Villa Mavi"), v("m1", "Mavi Villa"), v("lav", "Villa Lavanta")];

  it("otomatik seçim yapılmaz; adaylar döner", () => {
    const r = resolveProposal(item("Mavi"), ctx({ villas }));
    expect(r).toEqual({
      resolution: "ambiguous",
      propertyId: null,
      candidateIds: ["m1", "m2"],
      tier: "exact",
      serverFlags: [],
    });
  });

  it("grup bir villaya bağlıysa aynı adlı villalar arasında seçim gerekmez: grubun villası", () => {
    const r = resolveProposal(item("Mavi"), ctx({ villas, groupPropertyId: "m2" }));
    expect([r.resolution, r.propertyId, r.candidateIds, r.serverFlags]).toEqual([
      "named",
      "m2",
      [],
      [],
    ]);
  });

  it("belirsiz villa tek tıkla onaylanamaz", () => {
    const r = resolveProposal(item("Mavi"), ctx({ villas }));
    const d = reviewRequirement(fromMessage("Villa Mavi 12-18 Temmuz kapalı"), {
      ...villaReviewContext(r),
      senderRole: "owner",
      conflictFree: true,
    });
    expect(d.quickApprove).toBe(false);
    expect(d.reasons).toContain("villa_unresolved");
  });

  it("aynı kimlik iki kez verilirse tek villa sayılır", () => {
    const r = resolveProposal(
      item("Mavi"),
      ctx({ villas: [v("m", "Villa Mavi"), v("m", "Villa Mavi")] }),
    );
    expect([r.resolution, r.propertyId]).toEqual(["named", "m"]);
  });

  it("ayrıştırıcının villa_ambiguous bayrağı: hiçbir villa seçilmez", () => {
    const r = resolveProposal(item(null, ["villa_ambiguous"]), ctx({ groupPropertyId: "mavi" }));
    expect(r).toEqual({
      resolution: "ambiguous",
      propertyId: null,
      candidateIds: [],
      tier: null,
      serverFlags: [],
    });
  });
});

describe("grup villasının varsayılan kullanımı", () => {
  it("mesajda villa adı yoksa grubun villası kullanılır", () => {
    const i = fromMessage("15-20 Haziran kapalı");
    expect(i.villaName).toBeNull();
    const r = resolveProposal(i, ctx({ groupPropertyId: "lavanta" }));
    expect(r).toEqual({
      resolution: "single",
      propertyId: "lavanta",
      candidateIds: [],
      tier: "group_default",
      serverFlags: [],
    });
    const d = reviewRequirement(i, {
      ...villaReviewContext(r),
      senderRole: "owner",
      conflictFree: true,
    });
    expect([d.quickApprove, d.score]).toEqual([true, 95]);
  });

  it("grup villaya bağlı değilse ve ad yoksa villa çözülmez", () => {
    const r = resolveProposal(item(null, ["villa_missing"]), ctx());
    expect([r.resolution, r.propertyId, r.serverFlags]).toEqual(["none", null, []]);
  });

  it("ad grubun villasının adıysa grubun villası, bilgi bayrağı yok", () => {
    for (const name of ["Mavi", "Villa Mavi", "MAVİ"]) {
      const r = resolveProposal(item(name), ctx({ groupPropertyId: "mavi" }));
      expect([name, r.resolution, r.propertyId, r.serverFlags]).toEqual([
        name,
        "named",
        "mavi",
        [],
      ]);
    }
    // İlk sözcük / baş sözcükler / takma ad da grubun villasını anlatır.
    expect(
      resolveProposal(item("Zeytin Bahçe"), ctx({ groupPropertyId: "zbahce" })).serverFlags,
    ).toEqual([]);
    expect(resolveProposal(item("Işık"), ctx({ groupPropertyId: "isik" })).serverFlags).toEqual([]);
    const aliases = [{ propertyId: "mavi", alias: "Kalamar Evi" }];
    expect(
      resolveProposal(item("Kalamar Evi"), ctx({ groupPropertyId: "mavi", aliases })).serverFlags,
    ).toEqual([]);
  });
});

describe("grup eşleştirmesi kesin kaynak (A2e)", () => {
  it("mesajdaki ad bulunamasa da (ör. grubun adı) grubun villası kullanılır; bilgi bayrağı", () => {
    // Grup "villa testo", bağlı villa "Villa Mavi"; mesaj "Villa Testo 10–15 Haziran kapatalım."
    const i = fromMessage("Villa Testo 10–15 Haziran kapatalım.");
    expect(i.villaName).toBe("Testo");
    const r = resolveProposal(i, ctx({ groupPropertyId: "mavi" }));
    expect(r).toEqual({
      resolution: "single",
      propertyId: "mavi",
      candidateIds: [],
      tier: "group_default",
      serverFlags: ["villa_name_mismatch"],
    });
    const d = reviewRequirement(i, {
      ...villaReviewContext(r),
      senderRole: "owner",
      conflictFree: true,
    });
    expect([d.quickApprove, d.band, d.reasons]).toEqual([true, "high", []]);
  });

  it("başka bir villanın adı yazılsa da grubun villası kazanır (grup dışı villa seçilmez)", () => {
    for (const name of ["Lavanta", "Villa Lavanta", "Işık"]) {
      const r = resolveProposal(item(name), ctx({ groupPropertyId: "mavi" }));
      expect([name, r.resolution, r.propertyId, r.serverFlags]).toEqual([
        name,
        "single",
        "mavi",
        ["villa_name_mismatch"],
      ]);
    }
    const aliases = [{ propertyId: "lavanta", alias: "Mor Ev" }];
    expect(
      resolveProposal(item("Mor Ev"), ctx({ groupPropertyId: "mavi", aliases })),
    ).toMatchObject({
      resolution: "single",
      propertyId: "mavi",
      serverFlags: ["villa_name_mismatch"],
    });
  });

  it("grup villasızsa ada göre eşleşir (otomatik işlem yok; grup dışı kavramı yok)", () => {
    const r = resolveProposal(fromMessage("Villa Lavanta 1-7 Haziran kapalı"), ctx());
    expect(r).toEqual({
      resolution: "named",
      propertyId: "lavanta",
      candidateIds: [],
      tier: "exact",
      serverFlags: [],
    });
  });

  it("grubun villası pasifse yazılan ad başka bir aktif villaya düşmez", () => {
    const active = VILLAS.filter((x) => x.id !== "mavi");
    const r = resolveProposal(item("Lavanta"), ctx({ villas: active, groupPropertyId: "mavi" }));
    expect([r.resolution, r.propertyId, r.serverFlags]).toEqual([
      "none",
      null,
      ["villa_not_found"],
    ]);
  });
});

describe("pasif / bulunamayan villa", () => {
  it("listede olmayan (pasif) villa bulunamadı sayılır", () => {
    const active = VILLAS.filter((x) => x.id !== "lavanta");
    const r = resolveProposal(item("Lavanta"), ctx({ villas: active }));
    expect(r).toEqual({
      resolution: "none",
      propertyId: null,
      candidateIds: [],
      tier: null,
      serverFlags: ["villa_not_found"],
    });
  });

  it("grubun villası pasifse (listede yoksa) adsız mesaj varsayılana düşmez", () => {
    const active = VILLAS.filter((x) => x.id !== "mavi");
    const r = resolveProposal(
      item(null, ["villa_missing"]),
      ctx({ villas: active, groupPropertyId: "mavi" }),
    );
    expect([r.resolution, r.propertyId, r.serverFlags]).toEqual([
      "none",
      null,
      ["villa_not_found"],
    ]);
  });

  it("yazım hatası tahmin edilmez", () => {
    for (const name of ["Lavnta", "Mavii", "Zeytn", "Lavantaa"]) {
      const r = resolveProposal(item(name), ctx());
      expect([name, r.resolution, r.serverFlags]).toEqual([name, "none", ["villa_not_found"]]);
    }
  });

  it("genel sözcük villa adı sayılmaz", () => {
    for (const name of ["Villa", "Ev", "Konak", "Konağı", "villası"]) {
      expect(resolveProposal(item(name), ctx()).resolution, name).toBe("none");
      // Grup villaya bağlıysa grubun villası; genel sözcük "farklı ad" sayılmaz.
      expect(resolveProposal(item(name), ctx({ groupPropertyId: "mavi" })), name).toMatchObject({
        resolution: "single",
        propertyId: "mavi",
        serverFlags: [],
      });
    }
  });

  it("boş villa listesi", () => {
    expect(resolveProposal(item("Mavi"), ctx({ villas: [] })).resolution).toBe("none");
  });
});

describe("Türkçe karakterler", () => {
  it("noktalı/noktasız i, ç, ş, ğ, ö, ü ve büyük/küçük harf katlanır", () => {
    const cases: [string, string][] = [
      ["Çınar", "cinar"],
      ["CINAR", "cinar"],
      ["çınar", "cinar"],
      ["Cinar", "cinar"],
      ["IŞIK", "isik"],
      ["ışık", "isik"],
      ["Isik Konagi", "isik"],
      ["Zeytin Bahce", "zbahce"],
      ["DENİZ YILDIZI", "deniz"],
    ];
    for (const [name, id] of cases) {
      expect([name, resolveProposal(item(name), ctx()).propertyId]).toEqual([name, id]);
    }
  });

  it("mesajdan: 'Villa Çınar'ı' ekiyle", () => {
    const r = resolveProposal(
      fromMessage("Villa Çınar'ı 20 Ağustos'tan 27 Ağustos'a kadar kapatın"),
      ctx(),
    );
    expect([r.resolution, r.propertyId]).toEqual(["named", "cinar"]);
  });
});

describe("takma ad arayüzü", () => {
  it("villa başına birden çok takma ad (parametre listesi)", () => {
    const aliases = [
      { propertyId: "deniz", alias: "Kalamar" },
      { propertyId: "deniz", alias: "Büyük Ev Kalkan" },
    ];
    for (const name of ["Kalamar", "kalamar villası", "Büyük Ev Kalkan"]) {
      const r = resolveProposal(item(name), ctx({ aliases }));
      expect([name, r.resolution, r.propertyId, r.tier]).toEqual([name, "named", "deniz", "alias"]);
    }
  });

  it("villa nesnesindeki takma adlar da kullanılır", () => {
    const villas = [v("x", "Villa Begonvil", ["Pembe", "Pembe Ev"]), v("y", "Villa Mavi")];
    expect(resolveProposal(item("Pembe"), ctx({ villas })).propertyId).toBe("x");
    expect(resolveProposal(item("pembe ev"), ctx({ villas })).propertyId).toBe("x");
  });

  it("takma adlar yalnız tam eşleşir (baş sözcük / ilk sözcük yok)", () => {
    const aliases = [{ propertyId: "deniz", alias: "Kalamar Koyu" }];
    expect(resolveProposal(item("Kalamar"), ctx({ aliases })).resolution).toBe("none");
  });

  it("takma ad başka bir villanın adıyla çakışırsa seçim yapılmaz", () => {
    const aliases = [{ propertyId: "deniz", alias: "Mavi" }];
    const r = resolveProposal(item("Mavi"), ctx({ aliases }));
    expect([r.resolution, r.candidateIds.sort()]).toEqual(["ambiguous", ["deniz", "mavi"]]);
  });

  it("aynı takma ad iki villada: seçim yapılmaz", () => {
    const aliases = [
      { propertyId: "deniz", alias: "Koy" },
      { propertyId: "lavanta", alias: "koy" },
    ];
    const r = resolveProposal(item("Koy"), ctx({ aliases }));
    expect([r.resolution, r.tier, r.candidateIds]).toEqual([
      "ambiguous",
      "alias",
      ["deniz", "lavanta"],
    ]);
  });

  it("listede olmayan (pasif / başka işletme) villaya ait takma ad yok sayılır", () => {
    const aliases = [{ propertyId: "baska-isletme-villa", alias: "Kalamar" }];
    const r = resolveProposal(item("Kalamar"), ctx({ aliases }));
    expect([r.resolution, r.propertyId, r.serverFlags]).toEqual([
      "none",
      null,
      ["villa_not_found"],
    ]);
  });

  it("genel sözcükten oluşan takma ad kaydedilmez", () => {
    const aliases = [{ propertyId: "mavi", alias: "Ev" }];
    expect(resolveProposal(item("Ev"), ctx({ aliases })).resolution).toBe("none");
  });
});

describe("işletme izolasyonu ve saflık", () => {
  it("başka işletmenin villası listeye girerse hata verir (sessizce eşlemez)", () => {
    const villas = [...VILLAS, { id: "x", workspaceId: "ws-2", name: "Villa Yabancı" }];
    expect(() => resolveProposal(item("Mavi"), ctx({ villas }))).toThrow(
      VillaWorkspaceMismatchError,
    );
  });

  it("dönen kimlikler yalnız verilen villalardan gelir; girdi değiştirilmez", () => {
    const villas = VILLAS.map((x) => ({ ...x }));
    const snapshot = JSON.stringify(villas);
    const ids = new Set(villas.map((x) => x.id));
    for (const name of ["Mavi", "Zeytin", "Işık", "Begonya", null]) {
      const r = resolveProposal(item(name), ctx({ villas, groupPropertyId: "mavi" }));
      for (const id of [r.propertyId, ...r.candidateIds]) if (id) expect(ids.has(id)).toBe(true);
      expect(resolveProposal(item(name), ctx({ villas, groupPropertyId: "mavi" }))).toEqual(r);
    }
    expect(JSON.stringify(villas)).toBe(snapshot);
  });

  it("aday listesi 20 ile sınırlı", () => {
    const villas = Array.from({ length: 25 }, (_, n) =>
      v(`id${String(n).padStart(2, "0")}`, "Villa Mavi"),
    );
    const r = resolveProposal(item("Mavi"), ctx({ villas }));
    expect([r.resolution, r.candidateIds.length]).toEqual(["ambiguous", 20]);
  });

  it("sunucu bayrakları kod biçimine uyar", () => {
    for (const f of WA_VILLA_SERVER_FLAGS) expect(f).toMatch(/^[a-z_]{1,40}$/);
  });
});
