/**
 * Opsiyon Aşama 3b — option-maintenance orkestrasyonu (sahte veritabanı).
 * Kanıtlananlar: adım sırası; kilit alınamazsa hiçbir fonksiyon çağrılmaz; kilit her durumda
 * bırakılır; bir adımın hatası diğerini durdurmaz; işleyici yoksa mesaj imleci HİÇ okunmaz;
 * toplu turlar sınırlıdır; log'a mesaj içeriği yazılmaz; görev mevcut worker'ı içe aktarmaz.
 */
import { readFileSync } from "node:fs";

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { createLogger } from "@/lib/logger";
import { runOptionMaintenance } from "@/server/options/run";

const dialect = new PgDialect();

type Script = {
  lock?: boolean;
  expire?: number[];
  alerts?: number[];
  messages?: object[][];
  fail?: Partial<Record<string, string>>;
};

function fakeDb(s: Script = {}) {
  const calls: string[] = [];
  const queues = {
    expire: [...(s.expire ?? [])],
    alerts: [...(s.alerts ?? [])],
    messages: [...(s.messages ?? [])],
  };
  const db = {
    execute: async (q: SQL) => {
      const text = dialect.sqlToQuery(q).sql;
      const fn = /(pg_try_advisory_lock|pg_advisory_unlock|app_[a-z_]+)\(/.exec(text)?.[1] ?? "?";
      calls.push(fn);
      if (s.fail?.[fn]) throw Object.assign(new Error(s.fail[fn]), { code: "XX000" });
      switch (fn) {
        case "pg_try_advisory_lock":
          return { rows: [{ ok: s.lock ?? true }] };
        case "pg_advisory_unlock":
          return { rows: [{ pg_advisory_unlock: true }] };
        case "app_option_expire_due":
          return { rows: [{ n: queues.expire.shift() ?? 0 }] };
        case "app_option_scan_conflicts":
          return { rows: [{ n: queues.alerts.shift() ?? 0 }] };
        case "app_option_claim_messages":
          return { rows: queues.messages.shift() ?? [] };
        default:
          throw new Error(`beklenmeyen sorgu: ${text}`);
      }
    },
  };
  return { db: db as never, calls };
}

function capture() {
  const lines: string[] = [];
  return { log: createLogger({ service: "t" }, (l: string) => lines.push(l)), lines };
}

const msg = (i: number) => ({
  message_id: `m${i}`,
  workspace_id: "w",
  group_id: "g",
  property_id: "p",
  wa_message_id: `wa${i}`,
  body: `GİZLİ MESAJ İÇERİĞİ ${i}`,
  sent_at: "2026-11-15T10:00:00Z",
  attempts: 1,
});

describe("runOptionMaintenance", () => {
  it("sıra: kilit → süre dolumu → çakışma uyarısı → kilidi bırak; işleyici yoksa imleç okunmaz", async () => {
    const { db, calls } = fakeDb({ expire: [2], alerts: [1] });
    const out = await runOptionMaintenance(db);
    expect(calls).toEqual([
      "pg_try_advisory_lock",
      "app_option_expire_due",
      "app_option_scan_conflicts",
      "pg_advisory_unlock",
    ]);
    expect(out).toEqual({
      locked: true,
      expired: 2,
      alerts: 1,
      messages: "disabled",
      failedSteps: [],
    });
  });

  it("kilit alınamazsa hiçbir fonksiyon çağrılmaz ve kilit bırakılmaz", async () => {
    const { db, calls } = fakeDb({ lock: false });
    expect(await runOptionMaintenance(db, { handleMessage: async () => {} })).toEqual({
      locked: false,
    });
    expect(calls).toEqual(["pg_try_advisory_lock"]);
  });

  it("dolu tur tekrarlanır, eksik tur durur; tur sayısı sınırlı", async () => {
    const a = fakeDb({ expire: [3, 3, 1], alerts: [0] });
    const r = await runOptionMaintenance(a.db, { expireBatch: 3 });
    expect(r).toMatchObject({ expired: 7 });
    expect(a.calls.filter((c) => c === "app_option_expire_due")).toHaveLength(3);

    const b = fakeDb({ expire: Array(50).fill(3), alerts: [0] });
    await runOptionMaintenance(b.db, { expireBatch: 3, maxRounds: 4 });
    expect(b.calls.filter((c) => c === "app_option_expire_due")).toHaveLength(4);
  });

  it("süre bütçesi bitince yeni tur başlamaz (kilit yine bırakılır)", async () => {
    let t = 0;
    const { db, calls } = fakeDb({ expire: Array(10).fill(3), alerts: [5] });
    const out = await runOptionMaintenance(db, {
      expireBatch: 3,
      budgetMs: 100,
      now: () => (t += 60),
    });
    expect(calls.filter((c) => c === "app_option_expire_due")).toHaveLength(1);
    expect(calls.at(-1)).toBe("pg_advisory_unlock");
    expect(out).toMatchObject({ locked: true, failedSteps: [] });
  });

  it("bir adımın hatası diğerini durdurmaz; kilit bırakılır; log'da yalnız kısa kod", async () => {
    const { log, lines } = capture();
    const { db, calls } = fakeDb({
      alerts: [4],
      fail: { app_option_expire_due: "canceling statement due to statement timeout" },
    });
    const out = await runOptionMaintenance(db, { log });
    expect(calls).toEqual([
      "pg_try_advisory_lock",
      "app_option_expire_due",
      "app_option_scan_conflicts",
      "pg_advisory_unlock",
    ]);
    expect(out).toMatchObject({ expired: 0, alerts: 4, failedSteps: ["expire"] });
    expect(lines.join("\n")).toContain('"code":"XX000"');
    expect(lines.join("\n")).not.toContain("statement timeout");
  });

  it("kilidi bırakma hatası sonucu bozmaz", async () => {
    const { db } = fakeDb({ fail: { pg_advisory_unlock: "x" } });
    expect(await runOptionMaintenance(db)).toMatchObject({ locked: true, failedSteps: [] });
  });

  it("işleyici verilirse imleç okunur; işleyici hatası yalnız o mesajı etkiler; içerik loglanmaz", async () => {
    const { log, lines } = capture();
    const seen: string[] = [];
    const { db, calls } = fakeDb({ messages: [[msg(1), msg(2), msg(3)]] });
    const out = await runOptionMaintenance(db, {
      log,
      messageBatch: 20,
      handleMessage: async (_db, m) => {
        seen.push(m.messageId);
        if (m.messageId === "m2") throw new Error(m.body);
        expect(m.sentAt).toBeInstanceOf(Date);
      },
    });
    expect(seen).toEqual(["m1", "m2", "m3"]);
    expect(out).toMatchObject({ messages: { claimed: 3, handled: 2, failed: 1 }, failedSteps: [] });
    expect(calls.filter((c) => c === "app_option_claim_messages")).toHaveLength(1);
    expect(lines.join("\n")).not.toContain("GİZLİ");
  });

  it("imleç sorgusu hata verirse adım başarısız sayılır, kilit bırakılır", async () => {
    const { db, calls } = fakeDb({ fail: { app_option_claim_messages: "boom" } });
    const out = await runOptionMaintenance(db, { handleMessage: async () => {} });
    expect(out).toMatchObject({ failedSteps: ["messages"] });
    expect(calls.at(-1)).toBe("pg_advisory_unlock");
  });

  it("görev kodu mevcut worker'ı, ayrıştırıcıyı, tepki ve rezervasyon modüllerini içe aktarmaz", () => {
    for (const f of ["src/server/options/run.ts", "src/server/options/maintenance.ts"]) {
      const src = readFileSync(f, "utf8");
      const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      expect(
        imports.filter((i) => /whatsapp|reservations|wa-calendar|ical|api\//.test(i!)),
      ).toEqual([]);
    }
  });
});
