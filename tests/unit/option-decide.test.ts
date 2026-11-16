/**
 * Opsiyon Aşama 3d — WhatsApp mesajından opsiyon kararı (saf). Öğeler üretimdeki worker hattıyla
 * (ayrıştırıcı v8 → villa çözümü → kayıt öğesi) üretilir ve 0072'nin döndürdüğü alanlara indirgenir.
 * Kanıtlananlar: yalnız doğrulanmış sahip / yönetici; kesinleştirme 3e'ye kadar işlem üretmez;
 * iptal nedeni eşleştirmesi; belirsiz ve "süresi doldu" iptalleri onaya; gölge kararıyla birebir
 * aynı niyet, tarih, süre ve nedenler (indirgeme bilgi kaybetmez); görev dosyaları worker'ı,
 * ayrıştırıcıyı veya tepki kuyruğunu DEĞİŞTİRMEZ (yalnız saf fonksiyonları içe aktarır).
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseCalendarMessage } from "@/lib/wa-calendar-parse";
import {
  cancelReasonOf,
  decideOptionMessage,
  type OptionMessageItem,
} from "@/server/options/decide";
import { analyzeOptionShadow } from "@/server/whatsapp/calendar/option-shadow";
import { buildStoreItem, type StoreItem } from "@/server/whatsapp/calendar/proposal";
import { resolveProposal } from "@/server/whatsapp/calendar/resolve";

const TODAY = "2026-11-15";
const SENT = new Date("2026-11-15T09:00:00+03:00");
const CTX = {
  workspaceId: "w",
  villas: [
    { id: "mavi", workspaceId: "w", name: "Villa Mavi" },
    { id: "asya", workspaceId: "w", name: "Villa Asya" },
  ],
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

/** 0072'nin döndürdüğü alanlar (metin ve misafir bilgisi yok). */
function messageItems(body: string, role = "owner", verified = true): OptionMessageItem[] {
  return storeItems(body).map((s) => ({
    itemNo: s.item_no,
    parserVersion: s.parser_version,
    checkIn: s.check_in,
    checkOut: s.check_out,
    propertyId: s.property_id,
    villaResolution: s.villa_resolution,
    flags: s.flags,
    senderRole: role,
    senderVerified: verified,
  }));
}

const decide = (body: string, role = "owner", verified = true) =>
  decideOptionMessage({
    body,
    sentAt: SENT,
    items: messageItems(body, role, verified),
    groupPropertyId: "mavi",
  });
const only = (body: string) => {
  const d = decide(body);
  expect(d.kind, body).toBe("items");
  if (d.kind !== "items") throw new Error("items bekleniyordu");
  expect(d.items).toHaveLength(1);
  return d.items[0]!;
};

describe("gönderen", () => {
  it.each([
    ["owner", true],
    ["manager", true],
  ])("%s (doğrulanmış) → işlem öğesi", (role, verified) => {
    expect(decide("15-18 Nisan opsiyon", role, verified).kind).toBe("items");
  });

  it.each([
    ["staff", false],
    ["participant", false],
    ["owner", false],
    ["manager", false],
  ])("%s (doğrulanmış=%s) → işlem YOK", (role, verified) => {
    expect(decide("15-18 Nisan opsiyon", role, verified)).toEqual({
      kind: "none",
      why: "sender_not_allowed",
    });
  });

  it("worker öğe kaydetmediyse işlem yok", () => {
    expect(
      decideOptionMessage({
        body: "15-18 Nisan opsiyon",
        sentAt: SENT,
        items: [],
        groupPropertyId: "mavi",
      }),
    ).toEqual({ kind: "none", why: "no_items" });
  });
});

describe("oluşturma", () => {
  it("geçerli opsiyon: apply, tek aralık; süre yalnız mesajda yazıyorsa", () => {
    expect(only("15-18 Nisan opsiyon")).toEqual({
      item_no: 0,
      intent: "create",
      decision: "apply",
      reasons: [],
      check_in: "2027-04-15",
      check_out: "2027-04-18",
      expires_in_minutes: null,
      end_reason: null,
    });
    expect(only("15-18 Nisan opsiyon süresi 48 saat").expires_in_minutes).toBe(2880);
    expect(only("15-18 Nisan 2 gün opsiyon").expires_in_minutes).toBe(2880);
  });

  it.each([
    ["15-18 Nisan ve 20-23 Nisan opsiyon", "multiple_ranges"],
    ["Opsiyon", "date_missing"],
    ["15 Nisan opsiyon", "date_unclear"],
    ["Villa Asya 15-18 Nisan opsiyon", "villa_unclear"],
    ["15-18 Nisan opsiyon olabilir", "hedged"],
    ["15-18 Nisan yarın akşama kadar opsiyon", "duration_unclear"],
    ["15-18 Nisan opsiyon süresi 30 gün", "duration_out_of_bounds"],
  ])("%s → onaya (%s)", (m, reason) => {
    const r = only(m);
    expect(r.decision).toBe("ask");
    expect(r.reasons).toContain(reason);
  });

  it("çoklu aralıkta tarih gönderilmez", () => {
    const r = only("15-18 Nisan ve 20-23 Nisan opsiyon");
    expect([r.check_in, r.check_out]).toEqual([null, null]);
  });

  it("soru ve olumsuz ifade: ignore (veritabanı işlem yazmaz)", () => {
    expect(only("15-18 Nisan opsiyon verebilir miyiz?").decision).toBe("ignore");
    expect(only("15-18 Nisan opsiyon vermeyelim").decision).toBe("ignore");
  });

  it("opsiyonla ilgisiz mesaj işlem üretmez", () => {
    expect(decide("15-18 Nisan kapat")).toEqual({ kind: "none", why: "not_option" });
  });
});

describe("iptal", () => {
  it.each([
    ["15-18 Nisan opsiyon müşteri vazgeçti", "customer_declined"],
    ["15-18 Nisan opsiyon müşteri almadı", "customer_declined"],
    ["15-18 Nisan opsiyon düştü", "customer_declined"],
    ["15-18 Nisan opsiyon iptal", "owner_cancelled"],
    ["15-18 Nisan opsiyonu kaldır", "owner_cancelled"],
  ])("%s → %s", (m, reason) => {
    const r = only(m);
    expect(r).toMatchObject({
      intent: "cancel",
      decision: "apply",
      end_reason: reason,
      check_in: "2027-04-15",
      check_out: "2027-04-18",
      expires_in_minutes: null,
    });
  });

  it("iki neden birden (müşteri vazgeçti + iptal) → belirsiz, onaya; neden yazılmaz", () => {
    const r = only("15-18 Nisan opsiyon müşteri vazgeçti iptal edelim");
    expect(r).toMatchObject({ intent: "cancel", decision: "ask", end_reason: null });
    expect(r.reasons).toContain("intent_unclear");
  });

  it("'süresi doldu' → otomatik iptal YOK, onaya", () => {
    for (const m of [
      "15-18 Nisan opsiyonun süresi doldu",
      "15-18 Nisan opsiyon süresi bitti",
      "Opsiyonun süresi doldu",
    ]) {
      const r = only(m);
      expect(r.decision, m).toBe("ask");
      expect(r.end_reason, m).toBeNull();
      expect(r.reasons, m).toContain("intent_unclear");
    }
  });

  it("tarihsiz iptal hiçbir zaman otomatik değil", () => {
    for (const m of ["Opsiyon iptal", "Müşteri vazgeçti", "Opsiyonu kaldır"]) {
      const r = only(m);
      expect(r, m).toMatchObject({ intent: "cancel", decision: "ask", check_in: null });
      expect(r.reasons, m).toContain("date_missing");
    }
  });

  it("panel_cancel WhatsApp'tan üretilmez", () => {
    for (const m of ["panelden iptal opsiyon 15-18 Nisan", "15-18 Nisan opsiyon iptal"]) {
      const d = decide(m);
      if (d.kind === "items") expect(d.items[0]!.end_reason).not.toBe("panel_cancel");
    }
    expect(cancelReasonOf("müşteri vazgeçmedi, opsiyon iptal")).toBe("owner_cancelled");
    expect(cancelReasonOf("opsiyon")).toBeNull();
  });
});

describe("kesinleştirme (Aşama 3e): her zaman Super Admin onayına", () => {
  it.each(["15-18 Nisan ödeme alındı", "15-18 Nisan opsiyon kesinleşti"])(
    "%s → convert / ask (otomatik uygulanmaz)",
    (m) => {
      const r = only(m);
      expect(r).toMatchObject({
        intent: "convert",
        decision: "ask",
        end_reason: null,
        expires_in_minutes: null,
      });
    },
  );

  it("tarihli kesinleştirmede tarih gönderilir; soru işlem üretmez", () => {
    expect(only("15-18 Nisan ödeme alındı")).toMatchObject({
      check_in: "2027-04-15",
      check_out: "2027-04-18",
    });
    expect(only("15-18 Nisan ödeme alındı mı?").decision).toBe("ignore");
  });
});

describe("gölge kararıyla birebir aynı (indirgeme bilgi kaybetmez)", () => {
  it.each([
    "15-18 Nisan opsiyon",
    "15-18 Nisan opsiyon süresi 24 saat",
    "15-18 Nisan ve 20-23 Nisan opsiyon",
    "Villa Asya 15-18 Nisan opsiyon",
    "15 Nisan opsiyon",
    "Opsiyon",
    "15-18 Nisan opsiyon olabilir",
    "15-18 Nisan opsiyon verebilir miyiz?",
    "20-23 Kasım opsiyon süresi 10 gün",
  ])("%s", (m) => {
    const [s] = analyzeOptionShadow({
      body: m,
      sentAt: SENT,
      items: storeItems(m),
      groupPropertyId: "mavi",
    });
    const r = only(m);
    expect([
      r.intent,
      r.decision,
      r.reasons,
      r.check_in,
      r.check_out,
      r.expires_in_minutes,
    ]).toEqual([
      s!.intent,
      s!.decision,
      s!.reasons,
      s!.check_in,
      s!.check_out,
      s!.expires_in_minutes,
    ]);
  });
});

describe("yalıtım", () => {
  it("3d dosyaları worker'ı, ayrıştırıcıyı, tepki kuyruğunu, rezervasyon / API / iCal modüllerini içe aktarmaz; yalnız saf gölge fonksiyonu ve tipler", () => {
    for (const f of [
      "src/server/options/decide.ts",
      "src/server/options/intent.ts",
      "src/server/options/message-handler.ts",
      "src/server/options/maintenance.ts",
      "src/server/options/run.ts",
    ]) {
      const src = readFileSync(f, "utf8");
      const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
      const wa = imports.filter((i) => /whatsapp|reservations|ical|api\//.test(i));
      expect(
        wa.every((i) =>
          [
            "@/server/whatsapp/calendar/option-shadow",
            "@/server/whatsapp/calendar/proposal",
          ].includes(i),
        ),
        f,
      ).toBe(true);
      expect(src).not.toMatch(/app_wa_queue_reaction|wa_message_reactions|app_wa_claim/);
    }
  });
});
