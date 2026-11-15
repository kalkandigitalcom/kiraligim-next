/**
 * Opsiyon Aşama 2 — gölge mod: saf analiz (option-shadow.ts), merkezi ayar ve worker kancası.
 *
 * Değişmezler: gölge mod KAPALIYKEN worker hiçbir ek sorgu yapmaz ve çıktısı birebir aynıdır;
 * AÇIKKEN yalnız app_wa_store_option_shadow çağrılır (öneri, tepki ve takvim çağrıları aynı kalır),
 * hata da işlemi bozmaz.
 */
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { optionShadowEnabled, SHADOW_REASONS } from "@/lib/option-meta";
import { parseCalendarMessage, WA_CALENDAR_PARSER_VERSION } from "@/lib/wa-calendar-parse";
import { analyzeOptionShadow, shadowRelevant } from "@/server/whatsapp/calendar/option-shadow";
import { buildStoreItem } from "@/server/whatsapp/calendar/proposal";
import { resolveProposal } from "@/server/whatsapp/calendar/resolve";
import { type ClaimedMessage, processClaimed } from "@/server/whatsapp/calendar/worker";

import regression from "./fixtures/wa-regression-v8.json";

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

function shadow(body: string, sentAt = SENT) {
  const items = parseCalendarMessage(body, TODAY).items.map((item, i) =>
    buildStoreItem({
      item,
      itemNo: i,
      villa: resolveProposal(item, CTX),
      busy: [],
      senderRole: "participant",
    }),
  );
  return analyzeOptionShadow({ body, sentAt, items, groupPropertyId: "mavi" });
}
const one = (body: string) => {
  const r = shadow(body);
  expect(r, body).toHaveLength(1);
  return r[0]!;
};
const brief = (body: string) => {
  const r = one(body);
  return [r.intent, r.decision, r.reasons];
};

describe("merkezi ayar", () => {
  it("yalnız WA_OPTION_SHADOW=on açar; varsayılan ve diğer her değer kapalı", () => {
    expect(optionShadowEnabled({})).toBe(false);
    for (const v of ["", "off", "true", "1", "ON", "On", " on"]) {
      expect([v, optionShadowEnabled({ WA_OPTION_SHADOW: v })]).toEqual([v, false]);
    }
    expect(optionShadowEnabled({ WA_OPTION_SHADOW: "on" })).toBe(true);
  });
});

describe("ilgi: yalnız opsiyon / kesinleşme / iptal bildirimleri", () => {
  it.each([
    "15-18 Nisan kapat",
    "15-18 Nisan tekrar müsait",
    "15-18 Nisan rezervasyonu 16-19 Nisan'a aldık",
    "Günaydın, havuzcu yarın 10'da gelecek",
    "Ödeme henüz gelmedi.",
    "Kapora bekliyoruz.",
    "Müşteri vazgeçmedi",
    "Opsiyonel kahvaltı var, 15-18 Nisan kapalı",
  ])("%s → gölge kaydı yok", (m) => {
    expect(shadowRelevant(m)).toBe(false);
    expect(shadow(m)).toEqual([]);
  });
});

describe("oluşturma (create)", () => {
  it.each([
    "15-18 Nisan opsiyon",
    "15-18 Nisan opsiyona al",
    "Villa Mavi 15-18 Nisan opsiyon",
    "15 Nisan giriş 18 Nisan çıkış opsiyon",
    "15-18 Nisan müşteriye opsiyonlandı",
  ])("%s → create / apply, tek aralık, süresiz", (m) => {
    const r = one(m);
    expect(r).toMatchObject({
      intent: "create",
      decision: "apply",
      reasons: [],
      check_in: "2027-04-15",
      check_out: "2027-04-18",
      expires_in_minutes: null,
      item_no: 0,
      parser_version: WA_CALENDAR_PARSER_VERSION,
    });
  });

  it("süre yalnız mesajda yazıyorsa; uydurulmaz", () => {
    expect(one("15-18 Nisan opsiyon süresi 24 saat").expires_in_minutes).toBe(24 * 60);
    expect(one("15-18 Nisan 48 saatlik opsiyon").expires_in_minutes).toBe(48 * 60);
    expect(one("15-18 Nisan 2 gün opsiyon").expires_in_minutes).toBe(2 * 24 * 60);
    expect(one("15-18 Nisan opsiyon").expires_in_minutes).toBeNull();
  });

  it.each([
    ["15-18 Nisan yarın akşama kadar opsiyon", "duration_unclear"],
    ["15-18 Nisan opsiyon süresi 30 gün", "duration_out_of_bounds"],
    ["15-18 Nisan opsiyon süresi 30 dakika", "duration_out_of_bounds"],
    ["20-23 Kasım opsiyon süresi 10 gün", "duration_after_check_in"],
    ["Opsiyon", "date_missing"],
    ["15 Nisan opsiyon", "date_unclear"],
    ["15-18 Nisan opsiyon olabilir", "hedged"],
    ["Villa Asya 15-18 Nisan opsiyon", "villa_unclear"],
    ["15-18 Nisan ve 20-23 Nisan opsiyon", "multiple_ranges"],
    ["15-18 Nisan ve 17-20 Nisan opsiyon", "multiple_ranges"],
  ])("%s → ask (%s)", (m, reason) => {
    const r = one(m);
    expect([r.decision, r.reasons]).toEqual(["ask", expect.arrayContaining([reason])]);
  });

  it("çoklu aralıkta tarih yazılmaz (bir mesaj = bir opsiyon)", () => {
    const r = one("15-18 Nisan ve 20-23 Nisan opsiyon");
    expect([r.check_in, r.check_out]).toEqual([null, null]);
  });

  it("soru ve olumsuz ifade: ignore", () => {
    expect(brief("15-18 Nisan opsiyon verelim mi?")).toEqual(["create", "ignore", ["question"]]);
    expect(brief("15-18 Nisan opsiyon vermeyelim")).toEqual(["create", "ignore", ["negated"]]);
    expect(brief("Opsiyon var mı?")).toEqual(["create", "ignore", ["question"]]);
  });
});

describe("kesinleştirme (convert) ve iptal (cancel)", () => {
  it.each([
    "15-18 Nisan kapora geldi",
    "15-18 Nisan opsiyon kesinleşti",
    "15-18 Nisan ödeme alındı",
    "Villa Mavi 15-18 Nisan ödeme alındı",
  ])("%s → convert, birebir tarih (veritabanı hedefi denetler)", (m) => {
    expect(one(m)).toMatchObject({
      intent: "convert",
      decision: "apply",
      check_in: "2027-04-15",
      check_out: "2027-04-18",
    });
  });

  it.each(["Ödeme alındı.", "Kapora geldi.", "Müşteri onayladı.", "Opsiyon kesinleşti."])(
    "%s → convert, tarihsiz (hedef veritabanında; en fazla ask)",
    (m) => {
      expect(one(m)).toMatchObject({ intent: "convert", check_in: null, check_out: null });
    },
  );

  it.each([
    "15-18 Nisan opsiyon iptal",
    "15-18 Nisan müşteri vazgeçti",
    "Opsiyon iptal.",
    "Opsiyon düştü.",
    "Opsiyonu kaldır.",
    "Opsiyon süresi doldu.",
    "Müşteri almadı.",
    "Ödeme gelmedi, opsiyonu kaldır.",
  ])("%s → cancel", (m) => {
    expect(one(m).intent).toBe("cancel");
  });

  it("süre bilgisi yalnız oluşturmada okunur ('süresi doldu' iptaldir)", () => {
    expect(one("Opsiyon süresi doldu.").expires_in_minutes).toBeNull();
  });

  it("kesinleşme + iptal birlikte: unknown / ask; yalın 'tamam': unknown / ask", () => {
    expect(brief("15-18 Nisan ödeme alındı ama müşteri vazgeçti")).toEqual([
      "unknown",
      "ask",
      ["intent_conflict"],
    ]);
    expect(brief("Opsiyon tamam.")).toEqual(["unknown", "ask", ["intent_unclear"]]);
  });

  it("soru: ignore", () => {
    expect(brief("Müşteri vazgeçer mi acaba")).toEqual(["cancel", "ignore", ["question"]]);
  });
});

describe("regresyon seti (357 mesaj)", () => {
  it("her mesajda en fazla bir karar; nedenler bilinen kodlar; fırlatmaz", () => {
    let n = 0;
    for (const s of regression.senaryolar) {
      const r = shadow(s.mesaj);
      expect(r.length, s.id).toBeLessThanOrEqual(1);
      for (const x of r) {
        n++;
        for (const reason of x.reasons) expect(SHADOW_REASONS, s.id).toContain(reason);
        expect(["apply", "ask", "ignore"]).toContain(x.decision);
        if (x.decision === "apply") expect(x.reasons, s.id).toEqual([]);
      }
    }
    expect(n).toBeGreaterThan(80);
  });
});

// ---------------------------------------------------------------------------------------------
// Worker kancası (sahte veritabanı): kapalıyken birebir aynı, açıkken yalnız gölge çağrısı eklenir
// ---------------------------------------------------------------------------------------------
const dialect = new PgDialect();

function fakeDb(opts: { shadowFails?: boolean } = {}) {
  const calls: string[] = [];
  const db = {
    execute: async (q: SQL) => {
      const text = dialect.sqlToQuery(q).sql;
      const fn = /public\.(app_[a-z_]+)\(/.exec(text)?.[1] ?? "?";
      calls.push(fn);
      switch (fn) {
        case "app_wa_message_context":
          return { rows: [{ property_id: "mavi", name: "Villa Mavi" }] };
        case "app_wa_busy":
          return { rows: [] };
        case "app_wa_store_proposals":
          return { rows: [{ n: 1 }] };
        case "app_wa_queue_reaction":
          return { rows: [{ r: "queued" }] };
        case "app_wa_store_option_shadow":
          if (opts.shadowFails) throw Object.assign(new Error("x"), { code: "40001" });
          return { rows: [{ n: 1 }] };
        default:
          throw new Error(`beklenmeyen çağrı: ${fn}`);
      }
    },
  };
  return { db: db as never, calls };
}

const claim = (body: string): ClaimedMessage => ({
  messageId: "00000000-0000-4000-8000-000000000001",
  lockToken: "00000000-0000-4000-8000-000000000002",
  workspaceId: "w",
  groupId: "g",
  groupPropertyId: "mavi",
  body,
  sentAt: new Date(),
  senderRole: "participant",
  attempts: 1,
});

describe("worker kancası", () => {
  it.each(["15-18 Nisan opsiyon", "Ödeme alındı.", "Opsiyon iptal.", "15-18 Nisan kapat"])(
    "kapalıyken (varsayılan ve false) çağrılar ve sonuç aynı; gölge çağrısı yok: %s",
    async (m) => {
      const a = fakeDb();
      const outA = await processClaimed(a.db, claim(m));
      const b = fakeDb();
      const outB = await processClaimed(b.db, claim(m), { optionShadow: false });
      expect(outB).toEqual(outA);
      expect(b.calls).toEqual(a.calls);
      expect(a.calls).not.toContain("app_wa_store_option_shadow");
      expect(outA).not.toHaveProperty("shadow");
    },
  );

  it("açıkken opsiyon mesajında yalnız gölge çağrısı eklenir (en sonda); diğer çağrılar ve sonuç aynı", async () => {
    const off = fakeDb();
    const outOff = await processClaimed(off.db, claim("15-18 Nisan opsiyon"));
    const on = fakeDb();
    const outOn = await processClaimed(on.db, claim("15-18 Nisan opsiyon"), {
      optionShadow: true,
    });
    expect(on.calls).toEqual([...off.calls, "app_wa_store_option_shadow"]);
    expect(outOn).toEqual({ ...outOff, shadow: 1 });
  });

  it("açıkken opsiyonla ilgisiz mesajda gölge çağrısı yok", async () => {
    const on = fakeDb();
    const out = await processClaimed(on.db, claim("15-18 Nisan kapat"), { optionShadow: true });
    expect(on.calls).not.toContain("app_wa_store_option_shadow");
    expect(out).toMatchObject({ outcome: "stored", shadow: 0 });
  });

  it("gölge yazımı hata verirse işlem bozulmaz (yalnız log)", async () => {
    const off = fakeDb();
    const outOff = await processClaimed(off.db, claim("15-18 Nisan opsiyon"));
    const bad = fakeDb({ shadowFails: true });
    const logs: string[] = [];
    const log = { info: () => {}, warn: (m: string) => logs.push(m), error: () => {} };
    const out = await processClaimed(bad.db, claim("15-18 Nisan opsiyon"), {
      optionShadow: true,
      log,
    });
    expect(out).toEqual({ ...outOff, shadow: 0 });
    expect(logs).toContain("wa_option_shadow_failed");
  });
});
