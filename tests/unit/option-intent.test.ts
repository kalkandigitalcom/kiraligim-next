/**
 * Opsiyon — doğal Türkçe mesaj matrisi (91 mesaj): niyet, karar, süre ve iptal nedeni.
 *
 * Öğeler üretimdeki worker hattıyla üretilir (ayrıştırıcı v9 → villa çözümü → kayıt öğesi) ve
 * 0072'nin döndürdüğü alanlara indirgenir; karar ./decide (→ ./intent) ile verilir. Gönderen
 * doğrulanmış sahip, grubun tek villası, takvimde çakışma yok, bugün 20 Eylül 2026. Veritabanı
 * ayrıca yeniden denetler (çakışma, açık opsiyon, hedef; süre yazılmamışsa işletme varsayılanı).
 *
 * Kanıtlananlar: opsiyon sözcüğü + tanınmayan / başka niyetli sözcük ASLA otomatik oluşturma
 * değildir; kesinleştirme her zaman onaydır; uzatma / tarih değişikliği (Faz B) ayrı niyettir; süre
 * ayrıştırıcısı v2 (sayı sözcükleri, hafta, kısaltma, ondalık, bileşik); anlaşılmayan süre varsa
 * işletme varsayılanı kullanılmaz (onay); soru ve olumsuz ifade işlem üretmez; opsiyon mesajı
 * takvim işlemi üretmez; normal takvim komutları opsiyon işlemi üretmez.
 */
import { describe, expect, it } from "vitest";

import { parseCalendarMessage } from "@/lib/wa-calendar-parse";
import { decideOptionMessage, type OptionMessageItem } from "@/server/options/decide";
import { parseOptionDuration } from "@/server/options/intent";
import { foldTr } from "@/lib/wa-calendar-parse";
import { buildStoreItem, type StoreItem } from "@/server/whatsapp/calendar/proposal";
import { resolveProposal } from "@/server/whatsapp/calendar/resolve";

const TODAY = "2026-09-20";
const SENT = new Date("2026-09-20T09:00:00+03:00");
const CTX = {
  workspaceId: "w",
  villas: [{ id: "mavi", workspaceId: "w", name: "Villa Mavi" }],
  groupPropertyId: "mavi",
};

function storeItems(body: string): StoreItem[] {
  return parseCalendarMessage(body, TODAY).items.map((item, i) =>
    buildStoreItem({
      item,
      itemNo: i,
      villa: resolveProposal(item, CTX),
      busy: [],
      senderRole: "owner",
    }),
  );
}
const items = (body: string): OptionMessageItem[] =>
  storeItems(body).map((s) => ({
    itemNo: s.item_no,
    parserVersion: s.parser_version,
    checkIn: s.check_in,
    checkOut: s.check_out,
    propertyId: s.property_id,
    villaResolution: s.villa_resolution,
    flags: s.flags,
    senderRole: "owner",
    senderVerified: true,
  }));

type Expected =
  | { none: string }
  | {
      intent: "create" | "cancel" | "convert" | "extend" | "reschedule";
      decision: "apply" | "ask" | "ignore";
      minutes: number | null;
      end: "customer_declined" | "owner_cancelled" | null;
      reasons: string[];
    };

const MATRIX: [string, string, Expected][] = [
  [
    "Oluşturma",
    "17-21 Ekim opsiyon",
    { intent: "create", decision: "apply", minutes: null, end: null, reasons: [] },
  ],
  [
    "Oluşturma",
    "17 21 ekim opsiyon",
    { intent: "create", decision: "apply", minutes: null, end: null, reasons: [] },
  ],
  [
    "Oluşturma",
    "Ekim 17-21 opsiyon",
    { intent: "create", decision: "apply", minutes: null, end: null, reasons: [] },
  ],
  [
    "Oluşturma",
    "17/10-21/10 opsiyon",
    { intent: "create", decision: "apply", minutes: null, end: null, reasons: [] },
  ],
  [
    "Oluşturma",
    "17.10 - 21.10 opsiyon 24 saat",
    { intent: "create", decision: "apply", minutes: 1440, end: null, reasons: [] },
  ],
  [
    "Oluşturma",
    "17 Ekim giriş 21 Ekim çıkış opsiyon",
    { intent: "create", decision: "apply", minutes: null, end: null, reasons: [] },
  ],
  [
    "Oluşturma",
    "17-21 Ekim 4 gece opsiyon",
    { intent: "create", decision: "apply", minutes: null, end: null, reasons: [] },
  ],
  [
    "Oluşturma",
    "17-21 Ekime opsiyon",
    { intent: "create", decision: "apply", minutes: null, end: null, reasons: [] },
  ],
  [
    "Oluşturma",
    "17-21 EKİM OPSİYON",
    { intent: "create", decision: "apply", minutes: null, end: null, reasons: [] },
  ],
  [
    "Oluşturma",
    "17-21 Ekim opsiyon alalım",
    { intent: "create", decision: "apply", minutes: null, end: null, reasons: [] },
  ],
  [
    "Oluşturma",
    "17-21 Ekim'i opsiyona koy",
    { intent: "create", decision: "apply", minutes: null, end: null, reasons: [] },
  ],
  [
    "Oluşturma",
    "17-21 Ekim için opsiyon verdik",
    { intent: "create", decision: "apply", minutes: null, end: null, reasons: [] },
  ],
  [
    "Oluşturma",
    "17-21 Ekim opsiyon verelim",
    { intent: "create", decision: "apply", minutes: null, end: null, reasons: [] },
  ],
  [
    "Oluşturma",
    "17-21 ekim opsiyonlayalım",
    { intent: "create", decision: "apply", minutes: null, end: null, reasons: [] },
  ],
  [
    "Oluşturma",
    "17-21 Ekim opsiyonlu",
    { intent: "create", decision: "apply", minutes: null, end: null, reasons: [] },
  ],
  [
    "Oluşturma",
    "17-21 Ekim opsiyon koyduk müşteri cevap verecek",
    { intent: "create", decision: "apply", minutes: null, end: null, reasons: [] },
  ],
  [
    "Oluşturma",
    "17-21 Ekim 2 kişi opsiyon",
    { intent: "create", decision: "apply", minutes: null, end: null, reasons: [] },
  ],
  [
    "Yazım hatası",
    "17-21 Ekim opsyon",
    { intent: "create", decision: "apply", minutes: null, end: null, reasons: [] },
  ],
  [
    "Yazım hatası",
    "17-21 Ekim obsiyon",
    { intent: "create", decision: "apply", minutes: null, end: null, reasons: [] },
  ],
  [
    "Yazım hatası",
    "17-21 Ekim opsiyn",
    { intent: "create", decision: "apply", minutes: null, end: null, reasons: [] },
  ],
  [
    "Süre",
    "17-21 ekim 48 saat opsiyon",
    { intent: "create", decision: "apply", minutes: 2880, end: null, reasons: [] },
  ],
  [
    "Süre",
    "17-21 Ekim opsiyon 2 gün",
    { intent: "create", decision: "apply", minutes: 2880, end: null, reasons: [] },
  ],
  [
    "Süre",
    "17-21 Ekim 24 saatlik opsiyon",
    { intent: "create", decision: "apply", minutes: 1440, end: null, reasons: [] },
  ],
  [
    "Süre",
    "17-21 Ekim opsiyon 48 saatliğine",
    { intent: "create", decision: "apply", minutes: 2880, end: null, reasons: [] },
  ],
  [
    "Süre",
    "17-21 Ekim opsiyon 3 günlük",
    { intent: "create", decision: "apply", minutes: 4320, end: null, reasons: [] },
  ],
  [
    "Süre",
    "17-21 Ekim opsiyon 36 saat",
    { intent: "create", decision: "apply", minutes: 2160, end: null, reasons: [] },
  ],
  [
    "Süre",
    "17-21 Ekim opsiyon bir gün",
    { intent: "create", decision: "apply", minutes: 1440, end: null, reasons: [] },
  ],
  [
    "Süre",
    "17-21 Ekim opsiyon iki gün",
    { intent: "create", decision: "apply", minutes: 2880, end: null, reasons: [] },
  ],
  [
    "Süre",
    "17-21 Ekim opsiyon 1 hafta",
    { intent: "create", decision: "apply", minutes: 10080, end: null, reasons: [] },
  ],
  [
    "Süre",
    "17-21 Ekim opsiyon 48s",
    { intent: "create", decision: "apply", minutes: 2880, end: null, reasons: [] },
  ],
  [
    "Süre",
    "17-21 Ekim opsiyon 2g",
    { intent: "create", decision: "apply", minutes: 2880, end: null, reasons: [] },
  ],
  [
    "Süre",
    "17-21 Ekim opsiyon 2 gün 12 saat",
    { intent: "create", decision: "apply", minutes: 3600, end: null, reasons: [] },
  ],
  [
    "Süre",
    "17-21 Ekim opsiyon 1,5 gün",
    { intent: "create", decision: "apply", minutes: 2160, end: null, reasons: [] },
  ],
  [
    "Süre",
    "17-21 Ekim opsiyon yarım gün",
    { intent: "create", decision: "ask", minutes: null, end: null, reasons: ["duration_unclear"] },
  ],
  [
    "Süre",
    "17-21 Ekim opsiyon yarına kadar",
    { intent: "create", decision: "ask", minutes: null, end: null, reasons: ["duration_unclear"] },
  ],
  [
    "Süre",
    "17-21 Ekim opsiyon yarın akşama kadar",
    { intent: "create", decision: "ask", minutes: null, end: null, reasons: ["duration_unclear"] },
  ],
  [
    "Süre",
    "17-21 Ekim opsiyon pazartesiye kadar",
    { intent: "create", decision: "ask", minutes: null, end: null, reasons: ["duration_unclear"] },
  ],
  [
    "Süre",
    "17-21 Ekim opsiyon 30 dk",
    {
      intent: "create",
      decision: "ask",
      minutes: null,
      end: null,
      reasons: ["duration_out_of_bounds"],
    },
  ],
  [
    "Süre",
    "17-21 Ekim opsiyon 20 gün",
    {
      intent: "create",
      decision: "ask",
      minutes: null,
      end: null,
      reasons: ["duration_out_of_bounds"],
    },
  ],
  [
    "Süre",
    "21-23 Eylül opsiyon 3 gün",
    {
      intent: "create",
      decision: "ask",
      minutes: 4320,
      end: null,
      reasons: ["duration_after_check_in"],
    },
  ],
  [
    "Tarih / belirsiz",
    "Bu tarihlere opsiyon verelim",
    { intent: "create", decision: "ask", minutes: null, end: null, reasons: ["date_missing"] },
  ],
  [
    "Tarih / belirsiz",
    "Opsiyon verdik",
    { intent: "create", decision: "ask", minutes: null, end: null, reasons: ["date_missing"] },
  ],
  [
    "Tarih / belirsiz",
    "17-21 Ekim ve 25-28 Ekim opsiyon",
    { intent: "create", decision: "ask", minutes: null, end: null, reasons: ["multiple_ranges"] },
  ],
  [
    "Tarih / belirsiz",
    "1-5 Eylül opsiyon",
    { intent: "create", decision: "ask", minutes: null, end: null, reasons: ["date_unclear"] },
  ],
  [
    "Tarih / belirsiz",
    "17-21 Ekim belki opsiyon olabilir",
    { intent: "create", decision: "ask", minutes: null, end: null, reasons: ["hedged"] },
  ],
  [
    "Tarih / belirsiz",
    "17-21 Ekim opsiyon tamam",
    { intent: "create", decision: "ask", minutes: null, end: null, reasons: ["intent_unclear"] },
  ],
  [
    "İşlem yok",
    "17-21 Ekim opsiyon verebilir miyiz?",
    { intent: "create", decision: "ignore", minutes: null, end: null, reasons: ["question"] },
  ],
  [
    "İşlem yok",
    "17-21 Ekim opsiyon vermeyelim",
    { intent: "create", decision: "ignore", minutes: null, end: null, reasons: ["negated"] },
  ],
  [
    "İşlem yok",
    "17-21 Ekim opsiyon iptal etmeyelim",
    { intent: "create", decision: "ignore", minutes: null, end: null, reasons: ["negated"] },
  ],
  ["İşlem yok", "17-21 Ekim müşteri vazgeçmedi", { none: "no_items" }],
  [
    "İşlem yok",
    "17-21 Ekim ödeme gelmedi",
    { intent: "create", decision: "ignore", minutes: null, end: null, reasons: ["negated"] },
  ],
  [
    "İşlem yok",
    "17-21 Ekim opsiyon kapora bekliyoruz",
    { intent: "create", decision: "ignore", minutes: null, end: null, reasons: ["negated"] },
  ],
  [
    "İşlem yok",
    "17-21 Ekim opsiyon kesinleşmedi",
    { intent: "create", decision: "ignore", minutes: null, end: null, reasons: ["negated"] },
  ],
  [
    "İşlem yok",
    "17-21 Ekim opsiyon kalsın",
    { intent: "create", decision: "ask", minutes: null, end: null, reasons: ["intent_unclear"] },
  ],
  [
    "Müşteri vazgeçti",
    "17-21 Ekim opsiyon müşteri vazgeçti",
    { intent: "cancel", decision: "apply", minutes: null, end: "customer_declined", reasons: [] },
  ],
  [
    "Müşteri vazgeçti",
    "17-21 Ekim opsiyonu müşteri almadı",
    { intent: "cancel", decision: "apply", minutes: null, end: "customer_declined", reasons: [] },
  ],
  [
    "Müşteri vazgeçti",
    "17-21 Ekim opsiyon düştü",
    { intent: "cancel", decision: "apply", minutes: null, end: "customer_declined", reasons: [] },
  ],
  [
    "Müşteri vazgeçti",
    "17-21 Ekim müşteri vazgeçti",
    { intent: "cancel", decision: "apply", minutes: null, end: "customer_declined", reasons: [] },
  ],
  [
    "Müşteri vazgeçti",
    "17-21 Ekim opsiyon misafir gelmeyecek",
    { intent: "cancel", decision: "apply", minutes: null, end: "customer_declined", reasons: [] },
  ],
  [
    "Müşteri vazgeçti",
    "Müşteri vazgeçti",
    {
      intent: "cancel",
      decision: "ask",
      minutes: null,
      end: "customer_declined",
      reasons: ["date_missing"],
    },
  ],
  [
    "Sahip iptali",
    "17-21 Ekim opsiyonu iptal",
    { intent: "cancel", decision: "apply", minutes: null, end: "owner_cancelled", reasons: [] },
  ],
  [
    "Sahip iptali",
    "17-21 Ekim opsiyonu iptal ettik",
    { intent: "cancel", decision: "apply", minutes: null, end: "owner_cancelled", reasons: [] },
  ],
  [
    "Sahip iptali",
    "17-21 Ekim opsiyonu kaldır",
    { intent: "cancel", decision: "apply", minutes: null, end: "owner_cancelled", reasons: [] },
  ],
  [
    "Sahip iptali",
    "17-21 Ekim opsiyonu sil",
    { intent: "cancel", decision: "apply", minutes: null, end: "owner_cancelled", reasons: [] },
  ],
  [
    "Sahip iptali",
    "17-21 Ekim opsiyonu boşalt",
    { intent: "cancel", decision: "apply", minutes: null, end: "owner_cancelled", reasons: [] },
  ],
  [
    "Sahip iptali",
    "Opsiyon iptal",
    {
      intent: "cancel",
      decision: "ask",
      minutes: null,
      end: "owner_cancelled",
      reasons: ["date_missing"],
    },
  ],
  [
    "Sahip iptali",
    "17-21 Ekim opsiyon süresi doldu",
    { intent: "cancel", decision: "ask", minutes: null, end: null, reasons: ["intent_unclear"] },
  ],
  [
    "Sahip iptali",
    "17-21 Ekim opsiyon bitti",
    { intent: "cancel", decision: "ask", minutes: null, end: null, reasons: ["intent_unclear"] },
  ],
  [
    "Kesinleştirme",
    "17-21 Ekim opsiyon ödeme alındı",
    { intent: "convert", decision: "ask", minutes: null, end: null, reasons: [] },
  ],
  [
    "Kesinleştirme",
    "17-21 Ekim opsiyon kesinleşti",
    { intent: "convert", decision: "ask", minutes: null, end: null, reasons: [] },
  ],
  [
    "Kesinleştirme",
    "17-21 Ekim opsiyon kesinleştir",
    { intent: "convert", decision: "ask", minutes: null, end: null, reasons: [] },
  ],
  [
    "Kesinleştirme",
    "17-21 Ekim opsiyon onaylandı",
    { intent: "convert", decision: "ask", minutes: null, end: null, reasons: [] },
  ],
  [
    "Kesinleştirme",
    "17-21 Ekim opsiyon onayla",
    { intent: "convert", decision: "ask", minutes: null, end: null, reasons: [] },
  ],
  [
    "Kesinleştirme",
    "17-21 Ekim kapora geldi opsiyon kesin",
    { intent: "convert", decision: "ask", minutes: null, end: null, reasons: [] },
  ],
  [
    "Kesinleştirme",
    "17-21 Ekim opsiyon kaparo yattı",
    { intent: "convert", decision: "ask", minutes: null, end: null, reasons: [] },
  ],
  [
    "Kesinleştirme",
    "17-21 Ekim opsiyon depozito alındı",
    { intent: "convert", decision: "ask", minutes: null, end: null, reasons: [] },
  ],
  [
    "Kesinleştirme",
    "17-21 Ekim opsiyon ön ödeme geldi",
    { intent: "convert", decision: "ask", minutes: null, end: null, reasons: [] },
  ],
  [
    "Kesinleştirme",
    "17-21 Ekim opsiyon havale geldi",
    { intent: "convert", decision: "ask", minutes: null, end: null, reasons: [] },
  ],
  [
    "Kesinleştirme",
    "17-21 Ekim opsiyon kesin rezervasyon oldu",
    { intent: "convert", decision: "ask", minutes: null, end: null, reasons: [] },
  ],
  [
    "Kesinleştirme",
    "17-21 Ekim opsiyon rezervasyona çevir",
    { intent: "convert", decision: "ask", minutes: null, end: null, reasons: [] },
  ],
  [
    "Kesinleştirme",
    "17-21 Ekim müşteri kapora gönderdi kesinleşti",
    { intent: "convert", decision: "ask", minutes: null, end: null, reasons: [] },
  ],
  [
    "Kesinleştirme",
    "Müşteri kapora gönderdi, kesinleşti",
    { intent: "convert", decision: "ask", minutes: null, end: null, reasons: ["date_missing"] },
  ],
  [
    "Kesinleştirme",
    "Opsiyon onaylandı, tarihleri kapatalım",
    { intent: "convert", decision: "ask", minutes: null, end: null, reasons: ["date_missing"] },
  ],
  [
    "Kesinleştirme",
    "17-21 Ekim opsiyon onaylandı, tarihleri kapatalım",
    { intent: "convert", decision: "ask", minutes: null, end: null, reasons: [] },
  ],
  // Faz B (0077): uzatma ve tarih değişikliği artık tanınır (veritabanı hedefi yeniden denetler).
  [
    "Uzatma",
    "17-21 Ekim opsiyonu 1 gün uzat",
    { intent: "extend", decision: "apply", minutes: 1440, end: null, reasons: [] },
  ],
  [
    "Uzatma",
    "17-21 Ekim opsiyon süresini uzattık",
    { intent: "extend", decision: "ask", minutes: null, end: null, reasons: ["duration_missing"] },
  ],
  [
    "Tarih değişikliği",
    // Ayrıştırıcı "X'i Y'ye kaydır"da eski aralığı saklamaz (date_change): hedef doğrulanamaz.
    "17-21 Ekim opsiyonu 18-22 Ekim'e kaydır",
    { intent: "reschedule", decision: "ask", minutes: null, end: null, reasons: ["date_unclear"] },
  ],
  ["Mevcut komut", "17-21 Ekim kapat", { none: "not_option" }],
  ["Mevcut komut", "17-21 Ekim kiralandı", { none: "not_option" }],
  ["Mevcut komut", "17-21 Ekim aç", { none: "not_option" }],
  ["Mevcut komut", "Havuz opsiyonel 17-21 Ekim kapat", { none: "not_option" }],
];

describe("doğal Türkçe matrisi (91 mesaj)", () => {
  it.each(MATRIX)("%s: %s", (_group, body, exp) => {
    const d = decideOptionMessage({
      body,
      sentAt: SENT,
      items: items(body),
      groupPropertyId: "mavi",
    });
    if ("none" in exp) {
      expect(d).toEqual({ kind: "none", why: exp.none });
      return;
    }
    expect(d.kind).toBe("items");
    if (d.kind !== "items") return;
    expect(d.items).toHaveLength(1);
    const r = d.items[0]!;
    expect({
      intent: r.intent,
      decision: r.decision,
      minutes: r.expires_in_minutes,
      end: r.end_reason,
      reasons: r.reasons,
    }).toEqual(exp);
  });

  it("matris 91 mesaj; hiçbir oluşturma dışı ifade otomatik oluşturma değil", () => {
    expect(MATRIX).toHaveLength(91);
    const autoCreate = MATRIX.filter(
      ([, , e]) => !("none" in e) && e.intent === "create" && e.decision === "apply",
    ).map(([g]) => g);
    expect(new Set(autoCreate)).toEqual(new Set(["Oluşturma", "Yazım hatası", "Süre"]));
  });

  it("kesinleştirme hiçbir mesajda otomatik değil", () => {
    for (const [, body, e] of MATRIX) {
      if (!("none" in e) && e.intent === "convert") expect(e.decision, body).not.toBe("apply");
    }
  });

  it("opsiyon mesajları takvim işlemi üretmez (ayrıştırıcı v9: eylemsiz öğe)", () => {
    for (const [group, body] of MATRIX) {
      if (group === "Mevcut komut") continue;
      for (const it of parseCalendarMessage(body, TODAY).items) {
        if (it.flags.includes("option_unsupported")) expect(it.action, body).toBeNull();
      }
    }
  });
});

describe("süre ayrıştırıcısı v2", () => {
  const dur = (s: string) => parseOptionDuration(foldTr(s));
  it.each([
    ["48 saat", 2880],
    ["48s", 2880],
    ["48 sa", 2880],
    ["2 gün", 2880],
    ["2g", 2880],
    ["iki gün", 2880],
    ["bir gün", 1440],
    ["yirmi dört saat", 1440],
    ["1 hafta", 10080],
    ["bir hafta", 10080],
    ["1,5 gün", 2160],
    ["1.5 gün", 2160],
    ["1 buçuk gün", 2160],
    ["2 gün 12 saat", 3600],
    ["36 saatlik", 2160],
    ["3 günlük", 4320],
    ["90 dakika", 90],
    ["90 dk", 90],
  ])("%s → %i dk", (s, m) => {
    expect(dur(s)).toMatchObject({ kind: "minutes", minutes: m });
  });

  it.each([
    "yarım gün",
    "yarına kadar",
    "pazartesiye kadar",
    "birkaç gün",
    "48 saat ya da 3 gün",
    "bir süre",
  ])("%s → belirsiz (varsayılan süre KULLANILMAZ)", (s) => {
    expect(dur(s).kind).toBe("unclear");
  });

  it.each(["17-21 Ekim", "4 gece", "2 kişi", "opsiyon", "Villa Mavi", "17.10 - 21.10"])(
    "%s → süre yok",
    (s) => {
      expect(dur(s).kind).toBe("none");
    },
  );
});

// ---------------------------------------------------------------------------------------------
// Faz B (0077): uzatma ve tarih değişikliği
// ---------------------------------------------------------------------------------------------
type FazB =
  | { none: string }
  | {
      intent: "create" | "cancel" | "convert" | "extend" | "reschedule";
      decision: "apply" | "ask" | "ignore";
      minutes: number | null;
      range: string | null;
      old: string | null;
      reasons: string[];
    };

const FAZ_B: [string, FazB][] = [
  // Uzatma: süre net, en az 1 saat; tarih yazılıysa hedef o aralık, yoksa grubun tek açık opsiyonu.
  [
    "20-23 Aralık opsiyonunu 2 saat uzatalım",
    {
      intent: "extend",
      decision: "apply",
      minutes: 120,
      range: "2026-12-20/2026-12-23",
      old: null,
      reasons: [],
    },
  ],
  [
    "Opsiyonu 2 saat uzatın",
    { intent: "extend", decision: "apply", minutes: 120, range: null, old: null, reasons: [] },
  ],
  [
    "Bu opsiyona 1 gün daha süre verelim",
    { intent: "extend", decision: "apply", minutes: 1440, range: null, old: null, reasons: [] },
  ],
  // Ödeme bekleme bağlamı (opsiyon sözcüğü olmadan); worker öğesi yok.
  [
    "Ödeme bekliyorum, 2 saat daha bekleyelim",
    { intent: "extend", decision: "apply", minutes: 120, range: null, old: null, reasons: [] },
  ],
  [
    "Kapora gelmedi, 1 gün daha bekleyelim",
    { intent: "extend", decision: "apply", minutes: 1440, range: null, old: null, reasons: [] },
  ],
  // Karar 3: mutlak zaman ("…'e kadar", saat) desteklenmez → açıklama.
  [
    "Müşteri kaporayı gönderecek, yarına kadar uzatalım",
    {
      intent: "extend",
      decision: "ask",
      minutes: null,
      range: null,
      old: null,
      reasons: ["duration_unclear"],
    },
  ],
  [
    "Yarın 18:00'e kadar uzat opsiyonu",
    {
      intent: "extend",
      decision: "ask",
      minutes: null,
      range: null,
      old: null,
      reasons: ["duration_unclear"],
    },
  ],
  // Karar 1: 1 saatten kısa uzatma otomatik değil; 14 günü aşan süre de değil.
  [
    "Opsiyonu 30 dakika uzat",
    {
      intent: "extend",
      decision: "ask",
      minutes: null,
      range: null,
      old: null,
      reasons: ["duration_out_of_bounds"],
    },
  ],
  [
    "Opsiyonu 3 hafta uzat",
    {
      intent: "extend",
      decision: "ask",
      minutes: null,
      range: null,
      old: null,
      reasons: ["duration_out_of_bounds"],
    },
  ],
  [
    "Opsiyonu uzatalım",
    {
      intent: "extend",
      decision: "ask",
      minutes: null,
      range: null,
      old: null,
      reasons: ["duration_missing"],
    },
  ],
  [
    "Opsiyonu belki 1 gün uzatırız",
    {
      intent: "extend",
      decision: "ask",
      minutes: 1440,
      range: null,
      old: null,
      reasons: ["hedged"],
    },
  ],
  // Soru / olumsuz: işlem yok.
  ["Opsiyonu uzatalım mı?", { none: "no_items" }],
  [
    "Opsiyonu uzatmayalım",
    {
      intent: "extend",
      decision: "ignore",
      minutes: null,
      range: null,
      old: null,
      reasons: ["negated"],
    },
  ],
  // Karar 4: opsiyon / ödeme bağlamı yoksa hiçbir şey.
  ["2 saat daha bekleyelim", { none: "no_items" }],
  ["Biraz daha bekleyelim", { none: "no_items" }],
  // İptal / kesinleştirme sinyali varsa eski davranış aynen.
  [
    "Kapora alındı opsiyonu 1 gün uzat",
    {
      intent: "convert",
      decision: "ask",
      minutes: null,
      range: null,
      old: null,
      reasons: ["date_missing"],
    },
  ],
  // Tarih değişikliği: opsiyon sözcüğü + değiştirme fiili; 2 aralık → eski + yeni.
  [
    "20-23 Aralık opsiyonunu 21-24 Aralık yap",
    {
      intent: "reschedule",
      decision: "apply",
      minutes: null,
      range: "2026-12-21/2026-12-24",
      old: "2026-12-20/2026-12-23",
      reasons: [],
    },
  ],
  [
    "Opsiyon tarihini 20-24 Aralık yapalım",
    {
      intent: "reschedule",
      decision: "apply",
      minutes: null,
      range: "2026-12-20/2026-12-24",
      old: null,
      reasons: [],
    },
  ],
  // Göreli kaydırma ve yeni tarihsiz değişiklik → açıklama; opsiyon sözcüğü yoksa hiçbir şey.
  [
    "Opsiyonu bir gün ileri alalım",
    {
      intent: "reschedule",
      decision: "ask",
      minutes: null,
      range: null,
      old: null,
      reasons: ["intent_unclear", "new_range_missing"],
    },
  ],
  [
    "Opsiyon tarihlerini değiştirelim",
    {
      intent: "reschedule",
      decision: "ask",
      minutes: null,
      range: null,
      old: null,
      reasons: ["new_range_missing"],
    },
  ],
  ["Müşteri bir gün geç gelecek, tarihleri değiştirelim", { none: "no_items" }],
  ["Opsiyon tarihini değiştirmeyelim", { none: "no_items" }],
  // Tarih değişikliğinde süre yazılırsa (bitiş korunur): açıklama.
  [
    "20-23 Aralık opsiyonunu 21-24 Aralık yap 48 saat",
    {
      intent: "reschedule",
      decision: "ask",
      minutes: null,
      range: "2026-12-21/2026-12-24",
      old: "2026-12-20/2026-12-23",
      reasons: ["intent_unclear"],
    },
  ],
  // Oluşturma etkilenmez.
  [
    "20-23 Aralık opsiyon",
    {
      intent: "create",
      decision: "apply",
      minutes: null,
      range: "2026-12-20/2026-12-23",
      old: null,
      reasons: [],
    },
  ],
  [
    "20-23 Aralık opsiyon 48 saat",
    {
      intent: "create",
      decision: "apply",
      minutes: 2880,
      range: "2026-12-20/2026-12-23",
      old: null,
      reasons: [],
    },
  ],
];

describe("Faz B: uzatma ve tarih değişikliği", () => {
  it.each(FAZ_B)("%s", (body, exp) => {
    const d = decideOptionMessage({
      body,
      sentAt: SENT,
      items: items(body),
      groupPropertyId: "mavi",
    });
    if ("none" in exp) {
      expect(d).toEqual({ kind: "none", why: exp.none });
      return;
    }
    expect(d.kind).toBe("items");
    if (d.kind !== "items") return;
    expect(d.items).toHaveLength(1);
    const r = d.items[0]!;
    expect({
      intent: r.intent,
      decision: r.decision,
      minutes: r.expires_in_minutes,
      range: r.check_in ? `${r.check_in}/${r.check_out}` : null,
      old: r.old_check_in ? `${r.old_check_in}/${r.old_check_out}` : null,
      reasons: r.reasons,
    }).toEqual(exp);
    expect(r.end_reason).toBeNull();
  });

  it("worker öğesi olmayan mesajda yalnız uzatma / tarih değişikliği öğesi üretilir", () => {
    for (const body of ["17-21 Ekim opsiyon iptal", "Kapora alındı", "Opsiyon verelim"]) {
      expect(
        decideOptionMessage({ body, sentAt: SENT, items: [], groupPropertyId: "mavi" }),
      ).toEqual({ kind: "none", why: "no_items" });
    }
  });

  it("doğrulanmamış göndericinin öğeli mesajı işlem üretmez", () => {
    const its = items("20-23 Aralık opsiyonunu 2 saat uzatalım").map((i) => ({
      ...i,
      senderVerified: false,
    }));
    expect(
      decideOptionMessage({
        body: "20-23 Aralık opsiyonunu 2 saat uzatalım",
        sentAt: SENT,
        items: its,
        groupPropertyId: "mavi",
      }),
    ).toEqual({ kind: "none", why: "sender_not_allowed" });
  });
});
