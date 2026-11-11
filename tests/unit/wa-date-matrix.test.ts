/**
 * Merkezi tarih ayrıştırma (src/lib/wa-date-parse.ts) — uçtan uca karar zinciri:
 * ayrıştırma → öneri öğesi → otomatik kapatma/açma uygunluğu → tepki.
 *
 * Temel kural: tarih yanlış anlaşılacaksa işlem YAPILMAZ (⚠️ + açıklama sorusu); açık tarihler
 * gereksiz yere reddedilmez.
 */
import { describe, expect, it } from "vitest";

import { parseCalendarMessage } from "@/lib/wa-calendar-parse";
import { dateClarification } from "@/lib/wa-date-parse";
import { autoCloseCandidate, autoOpenCandidate } from "@/server/whatsapp/calendar/auto-close-rule";
import { buildStoreItem, type StoreItem } from "@/server/whatsapp/calendar/proposal";
import { decideReaction } from "@/server/whatsapp/calendar/reaction";
import { resolveProposal } from "@/server/whatsapp/calendar/resolve";

import { CASES } from "./helpers/wa-date-matrix-cases";

const CTX = {
  workspaceId: "w",
  villas: [
    { id: "mavi", workspaceId: "w", name: "Villa Mavi" },
    { id: "asya", workspaceId: "w", name: "Villa Asya" },
  ],
  groupPropertyId: "mavi",
};
const RULE = { senderRole: "participant" as const, groupPropertyId: "mavi" };

type Outcome = {
  items: StoreItem[];
  act: "E" | "H";
  action: string | null;
  checkIn: string | null;
  checkOut: string | null;
  reply: "✅" | "⚠️" | "tepki yok";
};

function run(message: string, today: string): Outcome {
  const parsed = parseCalendarMessage(message, today);
  const items = parsed.items.map((item, i) =>
    buildStoreItem({
      item,
      itemNo: i,
      villa: resolveProposal(item, CTX),
      busy: [],
      senderRole: "participant",
    }),
  );
  const cand = autoCloseCandidate(items, RULE) ?? autoOpenCandidate(items, RULE);
  const rx = decideReaction({
    senderRole: "participant",
    items,
    stored: items.length,
    ...(cand ? { autoClose: "applied" as const } : {}),
  });
  const one = items.length === 1 ? items[0]! : null;
  return {
    items,
    act: cand ? "E" : "H",
    action: one?.action ?? null,
    checkIn: one?.check_in ?? null,
    checkOut: one?.check_out ?? null,
    reply: rx === "done" ? "✅" : rx === "warning" ? "⚠️" : "tepki yok",
  };
}

const replyKind = (r: string) =>
  r.startsWith("✅") ? "✅" : r.startsWith("⚠️") ? "⚠️" : "tepki yok";

describe("tarih matrisi (225 senaryo, bugün 11.11.2026)", () => {
  it("senaryo sayısı", () => {
    expect(CASES.length).toBe(225);
  });

  it.each(CASES.map((c) => [c[7], c[0], c] as const))("%s · %s", (_cat, _m, c) => {
    const [message, , ci, co, , act, reply] = c;
    const out = run(message, "2026-11-11");
    // Tehlikeli sonuç: beklenmeyen işlem ya da yanlış tarihte işlem.
    if (out.act === "E") {
      expect(act).toBe("E");
      expect([out.checkIn, out.checkOut]).toEqual([ci, co]);
    }
    expect(out.act).toBe(act);
    expect(out.reply).toBe(replyKind(reply));
  });
});

/** Yalnız işlem + tarih (ve tepki) özeti. */
function decision(message: string, today: string) {
  const o = run(message, today);
  return { act: o.act, action: o.action, ci: o.checkIn, co: o.checkOut, reply: o.reply };
}

describe("farklı yazımlar aynı aralık", () => {
  it.each([
    "Villa Mavi 20-25 Aralık kapatalım",
    "20.12-25.12 kapatalım",
    "20.12.2026-25.12.2026 kapatalım",
    "20/12 - 25/12 kapatalım",
    "20 Aralık - 25 Aralık kapatalım",
    "20 Aralık'tan 25 Aralık'a kadar kapatalım",
    "20 ile 25 Aralık arası kapatalım",
    "Aralık 20-25 kapatalım",
    "20'den 25'e Aralık kapatalım",
  ])("%s", (m) => {
    expect(decision(m, "2026-11-11")).toEqual({
      act: "E",
      action: "close",
      ci: "2026-12-20",
      co: "2026-12-25",
      reply: "✅",
    });
  });
});

describe("ay belirtilmemiş: bu ay, ileride ise", () => {
  it("bugün 3 Şubat: 10-15 → 10-15 Şubat", () => {
    expect(decision("10-15 kapatalım", "2027-02-03")).toMatchObject({
      act: "E",
      ci: "2027-02-10",
      co: "2027-02-15",
    });
  });
  it("Şubat'ta olmayan gün (28-30) işlem yapılmaz", () => {
    expect(decision("28-30 kapatalım", "2027-02-03")).toMatchObject({ act: "H", reply: "⚠️" });
  });
  it("başlangıç geçmişte (bugün 12'si, 10-15) → işlem yok, soru", () => {
    const o = run("10-15 kapatalım", "2026-11-12");
    expect(o.act).toBe("H");
    expect(o.reply).toBe("⚠️");
    expect(
      dateClarification({ checkIn: o.checkIn, checkOut: o.checkOut, flags: o.items[0]!.flags }),
    ).toBeTruthy();
  });
  it("31 Aralık: '20-25' ay yok, geçmiş → işlem yok", () => {
    expect(decision("20-25 kapatalım", "2026-12-31")).toMatchObject({ act: "H" });
  });
  it("31 Aralık: '5-10 Ocak' → gelecek yıl", () => {
    expect(decision("5-10 Ocak kapatalım", "2026-12-31")).toMatchObject({
      act: "E",
      ci: "2027-01-05",
      co: "2027-01-10",
    });
  });
  it("bugün başlayan aralık geçmiş sayılmaz", () => {
    expect(decision("11-14 kapatalım", "2026-11-11")).toMatchObject({
      act: "E",
      ci: "2026-11-11",
      co: "2026-11-14",
    });
  });
});

describe("başlangıç ve bitiş günleri", () => {
  it("'20-25' = 20 giriş, 25 çıkış (5 gece)", () => {
    expect(decision("20-25 Aralık kapatalım", "2026-11-11")).toMatchObject({
      ci: "2026-12-20",
      co: "2026-12-25",
    });
  });
  it("'25 dahil' çıkışı bir gün ileri alır", () => {
    expect(decision("20-25 Aralık (25 dahil) kapatalım", "2026-11-11")).toMatchObject({
      act: "E",
      ci: "2026-12-20",
      co: "2026-12-26",
    });
  });
  it("ay sonu: 28 Şubat - 2 Mart", () => {
    expect(decision("28 Şubat - 2 Mart kapatalım", "2026-11-11")).toMatchObject({
      act: "E",
      ci: "2027-02-28",
      co: "2027-03-02",
    });
  });
  it("yıl geçişi: 28 Aralık - 3 Ocak", () => {
    expect(decision("28 Aralık - 3 Ocak kapatalım", "2026-11-11")).toMatchObject({
      act: "E",
      ci: "2026-12-28",
      co: "2027-01-03",
    });
  });
  it("tersine aralık (25-20 Aralık) işlem yapılmaz", () => {
    const o = run("25-20 Aralık kapatalım", "2026-11-11");
    expect(o.act).toBe("H");
    expect(o.reply).toBe("⚠️");
  });
  it("aynı gün (20-20) işlem yapılmaz", () => {
    expect(decision("20-20 Aralık kapatalım", "2026-11-11")).toMatchObject({ act: "H" });
  });
  it("60 geceden uzun aralık işlem yapılmaz", () => {
    expect(decision("1 Aralık - 15 Şubat kapatalım", "2026-11-11")).toMatchObject({
      act: "H",
      reply: "⚠️",
    });
  });
  it("geçersiz gün (31 Kasım) işlem yapılmaz", () => {
    expect(decision("28-31 Kasım kapatalım", "2026-11-11")).toMatchObject({
      act: "H",
      reply: "⚠️",
    });
  });
});

describe("olumsuz ifadeler", () => {
  it.each([
    "20-25 Aralık kapatmayalım",
    "20-25 Aralık kapatmayın",
    "20-25 Aralık kapatma",
    "20-25 Aralık kapatmamız lazım değil, kapatmayalım",
    "20-25 Aralık açmayalım",
    "20-25 Aralık açmayın",
  ])("%s → işlem yok", (m) => {
    expect(decision(m, "2026-11-11").act).toBe("H");
  });
  it("olumsuz ifade tek başına tepki üretmez", () => {
    expect(decision("20-25 Aralık kapatmayalım", "2026-11-11").reply).toBe("tepki yok");
  });
  it("'kapatmak lazım' olumsuz değildir", () => {
    expect(decision("20-25 Aralık kapatmak lazım", "2026-11-11")).toMatchObject({
      act: "E",
      action: "close",
    });
  });
  it("'açmak istiyoruz' olumsuz değildir", () => {
    expect(decision("20-25 Aralık açmak istiyoruz", "2026-11-11")).toMatchObject({
      act: "E",
      action: "open",
    });
  });
});

describe("düzeltmeler", () => {
  it("'Aralık değil Ocak' aynı günlerle Ocak'a uygulanır", () => {
    expect(decision("10-15 Aralık değil, Ocak kapatalım", "2026-11-11")).toMatchObject({
      act: "E",
      ci: "2027-01-10",
      co: "2027-01-15",
    });
  });
  it("'20-25 değil 21-26 Aralık' ikinci aralık uygulanır", () => {
    expect(decision("20-25 değil 21-26 Aralık kapatalım", "2026-11-11")).toMatchObject({
      act: "E",
      ci: "2026-12-21",
      co: "2026-12-26",
    });
  });
});

describe("tarih olmayan sayılar ve eylemsiz tarihler", () => {
  it.each([
    "Saat 10.15'te kapıyı kapatalım",
    "Kapıyı kapat",
    "Havuz 10-15 dakika sonra temizlenecek",
    "Fiyat 20-25 bin TL",
    "0532 123 45 67 numarayı arayın",
    "Villa 3 de 20-25 kişi kalabilir mi",
  ])("%s → işlem yok", (m) => {
    expect(decision(m, "2026-11-11").act).toBe("H");
  });
  it("eylem var ama tarih yok → ⚠️", () => {
    expect(decision("Villa Mavi takvimi kapatalım", "2026-11-11")).toMatchObject({
      act: "H",
      reply: "⚠️",
    });
  });
  it("'kapıyı kapat' takvim talimatı sayılmaz (tepki yok)", () => {
    expect(decision("Kapıyı kapat", "2026-11-11").reply).toBe("tepki yok");
  });
});

describe("dateClarification (sorulacak metin)", () => {
  it.each([
    [["date_order_reversed"], /Bitiş tarihi/],
    [["date_list"], /tek bir aralık mı/],
    [["date_unclear"], /kesin anlayamadım/],
    [["date_missing"], /anlayamadım/],
    [["date_ambiguous"], /anlayamadım/],
  ])("%j", (flags, re) => {
    expect(dateClarification({ checkIn: null, checkOut: null, flags })).toMatch(re);
  });
  it("geçmiş aralık tarihleri gösterir", () => {
    expect(
      dateClarification({ checkIn: "2026-11-01", checkOut: "2026-11-05", flags: ["date_past"] }),
    ).toMatch(/geçmişte kalıyor/);
  });
  it("sorunsuz aralık için soru yok", () => {
    expect(
      dateClarification({
        checkIn: "2026-12-20",
        checkOut: "2026-12-25",
        flags: ["year_inferred"],
      }),
    ).toBeNull();
  });
  it("soru metninde telefon/misafir bilgisi yok, yalnız tarih", () => {
    const q = dateClarification({
      checkIn: "2026-11-01",
      checkOut: "2026-11-05",
      flags: ["date_past"],
    })!;
    expect(q).not.toMatch(/\d{5,}|\+90|\b0?5\d{2}\b/);
  });
});
