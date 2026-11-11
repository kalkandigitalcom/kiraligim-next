/**
 * Ayrıştırıcı v6 — tarih değiştirme (action = "change"): eski ve yeni aralık, merkezi tarih
 * modülüyle (wa-date-parse.ts). Uçtan uca karar zinciri: ayrıştırma → öneri öğesi → otomatik
 * değiştirme uygunluğu. Veritabanı davranışı: tests/integration/wa-auto-change.test.ts.
 */
import { describe, expect, it } from "vitest";

import { parseCalendarMessage } from "@/lib/wa-calendar-parse";
import {
  autoChangeCandidate,
  autoCloseCandidate,
  autoOpenCandidate,
} from "@/server/whatsapp/calendar/auto-close-rule";
import { buildStoreItem } from "@/server/whatsapp/calendar/proposal";
import { decideReaction } from "@/server/whatsapp/calendar/reaction";
import { resolveProposal } from "@/server/whatsapp/calendar/resolve";

const TODAY = "2026-11-11";
const CTX = {
  workspaceId: "w",
  villas: [
    { id: "mavi", workspaceId: "w", name: "Villa Mavi" },
    { id: "asya", workspaceId: "w", name: "Villa Asya" },
  ],
  groupPropertyId: "mavi",
};
const RULE = { senderRole: "participant" as const, groupPropertyId: "mavi" };

function run(message: string, today = TODAY) {
  const items = parseCalendarMessage(message, today).items.map((item, i) =>
    buildStoreItem({
      item,
      itemNo: i,
      villa: resolveProposal(item, CTX),
      busy: [],
      senderRole: "participant",
    }),
  );
  const change = autoChangeCandidate(items, RULE);
  const other = autoCloseCandidate(items, RULE) ?? autoOpenCandidate(items, RULE);
  const rx = decideReaction({ senderRole: "participant", items, stored: items.length });
  return {
    items,
    change: change
      ? {
          old: [change.old_check_in, change.old_check_out],
          new: [change.check_in, change.check_out],
        }
      : null,
    other,
    // Otomatik işlem denenmezse (veya başarısızsa) tepki: ⚠️ ya da yok.
    reactionIfNotApplied: rx === "warning" ? "⚠️" : rx === null ? "yok" : rx,
  };
}

const JUL = (a: number, b: number) => [`2027-07-${a}`, `2027-07-${b}`];

describe("istenen örnekler (20-25 Temmuz)", () => {
  it.each([
    ["20-25 Temmuz rezervasyonu 20-26 Temmuz olarak değiştirilmiştir.", JUL(20, 26)],
    ["20-25 Temmuz yerine 20-26 Temmuz olacak.", JUL(20, 26)],
    ["20-25 Temmuz rezervasyonunu 22-27 Temmuz'a aldık.", JUL(22, 27)],
    ["20-25 Temmuz olan rezervasyon 20-28 Temmuz olarak güncellendi.", JUL(20, 28)],
    ["20-25 Temmuz tarihleri 22-27 Temmuz olarak değiştirildi.", JUL(22, 27)],
    [
      "20 Temmuz giriş 25 Temmuz çıkış olan rezervasyon 22 Temmuz giriş 27 Temmuz çıkış olarak değişti.",
      JUL(22, 27),
    ],
    ["20-25 Temmuz değil, 22-27 Temmuz olacak.", JUL(22, 27)],
    ["Eski rezervasyon tarihleri 20-25 Temmuz, yeni tarihler 22-27 Temmuz.", JUL(22, 27)],
  ])("%s", (m, next) => {
    const r = run(m);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.action).toBe("change");
    expect(r.change).toEqual({ old: JUL(20, 25), new: next });
    expect(r.other).toBeNull();
  });

  it("ay belirtilmemiş yeni aralık eski aralığın ayını alır", () => {
    expect(run("20-25 Temmuz rezervasyonu 20-26 olarak değiştirilmiştir.").change).toEqual({
      old: JUL(20, 25),
      new: JUL(20, 26),
    });
    expect(run("20-25 Temmuz rezervasyonu 22-27'ye alındı").change).toEqual({
      old: JUL(20, 25),
      new: JUL(22, 27),
    });
    // Ay yazılmamış ESKİ aralık da yeni aralığın ayını alır.
    expect(run("20-25 yerine 22-27 Temmuz olacak").change).toEqual({
      old: JUL(20, 25),
      new: JUL(22, 27),
    });
  });
});

describe("kelime sırası, noktalama ve yazım çeşitleri", () => {
  it.each([
    "20-25 Temmuz rezervasyonu 22-27 Temmuz olarak değiştirildi!!",
    "20 - 25 Temmuz rezervasyonu → 22 - 27 Temmuz olarak değişti",
    "20.07-25.07 rezervasyonu 22.07-27.07 olarak değiştirildi",
    "20/07 - 25/07 rezervasyonu 22/07 - 27/07 olarak güncellendi",
    "Villa Mavi 20-25 Temmuz rezervasyonu 22-27 Temmuz olarak değişti",
    "20-25 Temmuz'dan 22-27 Temmuz'a kaydırıldı",
    "20-25 Temmuz rezervasyonu 22-27 Temmuz'a ertelendi",
    "20-25 Temmuz değişti, 22-27 Temmuz",
    "Yeni tarihler 22-27 Temmuz, eski tarihler 20-25 Temmuz",
    "Eski: 20-25 Temmuz. Yeni: 22-27 Temmuz",
    "22-27 Temmuz, 20-25 Temmuz yerine",
    "REZERVASYON 20-25 TEMMUZ'DAN 22-27 TEMMUZ'A ALINDI",
    "rezervasyon 20-25 temmuz yerine 22-27 temmuz olacak",
    "20-25 Temmuz rezervasyonu 22-27 Temmuz'a alındı, 4 kişi",
  ])("%s", (m) => {
    expect(run(m).change).toEqual({ old: JUL(20, 25), new: JUL(22, 27) });
  });

  it("farklı aylar arasında", () => {
    expect(run("28 Temmuz - 2 Ağustos rezervasyonu 5-10 Ağustos'a alındı").change).toEqual({
      old: ["2027-07-28", "2027-08-02"],
      new: ["2027-08-05", "2027-08-10"],
    });
    expect(run("20-25 Temmuz rezervasyonu 1-5 Ağustos olarak değişti").change).toEqual({
      old: JUL(20, 25),
      new: ["2027-08-01", "2027-08-05"],
    });
  });

  it("yıl değişimi", () => {
    expect(run("28 Aralık - 2 Ocak rezervasyonu 3-8 Ocak olarak değişti").change).toEqual({
      old: ["2026-12-28", "2027-01-02"],
      new: ["2027-01-03", "2027-01-08"],
    });
    expect(run("20-25 Aralık rezervasyonu 5-10 Ocak'a alındı").change).toEqual({
      old: ["2026-12-20", "2026-12-25"],
      new: ["2027-01-05", "2027-01-10"],
    });
  });

  it("'dahil' yeni aralığın çıkışını bir gün ileri alır", () => {
    expect(run("20-25 Temmuz rezervasyonu 22-27 Temmuz (27 dahil) olarak değişti").change).toEqual({
      old: JUL(20, 25),
      new: JUL(22, 28),
    });
  });
});

describe("olumsuz ifadeler: öneri ve tepki yok", () => {
  it.each([
    "20-25 Temmuz rezervasyonunu 22-27 Temmuz olarak değiştirmeyelim",
    "20-25 Temmuz rezervasyonu 22-27 Temmuz'a değiştirilmedi",
    "20-25 Temmuz rezervasyonu değişmedi",
    "20-25 Temmuz rezervasyonu 22-27 Temmuz'a kaydırmayın",
    "20-25 Temmuz rezervasyonu ertelenmeyecek",
  ])("%s", (m) => {
    expect(run(m).items).toEqual([]);
  });

  it("'değiştirmemiz lazım' olumsuz değildir", () => {
    expect(
      run("20-25 Temmuz rezervasyonunu 22-27 Temmuz olarak değiştirmemiz lazım").change,
    ).toEqual({ old: JUL(20, 25), new: JUL(22, 27) });
  });
});

describe("belirsiz veya çelişkili: işlem yok (⚠️)", () => {
  it.each([
    "20-25 Temmuz rezervasyonu 22-27 Temmuz ve 1-5 Ağustos olarak değişti", // üç aralık
    "20-25 Temmuz yerine 20-25 Temmuz olacak", // aynı tarihler
    "20-25 Temmuz rezervasyonu 1-5 Kasım olarak değişti", // yeni aralık geçmişte
    "1-5 Kasım rezervasyonu 22-27 Temmuz olarak değişti", // eski aralık geçmişte/belirsiz yıl
    "20-25 Temmuz rezervasyonu hafta sonuna alındı", // belirsiz yeni tarih
    "20-25 Temmuz rezervasyonu 25-20 Ağustos olarak değişti", // ters aralık
    "20-25 Temmuz rezervasyonu 28-31 Haziran olarak değişti", // takvimde olmayan gün
    "20-25 Temmuz rezervasyonu 22 Temmuz olarak değişti", // tek tarih
    "20-25 Temmuz yerine 22-27 Temmuz kapatalım", // kapat + değiştir: çelişkili
    "20-25 Temmuz rezervasyonu 22-27 Temmuz'a alındı, kapatalım",
  ])("%s", (m) => {
    const r = run(m);
    expect(r.change).toBeNull();
    expect(r.other).toBeNull();
    expect(r.reactionIfNotApplied).toBe("⚠️");
  });

  it("soru işlem değildir: tepki yok", () => {
    const r = run("20-25 Temmuz rezervasyonu 22-27 Temmuz olarak değişti mi?");
    expect(r.change).toBeNull();
    expect(r.reactionIfNotApplied).toBe("yok");
  });

  it("tek aralıklı değişiklik bildirimi değiştirme değildir (⚠️)", () => {
    const r = run("Rezervasyon 22-27 Temmuz'a kaydırıldı");
    expect(r.items[0]!.action).toBeNull();
    expect(r.items[0]!.flags).toContain("date_change");
    expect(r.reactionIfNotApplied).toBe("⚠️");
  });
});

describe("mevcut komutlar değişmez", () => {
  it.each([
    ["20-25 Temmuz kapatalım", "close"],
    ["20-25 Temmuz kiralandı", "close"],
    ["20-25 Temmuz rezervasyon alındı", "close"],
    ["20-25 Temmuz rezervasyon iptal oldu", "open"],
    ["20-25 Temmuz tekrar müsait", "open"],
    ["10-15 Aralık değil, Ocak kapatalım", "close"],
    ["20-25 Temmuz ve 1-5 Ağustos kapalı olacak", null],
  ])("%s", (m, action) => {
    const r = run(m);
    expect(r.change).toBeNull();
    if (action) expect(r.other?.action).toBe(action);
    else expect(r.other).toBeNull();
  });

  it("'X değil Y' düzeltmesi kapatma komutunda düzeltme olarak kalır", () => {
    expect(run("10-15 Aralık değil, Ocak kapatalım").other).toMatchObject({
      check_in: "2027-01-10",
      check_out: "2027-01-15",
    });
  });
});

describe("yetki ve grup kuralları aynen geçerli", () => {
  it("yetkisiz gönderen veya villasız grup → aday yok", () => {
    const { items } = run("20-25 Temmuz rezervasyonu 22-27 Temmuz olarak değişti");
    expect(autoChangeCandidate(items, { senderRole: null, groupPropertyId: "mavi" })).toBeNull();
    expect(
      autoChangeCandidate(items, { senderRole: "participant", groupPropertyId: null }),
    ).toBeNull();
  });

  it("öğe veritabanı alan adlarıyla eski aralığı taşır; diğer eylemlerde alan yok", () => {
    const [c] = run("20-25 Temmuz rezervasyonu 22-27 Temmuz olarak değişti").items;
    expect(c).toMatchObject({
      action: "change",
      old_check_in: "2027-07-20",
      old_check_out: "2027-07-25",
      check_in: "2027-07-22",
      check_out: "2027-07-27",
      review_reasons: [],
    });
    const [k] = run("20-25 Temmuz kapatalım").items;
    expect(k).not.toHaveProperty("old_check_in");
  });
});
