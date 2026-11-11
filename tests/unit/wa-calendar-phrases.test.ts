/**
 * Ayrıştırıcı v5 — günlük dildeki kapatma / açma ifadeleri, uçtan uca karar zinciriyle:
 * ayrıştırma → öneri öğesi → otomatik kapatma/açma uygunluğu → tepki.
 *
 * İş kuralları: "kiralandı / satıldı / rezervasyon alındı" yalnız takvimi KAPATIR (rezervasyon
 * kaydı oluşturulmaz). İptal ifadeleri yalnız AÇIK tarih aralığıyla takvimi AÇAR (yalnız bloklar;
 * gerçek rezervasyon değişmez — auto-open.ts). Olumsuz ifadeler işlem üretmez.
 */
import { describe, expect, it } from "vitest";

import { parseCalendarMessage } from "@/lib/wa-calendar-parse";
import { autoCloseCandidate, autoOpenCandidate } from "@/server/whatsapp/calendar/auto-close-rule";
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

/** İşlem (close/open/null), tarihler ve tepki. */
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
  const closeCand = autoCloseCandidate(items, RULE);
  const openCand = closeCand ? null : autoOpenCandidate(items, RULE);
  const cand = closeCand ?? openCand;
  const rx = decideReaction({
    senderRole: "participant",
    items,
    stored: items.length,
    ...(cand ? { autoClose: "applied" as const } : {}),
  });
  return {
    act: closeCand ? "close" : openCand ? "open" : null,
    ci: cand?.check_in ?? null,
    co: cand?.check_out ?? null,
    reply: rx === "done" ? "✅" : rx === "warning" ? "⚠️" : "yok",
  };
}

const DEC = { ci: "2026-12-20", co: "2026-12-25" };
const closed = { act: "close", ...DEC, reply: "✅" };
const opened = { act: "open", ...DEC, reply: "✅" };
const noAction = (reply: "⚠️" | "yok") => ({ act: null, ci: null, co: null, reply });

describe("istenen senaryolar (20-25 Aralık)", () => {
  it.each([
    ["20-25 Aralık kiralandı", closed],
    ["20-25 Aralık rezervasyon alındı", closed],
    ["20-25 Aralık tarihlerini dolduralım", closed],
    ["20-25 Aralık artık müsait değil", closed],
    ["20-25 Aralık satıldı", closed],
    ["20-25 Aralık tekrar müsait", opened],
    ["20-25 Aralık rezervasyon iptal oldu", opened],
    ["20-25 Aralık tarihlerini serbest bırakalım", opened],
    ["20-25 Aralık kiralanmadı", noAction("yok")],
    ["20-25 Aralık rezervasyon alınmadı", noAction("yok")],
    ["20-25 Aralık kapatmayalım", noAction("yok")],
  ])("%s", (m, want) => {
    expect(run(m)).toEqual(want);
  });
});

describe("kapatma ifadeleri", () => {
  it.each([
    "20-25 Aralık kapat",
    "20-25 Aralık kapatıyoruz",
    "20-25 Aralık doldur",
    "20-25 Aralık dolduralım",
    "20-25 Aralık takvimi dolduralım",
    "20-25 Aralık dolu yap",
    "20-25 Aralık dolu yapalım",
    "20-25 Aralık tarihleri kapat",
    "20-25 Aralık kiralandı",
    "20-25 Aralık villayı kiraladık",
    "20-25 Aralık kiraya verildi",
    "20-25 Aralık kiraya verdik",
    "20-25 Aralık satıldı",
    "20-25 Aralık sattık",
    "20-25 Aralık rezervasyon alındı",
    "20-25 Aralık rezervasyon aldık",
    "20-25 Aralık rezervasyon yapıldı",
    "20-25 Aralık rezervasyon geldi",
    "20-25 Aralık rezervasyon var",
    "20-25 Aralık rezerve edildi",
    "20-25 Aralık misafir aldı",
    "20-25 Aralık misafir aldık",
    "20-25 Aralık misafir gelecek",
    "20-25 Aralık misafirler gelecek",
    "20-25 Aralık misafir var",
    "20-25 Aralık o tarihler dolu",
    "20-25 Aralık başkasına verdik",
    "20-25 Aralık villa tutuldu",
    "20-25 Aralık o tarihler müsait değil",
    "20-25 Aralık artık müsait değil",
  ])("%s → kapat ✅", (m) => {
    expect(run(m)).toEqual(closed);
  });
});

describe("açma ifadeleri", () => {
  it.each([
    "20-25 Aralık aç",
    "20-25 Aralık açıyoruz",
    "20-25 Aralık açmak istiyoruz",
    "20-25 Aralık serbest bırak",
    "20-25 Aralık müsait yap",
    "20-25 Aralık boşalt",
    "20-25 Aralık rezervasyonu kaldır",
    "20-25 Aralık bloğu kaldıralım",
    "20-25 Aralık kapatmayı kaldır",
    "20-25 Aralık kiralamadan vazgeçildi",
    "20-25 Aralık misafir vazgeçti",
    "20-25 Aralık iptal oldu",
    "20-25 Aralık rezervasyon iptal oldu",
    "20-25 Aralık rezervasyonu iptal edildi",
    "20-25 Aralık misafir gelmeyecek",
    "20-25 Aralık kimse gelmeyecek",
    "20-25 Aralık tarihleri boşa çıkar",
    "20-25 Aralık tarihler boşa çıktı",
    "20-25 Aralık tekrar satışa aç",
    "20-25 Aralık yeniden kiralamaya aç",
    "20-25 Aralık tarihleri serbest bırak",
    "20-25 Aralık tekrar müsait",
  ])("%s → aç ✅", (m) => {
    expect(run(m)).toEqual(opened);
  });
});

describe("olumsuz ifadeler: işlem yok, tepki yok", () => {
  it.each([
    "20-25 Aralık kiralanmadı",
    "20-25 Aralık kiralanmamış",
    "20-25 Aralık kiralamadık",
    "20-25 Aralık rezervasyon alınmadı",
    "20-25 Aralık rezervasyon almadık",
    "20-25 Aralık rezervasyon gelmedi",
    "20-25 Aralık satılmadı",
    "20-25 Aralık satmadık",
    "20-25 Aralık kiraya vermedik",
    "20-25 Aralık kiraya verilmedi",
    "20-25 Aralık misafir almadık",
    "20-25 Aralık doldurmayalım",
    "20-25 Aralık dolu yapmayalım",
    "20-25 Aralık tutulmadı",
    "20-25 Aralık kapatmayalım",
    "20-25 Aralık açmayalım",
    "20-25 Aralık müsait yapmayın",
    "20-25 Aralık iptal etmeyelim",
    "20-25 Aralık vazgeçmedik",
  ])("%s", (m) => {
    expect(run(m)).toEqual(noAction("yok"));
  });

  it("'satmayalım' / 'vermeyelim' kapatmadır (mevcut davranış)", () => {
    expect(run("20-25 Aralık satmayalım")).toEqual(closed);
    expect(run("20-25 Aralık kimseye vermeyelim")).toEqual(closed);
  });
});

describe("çelişkili ifadeler: işlem yok, ⚠️", () => {
  it.each([
    "20-25 Aralık kiralandı ama kapatmayalım",
    "20-25 Aralık rezervasyon iptal oldu, kapatalım",
    "20-25 Aralık kiralandı, tekrar açalım",
    "20-25 Aralık açmayı iptal et",
  ])("%s", (m) => {
    expect(run(m)).toEqual(noAction("⚠️"));
  });
});

describe("kelime sırası ve noktalama", () => {
  it.each([
    ["Kiralandı: 20-25 Aralık", closed],
    ["Kiralandı. 20-25 Aralık", closed],
    ["20-25 Aralık. Kiralandı.", closed],
    ["20 - 25 Aralık; satıldı.", closed],
    ["Villa Mavi, 20-25 Aralık, kiralandı!", closed],
    ["REZERVASYON ALINDI 20-25 ARALIK", closed],
    ["rezervasyon alindi 20-25 aralik", closed],
    ["Aralık 20-25 başkasına verdik", closed],
    ["20.12-25.12 rezervasyon geldi", closed],
    ["20-25 Aralık rezervasyon alındı, misafir Ahmet Bey", closed],
    ["Misafir gelecek, 20-25 Aralık", closed],
    ["İptal oldu: 20-25 Aralık", opened],
    ["20-25 Aralık... rezervasyon iptal oldu!!", opened],
    ["Tekrar müsait 20-25 Aralık", opened],
    ["Serbest bırakalım lütfen, 20-25 Aralık", opened],
  ])("%s", (m, want) => {
    expect(run(m)).toEqual(want);
  });

  it("ay yazılmamış: bu ay (ileride)", () => {
    expect(run("20-25 kiralandı")).toMatchObject({
      act: "close",
      ci: "2026-11-20",
      co: "2026-11-25",
    });
    expect(run("20-25 rezervasyon alındı")).toMatchObject({ act: "close", ci: "2026-11-20" });
    expect(run("20-25 iptal oldu")).toMatchObject({ act: "open", ci: "2026-11-20" });
  });

  it("çok öğeli mesaj ayrı kalır (✅/⚠️ kuralı değişmez)", () => {
    expect(run("Villa Mavi 20-25 Aralık kiralandı; Villa Mavi 1-5 Ocak iptal").reply).toBe("⚠️");
  });
});

describe("iptal kaynaklı açma yalnız açık tarih aralığıyla", () => {
  it.each([
    "Yarın rezervasyon iptal oldu",
    "Bu gece misafir gelmeyecek",
    "Önümüzdeki 3 gece iptal",
    "Önceki tarihleri iptal et",
    "20 Aralık rezervasyon iptal oldu",
    "Rezervasyon iptal oldu",
  ])("%s → işlem yok", (m) => {
    expect(run(m).act).toBeNull();
  });

  it("geçmiş tarih iptali işlem yapmaz (⚠️)", () => {
    expect(run("1-5 Kasım rezervasyon iptal oldu")).toEqual(noAction("⚠️"));
  });
});

describe("tarih kuralları değişmez", () => {
  it.each([
    "10-15 kiralandı", // başlangıç geçmişte
    "25-20 Aralık kiralandı", // ters
    "28-31 Kasım satıldı", // takvimde yok
    "20 Aralık kiralandı", // tek tarih
    "10,15 Aralık rezervasyon alındı", // liste
    "Hafta sonu kiralandı", // belirsiz
    "20-25 Aralığı kiralandı", // Aralık mı, "aralık (range)" mı?
  ])("%s → ⚠️", (m) => {
    expect(run(m)).toEqual(noAction("⚠️"));
  });

  it("'Ocağı' Ocak'tır", () => {
    expect(run("1-5 Ocağı kapatalım")).toMatchObject({
      act: "close",
      ci: "2027-01-01",
      co: "2027-01-05",
    });
  });

  it("'Aralık değil Ocak' düzeltmesi yeni ifadelerle de çalışır", () => {
    expect(run("10-15 Aralık değil, Ocak kiralandı")).toMatchObject({
      act: "close",
      ci: "2027-01-10",
      co: "2027-01-15",
    });
  });
});

describe("ilgisiz sohbet ve belirsiz bildirimler", () => {
  it.each([
    "Kiralandı",
    "Misafir gelecek",
    "15-20 misafir gelecek",
    "Ayakkabı satıldı 20 TL",
    "Arabayı kiraladık, 3 gün",
    "Formu doldur 20-25 arası",
    "Havuzu 20-25 Aralık doldurun",
    "20-25 Aralık için villa kiralamak istiyoruz",
    "Rezervasyon iptal oldu mu?",
    "20-25 Aralık kiralandı mı?",
  ])("%s → işlem yok", (m) => {
    expect(run(m).act).toBeNull();
  });

  it.each(["Kiralandı", "Misafir gelecek", "15-20 misafir gelecek", "Ayakkabı satıldı 20 TL"])(
    "%s → tepki yok",
    (m) => {
      expect(run(m).reply).toBe("yok");
    },
  );

  it("opsiyonlu rezervasyon kesin değildir: kapatma yok, ⚠️", () => {
    expect(run("20-25 Aralık opsiyonlu rezervasyon alındı")).toEqual(noAction("⚠️"));
  });

  it("çıplak 'rezervasyon' / 'misafir' (fiilsiz) kapatma değildir: ⚠️", () => {
    expect(run("20-25 Aralık rezervasyon")).toEqual(noAction("⚠️"));
    expect(run("20-25 Aralık misafir")).toEqual(noAction("⚠️"));
  });

  it("'misafir yok', 'misafir gelmedi' belirsizdir: ⚠️", () => {
    expect(run("20-25 Aralık misafir yok")).toEqual(noAction("⚠️"));
    expect(run("20-25 Aralık misafir gelmedi")).toEqual(noAction("⚠️"));
  });
});

describe("katılımcı ve grup kuralları aynen geçerli", () => {
  it("yetkisiz gönderen / villasız grup → aday yok", () => {
    const items = parseCalendarMessage("20-25 Aralık kiralandı", TODAY).items.map((item, i) =>
      buildStoreItem({
        item,
        itemNo: i,
        villa: resolveProposal(item, CTX),
        busy: [],
        senderRole: "participant",
      }),
    );
    expect(autoCloseCandidate(items, { senderRole: null, groupPropertyId: "mavi" })).toBeNull();
    expect(
      autoCloseCandidate(items, { senderRole: "participant", groupPropertyId: null }),
    ).toBeNull();
  });
});
