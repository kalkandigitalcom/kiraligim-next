import { createHash, randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { DB_CASING } from "@/db/casing";
import * as schema from "@/db/schema";
import { type TenantContext, type Tx, withTenant } from "@/db/tenant";
import { createLogger } from "@/lib/logger";
import { addDays, istanbulToday } from "@/lib/reservation-meta";
import { createProperty } from "@/server/properties/service";
import { createReservation } from "@/server/reservations/service";
import {
  type ClaimedMessage,
  claimMessages,
  processClaimed,
  runCalendarWorker,
  type WorkerDeps,
} from "@/server/whatsapp/calendar/worker";
import { addWorkspaceMember, createWorkspace } from "@/server/workspaces/service";

/**
 * WhatsApp Asistanı A2c — takvim worker'ı (drizzle/0037). Gerçek PostgreSQL 17, app_user,
 * FORCE RLS. Worker gerçek kodla (runCalendarWorker / processClaimed) çalışır.
 *
 * Doğrulananlar: ilk aktivasyon ve cutover (eşzamanlı), uçtan uca öneri, iki worker eşzamanlı,
 * tekrar işlememe, kilit kaybı, yazım anında yeniden denetim (yetki, grup bağlantısı, villa
 * aktifliği, grup villası), eski mesaj, rezervasyon/harici takvim tablolarının değişmemesi ve
 * log'da kişisel bilgi olmaması.
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 8 });
const app = drizzle(appPool, { schema, casing: DB_CASING });
const appPool2 = new Pool({ connectionString: db.appUrl, max: 4 });
const app2 = drizzle(appPool2, { schema, casing: DB_CASING });
const admin = new Client({ connectionString: db.adminUrl });
const tag = randomBytes(3).toString("hex");

// Log yakalama: tüm worker çalıştırmaları aynı logger'a yazar; son testte taranır.
const logLines: string[] = [];
const log = createLogger({ service: "wa-calendar-test" }, (line) => logLines.push(line));
const deps = (over: WorkerDeps = {}): WorkerDeps => ({ log, ...over });

type U = { id: string; email: string };
const mkUser = async (label: string): Promise<U> => {
  const u = { id: uuidv7(), email: `${label}.${tag}@ornek.com` };
  await admin.query(
    "insert into users (id, name, email, email_verified) values ($1, $2, $3, true)",
    [u.id, `${label} K`, u.email],
  );
  return u;
};
const as = <R>(u: U, ws: string, fn: (tx: Tx, ctx: TenantContext) => Promise<R>) =>
  withTenant(app, { userId: u.id, workspaceId: ws }, fn);
const phoneHash = (pn: string) => createHash("sha256").update(`wa-phone:${pn}`).digest("hex");

const PN_OWNER = "905321330001";
const PN_MANAGER = "905321330002";
const PN_STAFF = "905321330003";
const PN_STRANGER = "905321330009";
const ALL_PN = [PN_OWNER, PN_MANAGER, PN_STAFF, PN_STRANGER];

const TODAY = istanbulToday();
const day = (n: number) => addDays(TODAY, n);
const AYLAR = [
  "Ocak",
  "Şubat",
  "Mart",
  "Nisan",
  "Mayıs",
  "Haziran",
  "Temmuz",
  "Ağustos",
  "Eylül",
  "Ekim",
  "Kasım",
  "Aralık",
];
const tr = (iso: string) => `${Number(iso.slice(8, 10))} ${AYLAR[Number(iso.slice(5, 7)) - 1]}`;
/** "Villa Mavi 3 Ocak - 8 Ocak kapalı" (bugünden a ve b gün sonra). */
const msg = (villa: string | null, a: number, b: number, verb = "kapalı") =>
  `${villa ? `${villa} ` : ""}${tr(day(a))} - ${tr(day(b))} ${verb}`;

let O: U, M: U, S: U;
let ws: string;
let mavi: string, asya: string, pasif: string;
let conn: string;
const planCode = `wa_wrk_${tag}`;
const VILLA_NAMES = ["Villa Mavi", "Villa Asya", "Villa Pasif", "Villa Lale"];

let jidN = 0;
const jidBase = BigInt(`0x${randomBytes(4).toString("hex")}`) % 10_000_000n;
const newJid = () =>
  `120364${String(jidBase).padStart(7, "0")}${String(++jidN).padStart(5, "0")}@g.us`;

async function linkedGroup(property: string | null): Promise<{ id: string; jid: string }> {
  const jid = newJid();
  await appPool.query("select public.app_wa_sync_group($1, $2, 'Ekip', 4, false, false, true)", [
    conn,
    jid,
  ]);
  const id = (await admin.query("select id from wa_groups where jid = $1", [jid])).rows[0].id;
  await admin.query(
    "update wa_groups set status = 'linked', workspace_id = $2, property_id = $3, linked_at = now() where id = $1",
    [id, ws, property],
  );
  return { id, jid };
}

let msgN = 0;
const bodies: string[] = [];
async function ingest(
  jid: string,
  body: string,
  pn: string = PN_OWNER,
  sentAt?: string,
): Promise<string> {
  bodies.push(body);
  const mid = `K${tag}${++msgN}`;
  const out = await appPool.query<{ s: string }>(
    "select public.app_wa_ingest_message($1, $2, $3, '1@lid', $4, null, $5, coalesce($6::timestamptz, now()), 'live') as s",
    [conn, jid, mid, pn, body, sentAt ?? null],
  );
  expect(out.rows[0]!.s).toBe("stored");
  return (await admin.query("select id from wa_inbound_messages where wa_message_id = $1", [mid]))
    .rows[0].id;
}

const msgRow = async (id: string) =>
  (
    await admin.query(
      "select status, attempts, lock_token, last_error from wa_inbound_messages where id = $1",
      [id],
    )
  ).rows[0];
const proposalsOf = async (messageId: string) =>
  (
    await admin.query(
      "select * from wa_calendar_proposals where message_id = $1 order by item_no",
      [messageId],
    )
  ).rows;
const run = (over: WorkerDeps = {}, d = app) => runCalendarWorker(d, deps(over));
/** Yalnız belirtilen mesajı alır (diğer alınanlar hemen işlenir). */
async function claimOnly(messageId: string): Promise<ClaimedMessage> {
  const claims = await claimMessages(app, 50);
  let mine: ClaimedMessage | undefined;
  for (const c of claims) {
    if (c.messageId === messageId) mine = c;
    else await processClaimed(app, c, deps());
  }
  expect(mine, "mesaj alınmalı").toBeDefined();
  return mine!;
}

async function villa(name: string) {
  return as(O, ws, (tx, ctx) =>
    createProperty(tx, ctx, {
      name,
      propertyType: "villa",
      maxGuests: "6",
      bedrooms: "3",
      bathrooms: "2",
      province: "Antalya",
      district: "Kaş",
    }),
  );
}

/** Takvim tablolarının tam özeti (satır içerikleri dahil). */
async function calendarDigest() {
  const r = await admin.query(`
    select (select count(*) from reservations)::int as r_n,
           (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from reservations t) as r_md5,
           (select count(*) from external_calendar_events)::int as e_n,
           (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from external_calendar_events t) as e_md5`);
  return r.rows[0];
}

let G: { id: string; jid: string };
let digestBefore: Record<string, unknown>;
let blockId: string;

beforeAll(async () => {
  await admin.connect();
  O = await mkUser("wawo");
  M = await mkUser("wawm");
  S = await mkUser("waws");
  ws = (await createWorkspace(app, { userId: O.id, name: "Worker", slug: `waw-${tag}` })).id;
  const planId = uuidv7();
  await admin.query(
    "insert into plans (id, code, name, max_properties, trial_days, is_active, is_default) values ($1, $2, 'WA wrk', 20, 14, true, false)",
    [planId, planCode],
  );
  await admin.query("update workspace_subscriptions set plan_id = $1 where workspace_id = $2", [
    planId,
    ws,
  ]);
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: M.id, role: "manager" }));
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: S.id, role: "staff" }));
  mavi = await villa("Villa Mavi");
  asya = await villa("Villa Asya");
  pasif = await villa("Villa Pasif");
  await admin.query("update properties set status = 'passive' where id = $1", [pasif]);
  conn = (
    await appPool.query<{ id: string }>("select public.app_wa_heartbeat($1, 'open', null) as id", [
      `waw-${tag}`,
    ])
  ).rows[0]!.id;
  for (const [u, pn] of [
    [O, PN_OWNER],
    [M, PN_MANAGER],
    [S, PN_STAFF],
  ] as const) {
    await admin.query(
      "insert into wa_verified_phones (user_id, phone_hash, phone_masked) values ($1, $2, '+90 532 *** ** 01')",
      [u.id, phoneHash(pn)],
    );
  }
  // Çakışma testi için mevcut blok (test kurulumu; worker değil).
  blockId = await as(O, ws, (tx, ctx) =>
    createReservation(tx, ctx, {
      kind: "block",
      propertyId: asya,
      checkIn: day(70),
      checkOut: day(75),
    }),
  );
  G = await linkedGroup(mavi);
  digestBefore = await calendarDigest();
});

afterAll(async () => {
  // Diğer test dosyaları kuyruğu boş varsayar: bu dosyanın mesajları silinir.
  await admin.query("delete from wa_inbound_messages where workspace_id = $1", [ws]);
  await admin.query(
    "update workspace_subscriptions set plan_id = (select id from plans where is_default) where workspace_id = $1",
    [ws],
  );
  await admin.query("delete from plans where code = $1", [planCode]);
  await admin.end();
  await appPool.end();
  await appPool2.end();
});

describe("ilk aktivasyon (güvenli cutover)", () => {
  it("durum tablosu: tek satır, FORCE RLS, app_user ve ağ geçidi erişemez", async () => {
    const t = await admin.query(
      "select relrowsecurity r, relforcerowsecurity f from pg_class where relname = 'wa_calendar_worker_state'",
    );
    expect(t.rows[0]).toEqual({ r: true, f: true });
    const roles = (
      await admin.query<{ rolname: string }>(
        "select rolname from pg_roles where rolname = any($1) order by rolname",
        [["app_user", "app_wa_gateway", "app_worker", "app_admin"]],
      )
    ).rows.map((r) => r.rolname);
    expect(roles).toContain("app_user");
    for (const role of roles) {
      const p = await admin.query(
        "select has_table_privilege($1, 'public.wa_calendar_worker_state', 'SELECT') s, has_table_privilege($1, 'public.wa_calendar_worker_state', 'UPDATE') u",
        [role],
      );
      expect([role, p.rows[0]]).toEqual([role, { s: false, u: false }]);
    }
    expect(
      (await admin.query("select count(*)::int n from wa_calendar_worker_state")).rows[0].n,
    ).toBe(1);
    expect(
      (await admin.query("select count(*)::int n from wa_calendar_worker_state where id <> 1"))
        .rows[0].n,
    ).toBe(0);
  });

  it("migration ile ilk çalıştırma arasındaki mesajlar işlenmez; eşzamanlı ilk çalıştırmalar tek aktivasyon yapar", async () => {
    // Henüz etkinleşmemiş worker (migration sonrası durum).
    await admin.query("update wa_calendar_worker_state set activated_at = null");
    const before = [
      await ingest(G.jid, msg("Villa Mavi", 40, 42)),
      await ingest(G.jid, msg("Villa Mavi", 43, 45), PN_MANAGER),
      await ingest(G.jid, msg(null, 46, 48)),
    ];
    // Kilidi dolmuş eski bir iş de (ör. önceki deneme) aktivasyonda bırakılır.
    await admin.query(
      "update wa_inbound_messages set status = 'processing', lock_token = gen_random_uuid(), locked_until = now() - interval '1 minute', attempts = 1 where id = $1",
      [before[2]],
    );

    const t0 = Date.now();
    const [r1, r2, c1, c2] = await Promise.all([
      run({}, app),
      run({}, app2),
      claimMessages(app, 10),
      claimMessages(app2, 10),
    ]);
    const state = (await admin.query("select activated_at from wa_calendar_worker_state")).rows[0];
    expect(state.activated_at).toBeInstanceOf(Date);
    expect(Math.abs(state.activated_at.getTime() - t0)).toBeLessThan(10_000);
    // Hiçbir çalıştırma aktivasyon öncesi mesaj almadı.
    expect(r1.claimed + r2.claimed).toBe(0);
    expect(c1).toEqual([]);
    expect(c2).toEqual([]);
    for (const id of before) {
      expect(await msgRow(id)).toMatchObject({
        status: "ignored",
        last_error: "before_activation",
      });
      expect(await proposalsOf(id)).toEqual([]);
    }

    // İkinci çalıştırma aktivasyonu değiştirmez; yalnız SONRA gelen mesaj işlenir.
    const after = await ingest(G.jid, msg("Villa Mavi", 50, 52));
    const s = await run();
    expect(s.claimed).toBe(1);
    expect(
      (await admin.query("select activated_at from wa_calendar_worker_state")).rows[0],
    ).toEqual(state);
    expect(await msgRow(after)).toMatchObject({ status: "processed", last_error: null });
    expect(await proposalsOf(after)).toHaveLength(1);
  });

  it("aktivasyondan önce GÖNDERİLMİŞ (sonradan kaydedilmiş) mesaj işlenmez", async () => {
    const act = (await admin.query("select activated_at from wa_calendar_worker_state")).rows[0]
      .activated_at as Date;
    const m = await ingest(
      G.jid,
      msg("Villa Mavi", 53, 54),
      PN_OWNER,
      new Date(act.getTime() - 60_000).toISOString(),
    );
    await run();
    expect(await msgRow(m)).toMatchObject({ status: "ignored", last_error: "before_activation" });
    expect(await proposalsOf(m)).toEqual([]);
  });
});

describe("uçtan uca öneri", () => {
  it("owner: adlı villa → nedensiz kapatma önerisi; tarih gönderim gününe göre", async () => {
    const m = await ingest(G.jid, msg("Villa Mavi", 60, 63));
    await run();
    const [p] = await proposalsOf(m);
    expect(p).toMatchObject({
      status: "pending",
      action: "close",
      property_id: mavi,
      villa_resolution: "named",
      sender_role: "owner",
      check_in: expect.any(Date),
      review_reasons: [],
      band: "high",
      score: 100,
    });
    const d = (
      await admin.query(
        "select check_in::text ci, check_out::text co from wa_calendar_proposals where id = $1",
        [p.id],
      )
    ).rows[0];
    expect(d).toEqual({ ci: day(60), co: day(63) });
    expect(await msgRow(m)).toMatchObject({ status: "processed", attempts: 1 });
  });

  it("adsız mesaj grubun villasını kullanır; takvim dışı mesaj öneri üretmez; soru noop", async () => {
    const single = await ingest(G.jid, msg(null, 64, 66));
    const chat = await ingest(G.jid, "Günaydın, havuzcu yarın 10'da gelecek");
    const question = await ingest(G.jid, `Villa Mavi ${tr(day(67))} - ${tr(day(68))} müsait mi?`);
    await run();
    expect((await proposalsOf(single))[0]).toMatchObject({
      property_id: mavi,
      villa_resolution: "single",
      review_reasons: [],
    });
    expect(await proposalsOf(chat)).toEqual([]);
    expect(await msgRow(chat)).toMatchObject({ status: "ignored", last_error: "no_proposal" });
    expect((await proposalsOf(question))[0]).toMatchObject({ status: "noop", action: null });
  });

  it("STAFF önerisi her zaman elle incelenir", async () => {
    const m = await ingest(G.jid, msg("Villa Mavi", 80, 82), PN_STAFF);
    await run();
    const [p] = await proposalsOf(m);
    expect(p).toMatchObject({ sender_role: "staff", sender_verified: false });
    expect(p.review_reasons).toContain("staff_review_required");
  });

  it("GRUP DIŞI villa: öneri oluşur, bayrak + villa_needs_review (tek tık yok)", async () => {
    const m = await ingest(G.jid, msg("Villa Asya", 84, 86));
    await run();
    const [p] = await proposalsOf(m);
    expect(p).toMatchObject({ property_id: asya, villa_resolution: "named", score: 100 });
    expect(p.flags).toContain("villa_outside_group");
    expect(p.review_reasons).toEqual(["villa_needs_review"]);
  });

  it("pasif ve bilinmeyen villa: bulunamadı; grubun villasına düşülmez", async () => {
    const a = await ingest(G.jid, msg("Villa Pasif", 88, 90));
    const b = await ingest(G.jid, msg("Villa Lavnta", 91, 93));
    await run();
    for (const id of [a, b]) {
      const [p] = await proposalsOf(id);
      expect(p).toMatchObject({ property_id: null, villa_resolution: "none" });
      expect(p.flags).toContain("villa_not_found");
      expect(p.review_reasons).toContain("villa_unresolved");
    }
  });

  it("çakışma: mevcut blok bilgi olarak yazılır ve 'conflict' nedeni eklenir; misafir bilgisi yok", async () => {
    const m = await ingest(G.jid, msg("Villa Asya", 72, 74));
    await run();
    const [p] = await proposalsOf(m);
    expect(p.review_reasons).toContain("conflict");
    expect(p.conflicts).toEqual([
      {
        kind: "block",
        record_id: blockId,
        check_in: day(70),
        check_out: day(75),
        status: "confirmed",
      },
    ]);
  });

  it("rezervasyon ve iptal önerisi her zaman elle incelenir", async () => {
    const m = await ingest(
      G.jid,
      `Villa Mavi ${tr(day(95))} giriş ${tr(day(99))} çıkış, Ahmet Bey 4 kişi rezervasyon`,
    );
    await run();
    const [p] = await proposalsOf(m);
    expect(p).toMatchObject({ action: "reserve" });
    expect(p.reservation_status).not.toBeNull();
    expect(p.review_reasons).toContain("action_requires_review");
  });
});

describe("tekrar işleme ve eşzamanlılık", () => {
  it("iki worker eşzamanlı: her mesaj tam bir kez işlenir", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 16; i++)
      ids.push(await ingest(G.jid, msg("Villa Mavi", 100 + i * 3, 101 + i * 3)));
    const [a, b] = await Promise.all([run({ batchSize: 3 }, app), run({ batchSize: 3 }, app2)]);
    expect(a.claimed + b.claimed).toBe(16);
    expect(a.lockLost + b.lockLost + a.retried + b.retried + a.failed + b.failed).toBe(0);
    for (const id of ids) {
      expect(await msgRow(id)).toMatchObject({ status: "processed", attempts: 1 });
      expect(await proposalsOf(id)).toHaveLength(1);
    }
  });

  it("işlenmiş mesaj bir daha alınmaz; aynı içerik yeniden gelirse 'superseded'", async () => {
    const m = await ingest(G.jid, msg("Villa Mavi", 160, 162));
    await run();
    const s = await run();
    expect(s.claimed).toBe(0);
    expect(await proposalsOf(m)).toHaveLength(1);
    const again = await ingest(G.jid, msg("Villa Mavi", 160, 162));
    await run();
    expect((await proposalsOf(again))[0]).toMatchObject({ status: "superseded" });
  });

  it("KİLİT KAYBI: iş başka çalıştırmaya geçtiyse ilk worker hiçbir şey yazmaz", async () => {
    const m = await ingest(G.jid, msg("Villa Mavi", 165, 167));
    const first = await claimOnly(m);
    let second: ClaimedMessage | undefined;
    const out = await processClaimed(
      app,
      first,
      deps({
        beforeStore: async () => {
          // Kilit süresi doldu ve iş yeniden alındı.
          await admin.query(
            "update wa_inbound_messages set locked_until = now() - interval '1 second' where id = $1",
            [m],
          );
          second = (await claimMessages(app2, 50)).find((c) => c.messageId === m);
        },
      }),
    );
    expect(out).toEqual({ outcome: "lock_lost" });
    expect(await proposalsOf(m)).toEqual([]);
    expect(second).toBeDefined();
    expect(await msgRow(m)).toMatchObject({ status: "processing", attempts: 2 });
    // Yeni sahibi işler; tek öneri.
    expect(await processClaimed(app2, second!, deps())).toEqual({
      outcome: "stored",
      proposals: 1,
    });
    expect(await proposalsOf(m)).toHaveLength(1);
    // Eski belirteçle hata bildirimi de etkisiz.
    const r = await appPool.query("select public.app_wa_fail_message($1, $2, 'x') as r", [
      m,
      first.lockToken,
    ]);
    expect(r.rows[0].r).toBe("lost");
  });

  it("ESKİ MESAJ: 7 günden eski gönderim ve kilidi dolmuş eski iş işlenmez", async () => {
    const old = await ingest(
      G.jid,
      msg("Villa Mavi", 170, 172),
      PN_OWNER,
      new Date(Date.now() - 8 * 86_400_000).toISOString(),
    );
    await run();
    expect(await msgRow(old)).toMatchObject({ status: "ignored", last_error: "too_old" });
    const stale = await ingest(G.jid, msg("Villa Mavi", 173, 175));
    await admin.query(
      "update wa_inbound_messages set status = 'processing', lock_token = gen_random_uuid(), locked_until = now() - interval '1 minute', attempts = 1, sent_at = now() - interval '8 days' where id = $1",
      [stale],
    );
    await run();
    expect(await msgRow(stale)).toMatchObject({ status: "ignored", last_error: "too_old" });
    expect(await proposalsOf(stale)).toEqual([]);
  });
});

describe("yazım anında yeniden denetim (yarış koşulları)", () => {
  it("YETKİ KALKTI: numara kaldırılırsa öneri yazılmaz (ignored: sender_not_authorized)", async () => {
    const m = await ingest(G.jid, msg("Villa Mavi", 180, 182), PN_MANAGER);
    const c = await claimOnly(m);
    const out = await processClaimed(
      app,
      c,
      deps({
        beforeStore: async () => {
          await admin.query("delete from wa_verified_phones where user_id = $1", [M.id]);
        },
      }),
    );
    expect(out).toEqual({ outcome: "stored", proposals: 0 });
    expect(await proposalsOf(m)).toEqual([]);
    expect(await msgRow(m)).toMatchObject({
      status: "ignored",
      last_error: "sender_not_authorized",
    });
    await admin.query(
      "insert into wa_verified_phones (user_id, phone_hash, phone_masked) values ($1, $2, '+90 532 *** ** 02')",
      [M.id, phoneHash(PN_MANAGER)],
    );
  });

  it("YETKİ DEĞİŞTİ: manager → staff olursa öneri staff kuralıyla yazılır", async () => {
    const m = await ingest(G.jid, msg("Villa Mavi", 184, 186), PN_MANAGER);
    const c = await claimOnly(m);
    expect(c.senderRole).toBe("manager");
    await processClaimed(
      app,
      c,
      deps({
        beforeStore: async () => {
          await admin.query(
            "update workspace_members set role = 'staff' where user_id = $1 and workspace_id = $2",
            [M.id, ws],
          );
        },
      }),
    );
    const [p] = await proposalsOf(m);
    expect(p).toMatchObject({ sender_role: "staff", sender_verified: false });
    expect(p.review_reasons).toContain("staff_review_required");
    await admin.query(
      "update workspace_members set role = 'manager' where user_id = $1 and workspace_id = $2",
      [M.id, ws],
    );
  });

  it("GRUP BAĞLANTISI KALDIRILDI (iş alındıktan sonra): hiçbir öneri yazılmaz", async () => {
    const g = await linkedGroup(mavi);
    const m = await ingest(g.jid, msg("Villa Mavi", 190, 192));
    const c = await claimOnly(m);
    const out = await processClaimed(
      app,
      c,
      deps({
        beforeStore: async () => {
          await as(O, ws, (tx) =>
            tx.execute(sql`select public.app_wa_unlink_group(${g.id}::uuid)`),
          );
        },
      }),
    );
    expect(out).toEqual({ outcome: "lock_lost" });
    expect(
      (
        await admin.query("select count(*)::int n from wa_calendar_proposals where group_id = $1", [
          g.id,
        ])
      ).rows[0].n,
    ).toBe(0);
  });

  it("GRUP BAĞLANTISI EŞZAMANLI kaldırılırken yazım bekler; sonra bekleyen öneri kalmaz", async () => {
    const g = await linkedGroup(mavi);
    const m = await ingest(g.jid, msg("Villa Mavi", 194, 196));
    const c = await claimOnly(m);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let unlinkLocked!: () => void;
    const locked = new Promise<void>((r) => (unlinkLocked = r));
    // Bağlantı kesme transaction'ı grubu kilitler ve açık kalır.
    const unlink = as(O, ws, async (tx) => {
      await tx.execute(sql`select public.app_wa_unlink_group(${g.id}::uuid)`);
      unlinkLocked();
      await gate;
    });
    await locked;
    const storing = processClaimed(app2, c, deps());
    await new Promise((r) => setTimeout(r, 300));
    // Yazım, kesme commit edilene kadar bekliyor (grup kilidi).
    expect(await proposalsOf(m)).toEqual([]);
    release();
    await unlink;
    expect(await storing).toEqual({ outcome: "lock_lost" });
    expect(
      (
        await admin.query(
          "select count(*)::int n from wa_calendar_proposals where group_id = $1 and status = 'pending'",
          [g.id],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("GRUP ASKIYA ALINDI: öneri yazılmaz (ignored: group_not_linked)", async () => {
    const g = await linkedGroup(mavi);
    const m = await ingest(g.jid, msg("Villa Mavi", 198, 200));
    const c = await claimOnly(m);
    await processClaimed(
      app,
      c,
      deps({
        beforeStore: async () => {
          await admin.query("update wa_groups set status = 'suspended' where id = $1", [g.id]);
        },
      }),
    );
    expect(await proposalsOf(m)).toEqual([]);
    expect(await msgRow(m)).toMatchObject({ status: "ignored", last_error: "group_not_linked" });
  });

  it("VİLLA PASİFE ALINDI: yazım reddedilir, mesaj yeniden denenir; ikinci denemede 'bulunamadı'", async () => {
    const lale = await villa("Villa Lale");
    const m = await ingest(G.jid, msg("Villa Lale", 202, 204));
    const c = await claimOnly(m);
    const out = await processClaimed(
      app,
      c,
      deps({
        beforeStore: async () => {
          await admin.query("update properties set status = 'passive' where id = $1", [lale]);
        },
      }),
    );
    expect(out).toEqual({ outcome: "retry", code: "context_changed" });
    expect(await proposalsOf(m)).toEqual([]);
    expect(await msgRow(m)).toMatchObject({
      status: "received",
      attempts: 1,
      last_error: "context_changed",
    });
    await run();
    const [p] = await proposalsOf(m);
    expect(p).toMatchObject({ property_id: null, villa_resolution: "none" });
    expect(p.flags).toContain("villa_not_found");
    expect(await msgRow(m)).toMatchObject({ status: "processed", attempts: 2 });
  });

  it("GRUP VİLLASI DEĞİŞTİ: eski bağlamla yazılmaz; yeniden denemede grup dışı olarak işaretlenir", async () => {
    const g = await linkedGroup(mavi);
    const m = await ingest(g.jid, msg("Villa Mavi", 206, 208));
    const c = await claimOnly(m);
    const out = await processClaimed(
      app,
      c,
      deps({
        beforeStore: async () => {
          await admin.query("update wa_groups set property_id = $2 where id = $1", [g.id, asya]);
        },
      }),
    );
    expect(out).toEqual({ outcome: "retry", code: "context_changed" });
    await run();
    const [p] = await proposalsOf(m);
    expect(p).toMatchObject({ property_id: mavi, villa_resolution: "named" });
    expect(p.flags).toContain("villa_outside_group");
    expect(p.review_reasons).toContain("villa_needs_review");
  });

  it("veritabanı savunması: grup dışı villa bayraksız yazılamaz; 'single' yalnız grubun villası", async () => {
    const m = await ingest(G.jid, "x");
    const c = await claimOnly(m);
    const base = {
      item_no: 0,
      parser_version: 2,
      message_excerpt: "x",
      action: "close",
      villa_name_raw: "Asya",
      candidate_property_ids: [],
      check_in: day(210),
      check_out: day(212),
      reservation_status: null,
      conflicts: [],
      score: 100,
      band: "high",
      review_reasons: [],
    };
    const store = (items: object[]) =>
      appPool
        .query("select public.app_wa_store_proposals($1, $2, $3::jsonb)", [
          m,
          c.lockToken,
          JSON.stringify(items),
        ])
        .then(
          () => "ok",
          (e: { message?: string }) => e.message,
        );
    expect(
      await store([{ ...base, property_id: asya, villa_resolution: "named", flags: [] }]),
    ).toBe("wa_context_changed");
    expect(
      await store([{ ...base, property_id: asya, villa_resolution: "single", flags: [] }]),
    ).toBe("wa_context_changed");
    expect(
      await store([{ ...base, property_id: null, villa_resolution: "named", flags: [] }]),
    ).toBe("wa_store_invalid");
    // Bayraklı grup dışı öneri: neden veritabanında eklenir.
    expect(
      await store([
        { ...base, property_id: asya, villa_resolution: "named", flags: ["villa_outside_group"] },
      ]),
    ).toBe("ok");
    expect((await proposalsOf(m))[0].review_reasons).toEqual(["villa_needs_review"]);
  });
});

describe("takvim ve log güvenliği", () => {
  it("worker hiçbir rezervasyon veya harici takvim kaydı oluşturmadı/değiştirmedi", async () => {
    expect(await calendarDigest()).toEqual(digestBefore);
    expect(
      (
        await admin.query(
          "select count(*)::int n from reservations where workspace_id = $1 and (source = 'whatsapp' or origin_proposal_id is not null)",
          [ws],
        )
      ).rows[0].n,
    ).toBe(0);
    // Hiçbir öneri onaylanmadı.
    expect(
      (
        await admin.query(
          "select count(*)::int n from wa_calendar_proposals where workspace_id = $1 and status = 'applied'",
          [ws],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("app_user bağlantısı (worker bağlamı) rezervasyona doğrudan yazamaz", async () => {
    const r = await appPool
      .query(
        "insert into reservations (id, workspace_id, property_id, kind, status, check_in, check_out) values (gen_random_uuid(), $1, $2, 'block', 'confirmed', $3, $4)",
        [ws, mavi, day(300), day(301)],
      )
      .then(
        () => "ok",
        (e: { code?: string }) => e.code,
      );
    expect(r).not.toBe("ok");
  });

  it("log: mesaj metni, villa adı, telefon ve numara özeti yok; yalnız kimlik ve sayaç", async () => {
    expect(logLines.length).toBeGreaterThan(10);
    const all = logLines.join("\n");
    const forbidden = [
      ...ALL_PN,
      ...ALL_PN.map(phoneHash),
      ...VILLA_NAMES,
      "Günaydın",
      "havuzcu",
      "Ahmet",
      "Lavnta",
      ...AYLAR.map((a) => ` ${a}`),
    ];
    for (const f of forbidden) expect([f, all.includes(f)]).toEqual([f, false]);
    for (const b of bodies.filter((x) => x.length >= 8)) expect(all.includes(b)).toBe(false);
    for (const line of logLines) {
      const o = JSON.parse(line) as Record<string, unknown>;
      for (const k of ["body", "text", "excerpt", "sender", "senderHash", "phone", "villa", "err"])
        expect([k, k in o]).toEqual([k, false]);
    }
    // Hata yolları da log'landı (context_changed vb.), yine içeriksiz.
    expect(all).toContain("wa_context_changed");
  });
});
