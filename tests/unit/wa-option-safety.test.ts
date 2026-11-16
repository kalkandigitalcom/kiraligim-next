/**
 * Aşama 1 — opsiyon güvenliği (ayrıştırıcı v8). Opsiyon özelliği henüz yok: "opsiyon" sözcüğü
 * geçen ya da müşterinin vazgeçtiğini bildiren mesaj HİÇBİR takvim kaydını değiştirmez
 * (opsiyon iptali manuel bloğu açmaz, "opsiyonlu kapat" kesin blok oluşturmaz, tarih
 * değiştirme yapılmaz) ve ⚠️ alır. Eski kesin kapatma / açma / tarih değiştirme komutları aynen
 * çalışır.
 *
 * Uçtan uca karar zinciri: ayrıştırma → öneri öğesi → otomatik kapatma / açma / değiştirme
 * uygunluğu (worker ile aynı sıra) → tepki.
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

import regression from "./fixtures/wa-regression-v8.json";

const TODAY = regression.bugun;
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
  islem: "close" | "open" | "change" | null;
  giris: string | null;
  cikis: string | null;
  tepki: "✅" | "⚠️" | "yok";
};

function run(message: string): Outcome {
  const items = parseCalendarMessage(message, TODAY).items.map((item, i) =>
    buildStoreItem({
      item,
      itemNo: i,
      villa: resolveProposal(item, CTX),
      busy: [],
      senderRole: "participant",
    }),
  );
  const close = autoCloseCandidate(items, RULE);
  const open = close ? null : autoOpenCandidate(items, RULE);
  const change = close || open ? null : autoChangeCandidate(items, RULE);
  const cand = close ?? open ?? change;
  const rx = decideReaction({
    senderRole: "participant",
    items,
    stored: items.length,
    ...(cand ? { autoClose: "applied" as const } : {}),
  });
  return {
    islem: close ? "close" : open ? "open" : change ? "change" : null,
    giris: cand?.check_in ?? null,
    cikis: cand?.check_out ?? null,
    tepki: rx === "done" ? "✅" : rx === "warning" ? "⚠️" : "yok",
  };
}

const none = (tepki: Outcome["tepki"]): Outcome => ({
  islem: null,
  giris: null,
  cikis: null,
  tepki,
});
const APR = { giris: "2027-04-15", cikis: "2027-04-18" };

/**
 * v9 farkları (fixture v8 olarak korunur): takvim komutu içermeyen TARİHSİZ ödeme / kesinleşme
 * bildirimi artık opsiyonla ilgilidir ve ⚠️ alır (önceden tepkisizdi). Takvim işlemi hiçbirinde
 * değişmez; başka hiçbir senaryonun sonucu değişmez.
 */
const V9_WARNING = new Set([
  "NL-X23",
  "OP-K01",
  "OP-K02",
  "OP-K03",
  "OP-K05",
  "OP-K17",
  "OP-K18",
  "OP-K22",
  "OP-K23",
  "OP-K25",
  "OP-K26",
  "OP-B02",
  "OP-B03",
  "OP-B07",
  "OP-S07",
  "OP-V02",
  "OP-V04",
  "OP-V05",
  "OP-T02",
  "OP-T03",
  "OP-T04",
  "OP-D08",
  "OP-D14",
  "OP-T07",
  "OP-T08",
  "OP-T09",
]);

describe("regresyon: 219 doğal dil + 138 opsiyon senaryosu (v8 → v9)", () => {
  const all = regression.senaryolar.map((s) =>
    V9_WARNING.has(s.id) ? { ...s, tepki: "⚠️" as const } : s,
  );

  it("v9 farkları yalnız tarihsiz ödeme bildirimleri: işlem yok, tepki yok → ⚠️", () => {
    const changed = regression.senaryolar.filter((s) => V9_WARNING.has(s.id));
    expect(changed).toHaveLength(26);
    for (const s of changed) {
      expect([s.id, s.islem, s.giris, s.tepki]).toEqual([s.id, null, null, "yok"]);
      expect(s.mesaj).toMatch(/[ÖöOo]deme|[Kk]apora/u);
    }
  });

  it("senaryo sayısı", () => {
    expect(all.filter((s) => s.id.startsWith("NL-"))).toHaveLength(219);
    expect(all.filter((s) => s.id.startsWith("OP-"))).toHaveLength(138);
  });

  it.each(all.map((s) => [s.id, s.mesaj, s] as const))("%s: %s", (_id, mesaj, s) => {
    expect(run(mesaj)).toEqual({ islem: s.islem, giris: s.giris, cikis: s.cikis, tepki: s.tepki });
  });

  it("opsiyon / vazgeçme içeren hiçbir senaryo takvim işlemi üretmez", () => {
    const optionish = all.filter(
      (s) =>
        /opsiyon(?!el)|opsıyon/iu.test(s.mesaj) ||
        /vazge[cç](?!me(?!k)|mey|mem|ilme)/iu.test(s.mesaj),
    );
    expect(optionish.length).toBeGreaterThan(40);
    for (const s of optionish) expect([s.id, run(s.mesaj).islem]).toEqual([s.id, null]);
  });
});

describe("Aşama 1 öncelikli sorunlar", () => {
  it.each([
    "15-18 Nisan opsiyon iptal",
    "Villa Mavi 15-18 Nisan opsiyon iptal",
    "15-18 Nisan OPSİYON İPTAL",
    "15-18 Nisan opsiyon düştü, açalım",
    "15-18 Nisan opsiyonu kaldır",
  ])("1. opsiyon iptali blok açmaz: %s → işlem yok, ⚠️", (m) => {
    expect(run(m)).toEqual(none("⚠️"));
  });

  it.each([
    "15-18 Nisan müşteri vazgeçti",
    "15-18 Nisan misafir vazgeçti, tekrar açalım",
    "15-18 Nisan müşteri vazgeçebilir",
    "Villa Mavi 15-18 Nisan müşteri vazgeçti, tarihleri boşa çıkar",
  ])("2. müşteri vazgeçmesi tarih açmaz: %s → işlem yok, ⚠️", (m) => {
    expect(run(m)).toEqual(none("⚠️"));
  });

  it.each([
    "15-18 Nisan opsiyonlu kapat",
    "15-18 Nisan opsiyon kesinleşti kapat",
    "15-18 Nisan opsiyon, kapatalım",
    "15-18 Nisan kesin rezervasyon, opsiyon değil",
    "15-18 Nisan opsiyonlu rezervasyon alındı, misafir Ayşe 4 kişi",
    "15 Nisan giriş 18 Nisan çıkış opsiyon",
  ])("3. opsiyon sözcüğü kesin blok / rezervasyon oluşturmaz: %s → işlem yok, ⚠️", (m) => {
    expect(run(m)).toEqual(none("⚠️"));
  });

  it.each([
    "Opsiyon iptal.",
    "Opsiyonu kaldır.",
    "Müşteri vazgeçti.",
    "Opsiyon süresi doldu.",
    "Opsiyon kesinleşti.",
  ])(
    "4. tarihsiz opsiyon bildirimi hiçbir kaydı etkilemez, işlenmediği ⚠️ ile bildirilir: %s",
    (m) => {
      expect(run(m)).toEqual(none("⚠️"));
      for (const i of parseCalendarMessage(m, TODAY).items) {
        expect(i.action).toBeNull();
        expect(i.flags).toContain("option_unsupported");
      }
    },
  );
});

describe("yanlış pozitif: opsiyon bağlamı başka talimatı tetiklemez", () => {
  it.each([
    // Aynı mesajda opsiyon + başka talimat: hiçbir öğe işlenmez.
    "15-18 Nisan kapat. 20-23 Nisan opsiyon",
    "20-23 Nisan opsiyon, 15-18 Nisan tekrar müsait",
    // Tarih değiştirme opsiyon için yapılmaz (mevcut kaydı taşımaz).
    "15-18 Nisan opsiyonu 16-19 Nisan'a aldık",
    "15-18 Nisan opsiyon 16-19 Nisan olarak değişti",
    // Olumsuz opsiyon sözcüğü de başka talimatı durdurur (belirsiz).
    "15-18 Nisan kapat, opsiyon vermeyelim",
    // Çoklu aralık opsiyon (karar: şimdilik desteklenmez).
    "15-18 Nisan ve 20-23 Nisan opsiyon",
  ])("%s → işlem yok, ⚠️", (m) => {
    expect(run(m)).toEqual(none("⚠️"));
  });

  it.each(["Opsiyon var mı?", "15-18 Nisan opsiyon verelim mi?", "Müşteri vazgeçer mi acaba"])(
    "soru tepkisiz kalır: %s",
    (m) => {
      expect(run(m)).toEqual(none("yok"));
    },
  );

  it.each(["Müşteri vazgeçmedi", "15-18 Nisan opsiyon vermeyelim"])(
    "olumsuz ifade işlem üretmez: %s",
    (m) => {
      expect(run(m).islem).toBeNull();
    },
  );
});

describe("korunan davranış: kesin kapatma / açma / değiştirme", () => {
  it.each([
    ["15-18 Nisan kapat", "close"],
    ["15-18 Nisan ödeme alındı kapat", "close"],
    ["15-18 Nisan rezervasyon aldık", "close"],
    ["Müşteri vazgeçmedi, 15-18 Nisan kapalı kalsın", "close"],
    ["15-18 Nisan iptal", "open"],
    ["Villa Mavi 15-18 Nisan rezervasyon iptal oldu", "open"],
    ["15-18 Nisan tekrar müsait", "open"],
    ["15-18 Nisan rezervasyonu 16-19 Nisan'a aldık", "change"],
  ] as const)("%s → %s ✅", (m, islem) => {
    const r = run(m);
    expect([r.islem, r.tepki]).toEqual([islem, "✅"]);
    if (islem !== "change") expect({ giris: r.giris, cikis: r.cikis }).toEqual(APR);
  });
});

describe("v9: yazım hataları ve ödeme bildirimleri", () => {
  it.each([
    "15-18 Nisan obsiyon kapat",
    "15-18 Nisan opsyon kapat",
    "15-18 Nisan opsiyn, kapatalım",
    "15-18 Nisan opsion iptal açalım",
    "15-18 Nisan opisyon",
  ])("opsiyon yazım hatası takvim işlemi üretmez: %s → işlem yok, ⚠️", (m) => {
    expect(run(m)).toEqual(none("⚠️"));
  });

  it.each([
    "Müşteri kapora gönderdi, kesinleşti",
    "Kaparo yattı",
    "Depozito alındı",
    "Havale geldi",
    "15-18 Nisan kaparo yattı",
    "15-18 Nisan kesinleşti",
  ])("takvim komutu olmayan ödeme / kesinleşme bildirimi: %s → işlem yok, ⚠️", (m) => {
    expect(run(m)).toEqual(none("⚠️"));
  });

  it.each([
    ["15-18 Nisan rezervasyon kesinleşti", "close"],
    ["Kapora alındı, 15-18 Nisan kapat", "close"],
    ["15-18 Nisan kiralandı, ödeme geldi", "close"],
    ["15-18 Nisan rezervasyon alındı kapora geldi", "close"],
    ["15-18 Nisan aç", "open"],
  ] as const)("takvim komutu eskisi gibi çalışır: %s → %s, ✅", (m, islem) => {
    expect(run(m)).toEqual({ islem, ...APR, tepki: "✅" });
  });

  it.each(["Havuz opsiyonel 15-18 Nisan kapat", "15-18 Nisan ödeme gelmedi", "Ödeme bekliyoruz"])(
    "opsiyon sayılmayanlar eskisi gibi: %s",
    (m) => {
      const r = run(m);
      expect(r.islem === "close" || r.tepki !== "✅" || r.islem === null).toBe(true);
      expect(
        parseCalendarMessage(m, TODAY).items.every((i) => !i.flags.includes("option_unsupported")),
      ).toBe(true);
    },
  );
});
