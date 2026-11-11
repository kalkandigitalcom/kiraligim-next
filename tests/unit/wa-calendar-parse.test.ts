import { describe, expect, it } from "vitest";

import {
  confidenceBand,
  foldTr,
  matchVillaName,
  parseCalendarMessage,
  parseGuestCount,
  reviewRequirement,
  scoreProposal,
  villaKey,
  WA_CALENDAR_ACTIONS,
  WA_CALENDAR_FLAGS,
  WA_CALENDAR_MAX_ITEMS,
  WA_CALENDAR_PARSER_VERSION,
  WA_QUICK_APPROVE_ACTIONS,
  type WaCalendarItem,
} from "@/lib/wa-calendar-parse";

/**
 * WhatsApp takvim mesajı ayrıştırıcısı (Aşama 1). Bugün sabit: 10 Kasım 2026 (Europe/Istanbul).
 * Ayrıştırıcı hiçbir şeyi uygulamaz; yalnız öneri girdisi üretir.
 */
const TODAY = "2026-11-10";

const parse = (text: string, today = TODAY) => parseCalendarMessage(text, today).items;
const one = (text: string, today = TODAY): WaCalendarItem => {
  const items = parse(text, today);
  expect(items, text).toHaveLength(1);
  return items[0]!;
};
/** Karşılaştırma için kısa biçim. */
const brief = (i: WaCalendarItem) => ({
  action: i.action,
  villa: i.villaName,
  checkIn: i.checkIn,
  checkOut: i.checkOut,
  flags: i.flags,
});

describe("rapordaki dört örnek mesaj", () => {
  it("Villa A 15-20 Haziran kapalı → kapat, [2027-06-15, 2027-06-20), 5 gece", () => {
    const i = one("Villa A 15-20 Haziran kapalı.");
    expect(i).toEqual({
      action: "close",
      villaName: "A",
      checkIn: "2027-06-15",
      checkOut: "2027-06-20",
      nights: 5,
      reservationStatus: null,
      flags: ["year_inferred"],
      datesExplicit: true,
      actionClear: true,
      excerpt: "Villa A 15-20 Haziran kapalı",
    });
  });

  it("Villa B giriş/çıkış 'rezervasyon aldı' → v5: yalnız takvim kapatma", () => {
    const i = one("Villa B 5 Temmuz giriş, 12 Temmuz çıkış rezervasyon aldı.");
    expect(brief(i)).toEqual({
      action: "close",
      villa: "B",
      checkIn: "2027-07-05",
      checkOut: "2027-07-12",
      flags: ["year_inferred"],
    });
    expect(i.nights).toBe(7);
    expect(i.reservationStatus).toBeNull();
  });

  it("Villa C'nin … tekrar açalım → aç; iyelik eki addan atılır", () => {
    expect(brief(one("Villa C'nin 10-15 Ağustos tarihlerini tekrar açalım."))).toEqual({
      action: "open",
      villa: "C",
      checkIn: "2027-08-10",
      checkOut: "2027-08-15",
      flags: ["year_inferred"],
    });
  });

  it('Villa D\'nin … müsait değil → kapat ("müsait" açmak değil)', () => {
    expect(brief(one("Villa D'nin 20-25 Eylül tarihleri müsait değil."))).toEqual({
      action: "close",
      villa: "D",
      checkIn: "2027-09-20",
      checkOut: "2027-09-25",
      flags: ["year_inferred"],
    });
  });
});

describe("tarih biçimleri", () => {
  const RANGE_VECTORS: [string, string, string][] = [
    ["Villa A 15-20 Haziran kapalı", "2027-06-15", "2027-06-20"],
    ["Villa A 15 – 20 haziran kapalı", "2027-06-15", "2027-06-20"],
    ["Villa A 15 ile 20 Haziran arası kapalı", "2027-06-15", "2027-06-20"],
    ["Villa A 15 Haziran - 20 Haziran kapalı", "2027-06-15", "2027-06-20"],
    ["Villa A 15 Haziran'dan 20 Haziran'a kadar kapalı", "2027-06-15", "2027-06-20"],
    ["Villa A 28 Haziran - 3 Temmuz kapalı", "2027-06-28", "2027-07-03"],
    ["Villa A 15.06-20.06 kapalı", "2027-06-15", "2027-06-20"],
    ["Villa A 15/06/2027 - 20/06/2027 kapalı", "2027-06-15", "2027-06-20"],
    ["Villa A 15.06.27-20.06.27 kapalı", "2027-06-15", "2027-06-20"],
    ["Villa A 15-20 haz. kapalı", "2027-06-15", "2027-06-20"],
    ["Villa A 1-5 agustos kapali", "2027-08-01", "2027-08-05"],
    ["Villa A 1-5 AĞU dolu", "2027-08-01", "2027-08-05"],
    ["VİLLA A 3-8 EYLÜL KAPALI", "2027-09-03", "2027-09-08"],
    ["Villa A 3-8 eylul kapali", "2027-09-03", "2027-09-08"],
    ["Villa A 10-14 Şubat kapalı", "2027-02-10", "2027-02-14"],
    ["Villa A 10-14 subat kapali", "2027-02-10", "2027-02-14"],
    ["Villa A 10-14 Mayıs kapalı", "2027-05-10", "2027-05-14"],
    ["Villa A 10-14 mayis kapali", "2027-05-10", "2027-05-14"],
    ["Villa A 10-14 Nisan kapalı", "2027-04-10", "2027-04-14"],
    ["Villa A 1-3 Ekim kapalı", "2027-10-01", "2027-10-03"],
    ["Villa A 20-25 Aralık kapalı", "2026-12-20", "2026-12-25"],
    ["Villa A 20-25 aralik kapali", "2026-12-20", "2026-12-25"],
  ];

  it("vektörler: [giriş, çıkış) ve 'close'", () => {
    for (const [text, checkIn, checkOut] of RANGE_VECTORS) {
      const i = one(text);
      expect([text, i.action, i.checkIn, i.checkOut]).toEqual([text, "close", checkIn, checkOut]);
    }
  });

  it("yazılmış yıl korunur ve year_inferred konmaz", () => {
    const i = one("Villa A 15-20 Haziran 2028 kapalı");
    expect([i.checkIn, i.checkOut, i.flags]).toEqual(["2028-06-15", "2028-06-20", []]);
  });

  it("geçersiz gün → tarih yok, date_invalid", () => {
    const i = one("Villa A 31 Haziran - 3 Temmuz kapalı");
    expect([i.checkIn, i.checkOut, i.flags, i.datesExplicit]).toEqual([
      null,
      null,
      ["date_invalid"],
      false,
    ]);
    expect(one("Villa A 30 Şubat - 2 Mart kapalı").flags).toContain("date_invalid");
  });

  it("tek gün → çıkış tahmin edilmez, date_incomplete", () => {
    const i = one("Villa A 15 Haziran kapalı");
    expect([i.checkIn, i.checkOut, i.nights]).toEqual(["2027-06-15", null, null]);
    expect(i.flags).toEqual(["date_incomplete", "year_inferred"]);
    expect(i.datesExplicit).toBe(false);
  });

  it("tarih yok ama villa + eylem var → date_missing", () => {
    const i = one("Villa A'yı kapatalım");
    expect([i.action, i.villaName, i.checkIn, i.flags]).toEqual([
      "close",
      "A",
      null,
      ["date_missing"],
    ]);
  });

  it("bağlanamayan tarih ifadeleri → date_ambiguous", () => {
    const i = one("Villa A 1 Haziran, 5 Haziran ve 9 Haziran kapalı");
    expect([i.checkIn, i.checkOut, i.flags]).toEqual([null, null, ["date_ambiguous"]]);
  });

  it("çok uzun aralık → range_too_long", () => {
    expect(one("Villa A 1 Haziran - 15 Eylül kapalı").flags).toContain("range_too_long");
  });
});

describe("yıl", () => {
  it("bugün 10 Kasım: Aralık bu yıl, Ocak gelecek yıl", () => {
    expect(one("Villa A 5-8 Aralık kapalı").checkIn).toBe("2026-12-05");
    expect(one("Villa A 5-8 Ocak kapalı").checkIn).toBe("2027-01-05");
  });

  it("yıl dönümü: 28 Aralık - 3 Ocak", () => {
    const i = one("Villa A 28 Aralık - 3 Ocak kapalı");
    expect([i.checkIn, i.checkOut, i.nights]).toEqual(["2026-12-28", "2027-01-03", 6]);
  });

  it("giriş ~11 aydan uzaksa year_ambiguous (datesExplicit false)", () => {
    const i = one("Villa A 5-8 Kasım kapalı");
    expect(i.checkIn).toBe("2027-11-05");
    expect(i.flags).toEqual(["year_inferred", "year_ambiguous"]);
    expect(i.datesExplicit).toBe(false);
    // 10 ay sonrası belirsiz değil
    expect(one("Villa A 20-25 Eylül kapalı").flags).toEqual(["year_inferred"]);
  });

  it("devam eden konaklama bu yıl kalır ve in_progress", () => {
    const i = one("Villa A 8-12 Kasım dolu");
    expect([i.checkIn, i.checkOut]).toEqual(["2026-11-08", "2026-11-12"]);
    expect(i.flags).toContain("in_progress");
  });

  it("yazılmış yılla geçmiş aralık → date_past", () => {
    expect(one("Villa A 1-5 Haziran 2026 kapalı").flags).toEqual(["date_past"]);
  });

  it("bugün parametredir: aynı mesaj farklı günde farklı yıl", () => {
    expect(one("Villa A 15-20 Haziran kapalı", "2027-03-01").checkIn).toBe("2027-06-15");
    expect(one("Villa A 15-20 Haziran kapalı", "2027-06-21").checkIn).toBe("2028-06-15");
    expect(() => parseCalendarMessage("x", "10.11.2026")).toThrow();
  });
});

describe("eylem", () => {
  const ACTION_VECTORS: [string, WaCalendarItem["action"], string[]][] = [
    ["Villa A 15-20 Haziran kapalı", "close", []],
    ["Villa A 15-20 Haziran kapatalım", "close", []],
    ["Villa A 15-20 Haziran dolu", "close", []],
    ["Villa A 15-20 Haziran blokla", "close", []],
    ["Villa A 15-20 Haziran satmayın", "close", []],
    ["Villa A 15-20 Haziran müsait değil", "close", []],
    ["Villa A 15-20 Haziran musait degil", "close", []],
    ["Villa A 15-20 Haziran MÜSAİT DEĞİL", "close", []],
    ["Villa A 15-20 Haziran boş değil", "close", []],
    ["Villa A 15-20 Haziran müsait", "open", []],
    ["Villa A 15-20 Haziran boş", "open", []],
    ["Villa A 15-20 Haziran açalım", "open", []],
    ["Villa A 15-20 Haziran tekrar açın", "open", []],
    ["Villa A 15-20 Haziran kapalı değil", "open", []],
    ["Villa A 15-20 Haziran rezervasyon", "reserve", ["guest_name_missing"]],
    // v5: "kiralandı" yalnız takvimi kapatır; iptal takvimi açar (yalnız bloklar).
    ["Villa A 15-20 Haziran kiralandı", "close", []],
    ["Villa A 15-20 Haziran opsiyon", "reserve", ["guest_name_missing"]],
    ["Villa A 15-20 Haziran rezervasyon iptal oldu", "open", []],
    ["Villa A 15-20 Haziran iptal, tekrar açalım", "open", []],
  ];

  it("vektörler (olumsuz kalıplar önce)", () => {
    for (const [text, action, extra] of ACTION_VECTORS) {
      const i = one(text);
      expect([text, i.action, i.actionClear, i.flags]).toEqual([
        text,
        action,
        true,
        ["year_inferred", ...extra],
      ]);
    }
  });

  it("opsiyon → beklemede, diğer rezervasyon → onaylı; diğer eylemlerde durum yok", () => {
    expect(one("Villa A 15-20 Haziran opsiyon").reservationStatus).toBe("pending");
    expect(one("Villa A 15-20 Haziran rezervasyon").reservationStatus).toBe("confirmed");
    expect(one("Villa A 15-20 Haziran kapalı").reservationStatus).toBeNull();
  });

  it("soru → eylem yok, question", () => {
    for (const text of [
      "Villa A 15-20 Haziran kapalı mı?",
      "Villa A 15-20 Haziran müsait mi",
      "Villa A 15-20 Haziran boş mu acaba",
    ]) {
      const i = one(text);
      expect([text, i.action, i.flags[0]]).toEqual([text, null, "question"]);
    }
  });

  it("eylem sözcüğü yok → action_missing; çelişen → action_ambiguous", () => {
    expect(one("Villa A 15-20 Haziran").flags).toContain("action_missing");
    const i = one("Villa A 15-20 Haziran kapalı, rezervasyon");
    expect([i.action, i.actionClear]).toEqual([null, false]);
    expect(i.flags).toContain("action_ambiguous");
    expect(one("Villa A 15-20 Haziran iptal kapat").flags).toContain("action_ambiguous");
  });

  it("'acil' ve benzeri sözcükler 'aç' sayılmaz", () => {
    expect(one("Villa A 15-20 Haziran acil").action).toBeNull();
  });
});

describe("villa adı", () => {
  it("ad biçimleri", () => {
    const V: [string, string | null, string[]][] = [
      ["Villa Zeytin 15-20 Haziran kapalı", "Zeytin", []],
      ["Villa Zeytin Evi 15-20 Haziran kapalı", "Zeytin Evi", []],
      ["Zeytin villası 15-20 Haziran kapalı", "Zeytin", []],
      ["villa zeytin'in 15-20 haziran kapalı", "zeytin", []],
      ["Villa 3 10-12 Mayıs kapalı", "3", []],
      ["15-20 Haziran kapalı", null, ["villa_missing"]],
      ["Villa 15-20 Haziran kapalı", null, ["villa_missing"]],
      ["Merhaba villa 15-20 Haziran dolu", null, ["villa_missing"]],
    ];
    for (const [text, name, extra] of V) {
      const i = one(text);
      expect([text, i.villaName, i.flags.filter((f) => f !== "year_inferred")]).toEqual([
        text,
        name,
        extra,
      ]);
    }
  });

  it("ad sözcüğü eylem/ay olamaz", () => {
    expect(one("Villa Zeytin kapalı 15-20 Haziran").villaName).toBe("Zeytin");
    expect(one("Villa Zeytin haziran 15-20 kapalı").villaName).toBe("Zeytin");
  });
});

describe("birden çok öneri", () => {
  it("iki villa, tek aralık → villa başına öneri", () => {
    const items = parse("Villa A ve Villa B 1-5 Ağustos kapalı");
    expect(items.map((i) => [i.villaName, i.checkIn, i.checkOut])).toEqual([
      ["A", "2027-08-01", "2027-08-05"],
      ["B", "2027-08-01", "2027-08-05"],
    ]);
    expect(items.every((i) => i.flags.includes("multiple_items"))).toBe(true);
  });

  it("tek villa, iki aralık → aralık başına öneri", () => {
    const items = parse("Villa A 15-20 Haziran ve 1-5 Temmuz kapalı");
    expect(items.map((i) => [i.villaName, i.checkIn, i.checkOut])).toEqual([
      ["A", "2027-06-15", "2027-06-20"],
      ["A", "2027-07-01", "2027-07-05"],
    ]);
  });

  it("iki villa ve iki aralık aynı cümlede → villa_ambiguous, ad yok", () => {
    const items = parse("Villa A ve Villa B 15-20 Haziran ve 1-5 Temmuz kapalı");
    expect(items).toHaveLength(2);
    for (const i of items) {
      expect(i.villaName).toBeNull();
      expect(i.flags).toContain("villa_ambiguous");
    }
  });

  it("satır ve cümle başına ayrı öneri; sayı içi nokta bölmez", () => {
    const items = parse(
      "Villa A 15-20 Haziran kapalı. Villa B 01.07-05.07 dolu\nVilla C 10-15 Ağustos açalım",
    );
    expect(items.map((i) => [i.villaName, i.action, i.checkIn])).toEqual([
      ["A", "close", "2027-06-15"],
      ["B", "close", "2027-07-01"],
      ["C", "open", "2027-08-10"],
    ]);
    expect(items[0]!.excerpt).toBe("Villa A 15-20 Haziran kapalı");
  });

  it("en fazla WA_CALENDAR_MAX_ITEMS öneri", () => {
    const text = Array.from({ length: 15 }, (_, k) => `Villa A ${k + 1}-${k + 2} Mart kapalı`).join(
      "\n",
    );
    expect(parse(text)).toHaveLength(WA_CALENDAR_MAX_ITEMS);
  });
});

describe("tarih olmayan sayılar ve sohbet", () => {
  it("fiyat, telefon, saat ve sohbet mesajı öneri üretmez", () => {
    for (const text of [
      "Merhaba, nasılsınız?",
      "Haziran fiyatı 15-20 bin TL",
      "Gecelik 25.000 TL, depozito 1.500",
      "Tel: 0532 111 22 33",
      "+90 532 111 22 33 numarasını arayın",
      "0532.111.22.33",
      "Havuz temizliği 14.30'da",
      "Toplam 12.500,50 TL ödendi",
      "Villa A çok güzel",
    ]) {
      expect([text, parse(text)]).toEqual([text, []]);
    }
  });

  it("tarihle birlikte geçen tutar yıl veya tarih sayılmaz", () => {
    const i = one("Villa A 15-20 Haziran kapalı, fiyat 2500 TL");
    expect([i.checkIn, i.checkOut]).toEqual(["2027-06-15", "2027-06-20"]);
    const j = one("Villa A 20 Haziran 2050 TL kapora alındı kapalı");
    expect(j.checkIn).toBe("2027-06-20");
    expect(j.flags).toContain("year_inferred");
    expect(one("Villa A 15-20 Haziran kapalı, 25.000 TL").checkOut).toBe("2027-06-20");
  });
});

describe("Türkçe katlama", () => {
  it("uzunluk korunur, Türkçe harfler ASCII olur", () => {
    const s = "İĞÜŞÖÇ ığüşöç Villa’nın AĞUSTOS";
    expect(foldTr(s)).toBe("igusoc igusoc villa'nin agustos");
    expect(foldTr(s)).toHaveLength(s.length);
    expect(foldTr("👍 Villa")).toHaveLength("👍 Villa".length);
  });
});

describe("villa eşleme", () => {
  const VILLAS = [
    { id: "a", name: "Villa A" },
    { id: "b", name: "Villa B" },
    { id: "z", name: "Villa Zeytin Evi", aliases: ["zeytinlik"] },
    { id: "d1", name: "Deniz Villa" },
    { id: "d2", name: "Deniz Yıldızı" },
    { id: "s", name: "Villa Şükran" },
  ];

  it("anahtar: katlanmış, 'villa' ve ekler atılmış", () => {
    expect(villaKey("Villa Zeytin Evi")).toBe("zeytin evi");
    expect(villaKey("VİLLA ŞÜKRAN'ın")).toBe("sukran");
  });

  it("tam ad, takma ad, baş sözcük ve belirsizlik", () => {
    expect(matchVillaName("A", VILLAS)).toEqual({ kind: "matched", id: "a" });
    expect(matchVillaName("a", VILLAS)).toEqual({ kind: "matched", id: "a" });
    expect(matchVillaName("Zeytin", VILLAS)).toEqual({ kind: "matched", id: "z" });
    expect(matchVillaName("zeytinlik", VILLAS)).toEqual({ kind: "matched", id: "z" });
    expect(matchVillaName("sukran", VILLAS)).toEqual({ kind: "matched", id: "s" });
    // Tam eşleşme ("Deniz Villa") baş sözcük eşleşmesinden ("Deniz Yıldızı") önce gelir.
    expect(matchVillaName("Deniz", VILLAS)).toEqual({ kind: "matched", id: "d1" });
    expect(matchVillaName("Zeytin", [...VILLAS, { id: "z2", name: "Zeytin Konak" }])).toEqual({
      kind: "ambiguous",
      ids: ["z", "z2"],
    });
    expect(
      matchVillaName("A", [...VILLAS, { id: "a2", name: "Diğer", aliases: ["Villa A"] }]),
    ).toEqual({ kind: "ambiguous", ids: ["a", "a2"] });
    expect(matchVillaName("C", VILLAS)).toEqual({ kind: "none" });
    expect(matchVillaName("", VILLAS)).toEqual({ kind: "none" });
  });

  it("ayrıştırılan ad eşlenebilir", () => {
    const i = one("Villa Zeytin 15-20 Haziran kapalı");
    expect(matchVillaName(i.villaName!, VILLAS)).toEqual({ kind: "matched", id: "z" });
  });
});

describe("güven puanı", () => {
  it("bileşenler ve bantlar", () => {
    const all = {
      villa: "named" as const,
      datesExplicit: true,
      actionClear: true,
      senderVerified: true,
      conflictFree: true,
    };
    expect(scoreProposal(all)).toBe(100);
    expect(scoreProposal({ ...all, villa: "single" })).toBe(95);
    expect(scoreProposal({ ...all, senderVerified: false })).toBe(85);
    expect(scoreProposal({ ...all, conflictFree: false, senderVerified: false })).toBe(75);
    expect(scoreProposal({ ...all, villa: "none" })).toBe(70);
    expect(scoreProposal({ ...all, villa: "ambiguous", datesExplicit: false })).toBe(45);
    expect([confidenceBand(100), confidenceBand(85), confidenceBand(84)]).toEqual([
      "high",
      "high",
      "medium",
    ]);
    expect([confidenceBand(60), confidenceBand(59), confidenceBand(0)]).toEqual([
      "medium",
      "low",
      "low",
    ]);
  });

  it("dört örnek, doğrulanmış gönderen ve çakışmasız → 100", () => {
    for (const text of [
      "Villa A 15-20 Haziran kapalı.",
      "Villa B 5 Temmuz giriş, 12 Temmuz çıkış rezervasyon aldı.",
      "Villa C'nin 10-15 Ağustos tarihlerini tekrar açalım.",
      "Villa D'nin 20-25 Eylül tarihleri müsait değil.",
    ]) {
      const i = one(text);
      const score = scoreProposal({
        villa: "named",
        datesExplicit: i.datesExplicit,
        actionClear: i.actionClear,
        senderVerified: true,
        conflictFree: true,
      });
      expect([text, score]).toEqual([text, 100]);
    }
  });
});

describe("sözleşme", () => {
  it("sabitler ve sürüm", () => {
    expect(WA_CALENDAR_ACTIONS).toEqual(["close", "reserve", "open", "cancel", "change"]);
    expect(new Set(WA_CALENDAR_FLAGS).size).toBe(WA_CALENDAR_FLAGS.length);
    expect(WA_CALENDAR_PARSER_VERSION).toBe(6);
    expect(parseCalendarMessage("", TODAY)).toEqual({ parserVersion: 6, items: [] });
  });

  it("bayraklar her zaman WA_CALENDAR_FLAGS sırasıyla ve tekil", () => {
    const i = one("Villa A 15 Kasım rezervasyon opsiyon");
    const order = i.flags.map((f) => WA_CALENDAR_FLAGS.indexOf(f));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(i.flags).size).toBe(i.flags.length);
  });

  it("uzun alıntı kısaltılır", () => {
    const i = one(`Villa A 15-20 Haziran kapalı ${"x".repeat(800)}`);
    expect(i.excerpt).toHaveLength(500);
  });
});

// ---------------------------------------------------------------------------------------------
// Sürüm 2 regresyon testleri (senaryo değerlendirmesinde bulunan hatalar)
// ---------------------------------------------------------------------------------------------

describe("v2 kritik: varlık olumsuzlaması asla rezervasyon değildir", () => {
  it("'misafir yok', 'rezervasyon yok', 'kimse gelmeyecek' → eylem belirsiz", () => {
    for (const text of [
      "Villa Mavi 12-18 Temmuz misafir yok",
      "Villa Mavi 12-18 Temmuz rezervasyon yok, açın",
      "Villa Mavi 12-18 Temmuz misafir gelmedi",
      "Villa Mavi 12-18 Temmuz misafirimiz yok kapalı",
    ]) {
      const i = one(text);
      expect([text, i.action, i.actionClear, i.reservationStatus]).toEqual([
        text,
        null,
        false,
        null,
      ]);
      expect(i.flags, text).toContain("action_ambiguous");
      expect(i.flags, text).not.toContain("guest_name_missing");
    }
  });

  it("v5: 'kimse gelmeyecek', 'misafir gelmiyor' takvimi açar (yalnız bloklar)", () => {
    expect(one("Villa Mavi 12-18 Temmuz kimse gelmeyecek").action).toBe("open");
    expect(one("Villa Mavi 12-18 Temmuz misafir gelmiyor").action).toBe("open");
  });

  it("v5: 'misafir var' takvimi kapatır; çıplak 'misafir' yine rezervasyondur (⚠️)", () => {
    expect(one("Villa Mavi 12-18 Temmuz misafir var").action).toBe("close");
    expect(one("Villa Mavi 12-18 Temmuz misafir").action).toBe("reserve");
  });
});

describe("v2 kritik: 'dahil' bitiş günü", () => {
  it("2 Temmuz - 9 Temmuz dahil → çıkış 10 Temmuz, end_inclusive", () => {
    const i = one("Villa Mavi 2 Temmuz - 9 Temmuz dahil kapalı");
    expect([i.action, i.checkIn, i.checkOut, i.nights]).toEqual([
      "close",
      "2027-07-02",
      "2027-07-10",
      8,
    ]);
    expect(i.flags).toEqual(["year_inferred", "end_inclusive"]);
  });

  it("aynı ay, sayısal aralık ve yıl dönümünde de çalışır", () => {
    expect(one("Villa Mavi 2-9 Temmuz dahil kapalı").checkOut).toBe("2027-07-10");
    expect(one("Villa Mavi 2-9 Temmuz'da dahil kapalı").checkOut).toBe("2027-07-10");
    expect(one("Villa Mavi 12-18.07 dahil kapalı").checkOut).toBe("2027-07-19");
    const y = one("Villa Mavi 28 Aralık - 31 Aralık dahil kapalı");
    expect([y.checkIn, y.checkOut]).toEqual(["2026-12-28", "2027-01-01"]);
  });

  it("tarihe bitişik olmayan 'dahil' (temizlik dahil) etkisizdir", () => {
    const i = one("Villa Mavi 15-20 Haziran kapalı, temizlik dahil");
    expect([i.checkOut, i.flags]).toEqual(["2027-06-20", ["year_inferred"]]);
  });

  it("'dahil' olmayan aralık değişmez: [giriş, çıkış)", () => {
    expect(one("Villa Mavi 2 Temmuz - 9 Temmuz kapalı").checkOut).toBe("2027-07-09");
  });
});

describe("v2 kritik: tarih değişikliği iki rezervasyon değildir", () => {
  it("v6: '15-20 Haziran'dan 16-21 Haziran'a alındı' → tarih değiştirme (eski + yeni aralık)", () => {
    const items = parse("Villa Mavi rezervasyonu 15-20 Haziran'dan 16-21 Haziran'a alındı");
    expect(items).toHaveLength(1);
    const i = items[0]!;
    expect([i.action, i.villaName, i.oldCheckIn, i.oldCheckOut, i.checkIn, i.checkOut]).toEqual([
      "change",
      "Mavi",
      "2027-06-15",
      "2027-06-20",
      "2027-06-16",
      "2027-06-21",
    ]);
    expect(i.actionClear).toBe(true);
    expect(i.flags).toEqual(["year_inferred"]);
    expect(i.datesExplicit).toBe(true);
    expect(i.excerpt).toContain("15-20 Haziran'dan");
  });

  it("değişiklik sözcükleri tek aralıkla da tanınır", () => {
    for (const text of [
      "Villa Mavi rezervasyonu 16-21 Haziran'a kaydırıldı",
      "Villa Mavi rezervasyon tarihleri değişti 16-21 Haziran",
    ]) {
      const items = parse(text);
      expect([text, items.length, items[0]!.action]).toEqual([text, 1, null]);
      expect(items[0]!.flags, text).toContain("date_change");
    }
    // v6: iki aralık varsa tarih değiştirmedir.
    const c = parse("Villa Mavi 15-20 Haziran rezervasyonu ertelendi, 1-6 Temmuz")[0]!;
    expect([c.action, c.oldCheckIn, c.checkIn]).toEqual(["change", "2027-06-15", "2027-07-01"]);
  });

  it("'den … 'e bağlamı olmayan birden çok aralık yine ayrı önerilerdir", () => {
    expect(parse("Villa Mavi 1-8 Ağustos, 15-22 Ağustos ve 1-5 Eylül dolu")).toHaveLength(3);
    // İki gün "…'dan …'a" bir aralıktır, değişiklik değil.
    const i = one("Villa Asya'yı 20 Ağustos'tan 27 Ağustos'a kadar kapatın");
    expect([i.action, i.checkIn, i.checkOut]).toEqual(["close", "2027-08-20", "2027-08-27"]);
  });
});

describe("v2 tarih: tahmin yok", () => {
  it("'12-18.07' ve '12-18/07/2027' ayı ortak aralıktır", () => {
    const i = one("Villa Mavi 12-18.07 kapalı");
    expect([i.checkIn, i.checkOut, i.flags]).toEqual([
      "2027-07-12",
      "2027-07-18",
      ["year_inferred"],
    ]);
    const j = one("Villa Mavi 12-18/07/2027 dolu");
    expect([j.checkIn, j.checkOut, j.flags]).toEqual(["2027-07-12", "2027-07-18", []]);
  });

  it("eşleşmeyen aralık başı ('12-' + tarih) → date_ambiguous, tek gün tahmini yok", () => {
    const i = one("Villa Mavi 12-18 7.ay kapalı 3-18.13");
    expect([i.checkIn, i.checkOut]).toEqual([null, null]);
    const j = one("Villa Mavi 12 - 18 Temmuz 20 kapalı");
    expect(j.checkIn).toBe("2027-07-12");
  });

  it("'1.5 hafta', '2.5 gün', '15.6' tarih değildir", () => {
    for (const text of [
      "Villa Mavi 1.5 hafta kapalı",
      "Villa Mavi 2.5 gün kapalı",
      "Villa Mavi 3.5 kişi kapasite kapalı",
      "Villa Mavi 15.6 kapalı",
    ]) {
      const i = one(text);
      expect([text, i.checkIn, i.checkOut, i.flags]).toEqual([text, null, null, ["date_missing"]]);
    }
    expect(parse("Villa Mavi 1.5 hafta")).toEqual([]);
  });

  it("'saat 10.06' tarih değildir; aynı mesajdaki gerçek tarih korunur", () => {
    expect(parse("Villa Mavi saat 10.06'da temizlik")).toEqual([]);
    expect(parse("Villa Mavi saat 10.00")).toEqual([]);
    const i = one("Villa Mavi saat 10.00'da 15-20 Haziran kapalı");
    expect([i.villaName, i.checkIn, i.checkOut]).toEqual(["Mavi", "2027-06-15", "2027-06-20"]);
  });

  it("sayısal tarihler yerinde kalır", () => {
    expect(one("Villa Mavi 15.06-20.06 kapalı").checkIn).toBe("2027-06-15");
    expect(one("Villa Mavi 15/6-20/6 kapalı").checkOut).toBe("2027-06-20");
  });
});

describe("v2 villa adı: eylemden ayrı ayrıştırılır", () => {
  it("'villa lazım', 'villa var mı', 'villa için' ad üretmez", () => {
    for (const text of [
      "1-5 Mayıs'ta 10 kişilik grup için villa lazım",
      "villa lazım 15-20 Haziran",
      "15-20 Haziran villa kiralık kapalı",
    ]) {
      const i = one(text);
      expect([text, i.villaName]).toEqual([text, null]);
      expect(i.flags, text).toContain("villa_missing");
    }
  });

  it("'Villa Mavi saat …' → yalnız 'Mavi'; ikinci sözcük büyük harfle başlıyorsa ada eklenir", () => {
    expect(one("Villa Mavi saat 10.00'da 15-20 Haziran kapalı").villaName).toBe("Mavi");
    expect(one("Villa Mavi temizlik 15-20 Haziran kapalı").villaName).toBe("Mavi");
    expect(one("Villa Zeytin Evi 15-20 Haziran kapalı").villaName).toBe("Zeytin Evi");
    expect(one("VİLLA ZEYTİN EVİ 15-20 HAZİRAN KAPALI").villaName).toBe("ZEYTİN EVİ");
  });

  it("villa adındaki sözcük eylem sayılmaz", () => {
    // Ad konumundaki metin eylem tanımadan çıkarılır: "Villa Dolunay" kapatma ("dolu") değildir.
    const j = one("Villa Dolunay 15-20 Haziran açalım");
    expect([j.villaName, j.action, j.flags]).toEqual(["Dolunay", "open", ["year_inferred"]]);
    // Tek başına eylem sözcüğü ad olamaz: "Villa Kapalı …" → ad yok, eylem kapatma.
    const k = one("Villa kapalı 15-20 Haziran");
    expect([k.villaName, k.action]).toEqual([null, "close"]);
  });
});

describe("v2 güvenlik: puan güvenlik kurallarını aşamaz", () => {
  const ok = { villa: "named" as const, senderRole: "owner" as const, conflictFree: true };

  it("yalnız 'close', (Aşama 2) 'open' ve (v6) 'change' doğrudan uygulanabilir", () => {
    expect(WA_QUICK_APPROVE_ACTIONS).toEqual(["close", "open", "change"]);
    const d = reviewRequirement(one("Villa A 15-20 Haziran kapalı."), ok);
    expect(d).toEqual({ quickApprove: true, score: 100, band: "high", reasons: [] });
    const o = reviewRequirement(one("Villa C'nin 10-15 Ağustos tarihlerini tekrar açalım."), ok);
    expect(o).toEqual({ quickApprove: true, score: 100, band: "high", reasons: [] });
  });

  it("rezervasyon (giriş/çıkış, opsiyon), puan 100 olsa bile elle incelenir", () => {
    for (const text of [
      "Villa B 5 Temmuz giriş, 12 Temmuz çıkış",
      "Villa B 5-12 Temmuz opsiyonlu rezervasyon alındı",
    ]) {
      const i = one(text);
      const d = reviewRequirement(i, ok);
      expect([text, d.quickApprove]).toEqual([text, false]);
      expect(d.reasons, text).toContain("action_requires_review");
    }
  });

  it("v5: 'rezervasyonu iptal oldu' açmadır ve hızlı uygulanabilir (yalnız bloklar)", () => {
    const i = one("Villa Lavanta 14-21 Temmuz rezervasyonu iptal oldu");
    expect(i.action).toBe("open");
    expect(reviewRequirement(i, ok)).toMatchObject({ quickApprove: true, score: 100 });
  });

  it("belirsiz ve riskli öneriler elle incelenir", () => {
    const cases: [string, string][] = [
      ["Villa Mavi 12-18 Temmuz misafir yok", "no_action"],
      ["Villa Mavi rezervasyonu 16-21 Haziran'a kaydırıldı", "no_action"],
      ["Villa Mavi 20-25 Temmuz yerine 22-27 Temmuz kapatalım", "no_action"],
      ["Villa Mavi 15 Haziran kapalı", "dates_incomplete"],
      ["Villa Mavi 8-12 Kasım kapalı", "flagged"],
      ["Villa A 5-8 Kasım kapalı", "dates_incomplete"],
    ];
    for (const [text, reason] of cases) {
      const d = reviewRequirement(one(text), ok);
      expect([text, d.quickApprove]).toEqual([text, false]);
      expect(d.reasons, text).toContain(reason);
    }
  });

  it("doğrulanmamış gönderen, çakışma ve çözülemeyen villa tek tıkı engeller", () => {
    const i = one("Villa A 15-20 Haziran kapalı.");
    expect(reviewRequirement(i, { ...ok, senderRole: null }).reasons).toEqual([
      "sender_unverified",
    ]);
    expect(reviewRequirement(i, { ...ok, conflictFree: false }).reasons).toEqual(["conflict"]);
    expect(reviewRequirement(i, { ...ok, villa: "ambiguous" }).reasons).toEqual([
      "villa_unresolved",
      "low_confidence",
    ]);
    // Grupta tek villa: adsız mesajın villa_missing bayrağı çözülmüş sayılır (puan 95).
    const single = reviewRequirement(one("15-20 Haziran kapalı"), { ...ok, villa: "single" });
    expect([single.quickApprove, single.score, single.reasons]).toEqual([true, 95, []]);
    // Ama villa çözülemiyorsa aynı mesaj elle incelenir.
    expect(
      reviewRequirement(one("15-20 Haziran kapalı"), { ...ok, villa: "none" }).reasons,
    ).toEqual(["flagged", "villa_unresolved", "low_confidence"]);
  });
});

describe("gönderen rolü (A2 politikası)", () => {
  const base = { villa: "named" as const, conflictFree: true };
  const close = () => parseCalendarMessage("Villa A 15-20 Haziran kapalı.", TODAY).items[0]!;

  it("owner ve manager doğrulanmış gönderendir: nedensiz kapatma tek tıkla onaylanabilir", () => {
    for (const senderRole of ["owner", "manager"] as const) {
      expect(reviewRequirement(close(), { ...base, senderRole })).toEqual({
        quickApprove: true,
        score: 100,
        band: "high",
        reasons: [],
      });
    }
  });

  // B aşaması: bağlı grubun engellenmemiş her katılımcısı yetkilidir; rol yalnız bilgi amaçlıdır.
  it.each(["staff", "participant"] as const)(
    "%s: yetkili gönderen; ek inceleme nedeni yok (B aşaması)",
    (role) => {
      const d = reviewRequirement(close(), { ...base, senderRole: role });
      expect(d.quickApprove).toBe(true);
      expect(d.reasons).toEqual([]);
      expect(d.reasons).not.toContain("staff_review_required");
      expect([d.score, d.band]).toEqual([100, "high"]);
    },
  );

  it("rolsüz gönderen (savunma): sender_unverified", () => {
    expect(reviewRequirement(close(), { ...base, senderRole: null }).reasons).toContain(
      "sender_unverified",
    );
  });
});

describe("grup dışı villa (A2b)", () => {
  const base = { villa: "named" as const, senderRole: "owner" as const, conflictFree: true };
  const close = () => one("Villa A 15-20 Haziran kapalı.");

  it("villaOutsideGroup: puan 100 olsa bile villa_needs_review ile elle incelenir", () => {
    const d = reviewRequirement(close(), { ...base, villaOutsideGroup: true });
    expect(d).toEqual({
      quickApprove: false,
      score: 100,
      band: "high",
      reasons: ["villa_needs_review"],
    });
  });

  it("alan verilmezse veya false ise davranış değişmez", () => {
    expect(reviewRequirement(close(), base).quickApprove).toBe(true);
    expect(reviewRequirement(close(), { ...base, villaOutsideGroup: false }).quickApprove).toBe(
      true,
    );
  });

  it("diğer nedenlerle birlikte de kalır (katılımcı + grup dışı)", () => {
    const d = reviewRequirement(close(), {
      ...base,
      senderRole: "participant",
      villaOutsideGroup: true,
    });
    expect(d.reasons).toEqual(["villa_needs_review"]);
    const n = reviewRequirement(close(), { ...base, senderRole: null, villaOutsideGroup: true });
    expect(n.reasons).toEqual(["villa_needs_review", "sender_unverified"]);
  });

  it("ayrıştırıcı sürümü 6", () => {
    expect(WA_CALENDAR_PARSER_VERSION).toBe(6);
  });
});

describe("kişi sayısı (onay formu ön doldurma)", () => {
  it.each([
    ["Villa 15 Kasım giriş, 18 Kasım çıkış, 4 kişi.", { adults: 4, children: null, total: 4 }],
    ["2 yetişkin 1 çocuk", { adults: 2, children: 1, total: 3 }],
    ["6 kişilik aile", { adults: 6, children: null, total: 6 }],
    ["12 kişiyiz", { adults: 12, children: null, total: 12 }],
    ["5 kişi 2 çocuk", { adults: 3, children: 2, total: 5 }],
    ["3 pax", { adults: 3, children: null, total: 3 }],
    ["4 MİSAFİR", { adults: 4, children: null, total: 4 }],
  ])("%s", (text, expected) => {
    expect(parseGuestCount(text)).toEqual(expected);
  });

  it.each(["15-20 Haziran 3.500 EUR", "Villa Mavi 3-8 Temmuz kapalı", "1.5 kişi", "99 kişi", ""])(
    "sayı yok veya geçersiz: %s",
    (text) => {
      expect(parseGuestCount(text)).toEqual({ adults: null, children: null, total: null });
    },
  );
});
