import { createHash, randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { DB_CASING } from "@/db/casing";
import * as schema from "@/db/schema";
import { createStandaloneDb } from "@/db/standalone";
import { type TenantContext, type Tx, withTenant } from "@/db/tenant";
import { createLogger } from "@/lib/logger";
import { addDays, istanbulToday } from "@/lib/reservation-meta";
import {
  OPTION_MAINTENANCE_LOCK,
  type OptionMaintenanceDeps,
  type OptionMessageHandler,
  runOptionMaintenance,
} from "@/server/options/run";
import { createProperty } from "@/server/properties/service";
import {
  createReservation,
  findConflicts,
  listCalendarEntries,
} from "@/server/reservations/service";
import { createAutoChanger } from "@/server/whatsapp/auto-change";
import { createAutoCloser } from "@/server/whatsapp/auto-close";
import { createAutoOpener } from "@/server/whatsapp/auto-open";
import { runCalendarWorker, type WorkerDeps } from "@/server/whatsapp/calendar/worker";
import { createWorkspace } from "@/server/workspaces/service";

import { createTestAdmin } from "./wa-admin";

/**
 * Opsiyon Aşama 3b — option-maintenance görevi (src/server/options/run.ts). Gerçek PostgreSQL;
 * görev üretimdeki gibi createStandaloneDb (tek bağlantı, app_user, FORCE RLS) ile çalışır.
 * Mesajlar ağ geçidi fonksiyonuyla kaydedilir ve üretimdeki worker'la işlenir (yalnız test
 * düzeneği; görev kodu worker'ı içe aktarmaz).
 *
 * Kanıtlananlar: süresi dolan açık opsiyon expired olur (bir kez, geçmişiyle); kesin kayıt / harici
 * olay çakışmasında tek uyarı yazılır, tekrar çalıştırmada mükerrer yok; advisory lock ikinci
 * süreci durdurur, eşzamanlı çalıştırma çift işlem üretmez; kill switch kapalıyken hiçbir mesaj
 * okunmaz; üretim girişinde (işleyici yok) imleç hiç okunmaz; imleç idempotent (done tekrar
 * okunmaz, hata → 5 dk sonra en fazla 3 deneme); görev rezervasyon, blok, harici takvim,
 * müsaitlik, iCal, API, webhook, mesaj durumu, worker önerisi ve WhatsApp tepkisini DEĞİŞTİRMEZ.
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 4 });
const app = drizzle(appPool, { schema, casing: DB_CASING });
const adminRolePool = new Pool({ connectionString: db.adminUrl, max: 2 });
adminRolePool.on("connect", (c) => void c.query("set role app_admin"));
const admin = new Client({ connectionString: db.adminUrl });
const tag = randomBytes(3).toString("hex");
const quiet = createLogger({ service: "option-maintenance-test" }, () => {});
const deps: WorkerDeps = {
  log: quiet,
  autoClose: createAutoCloser(app),
  autoOpen: createAutoOpener(app),
  autoChange: createAutoChanger(app),
};

/** Üretimdeki bağlantı biçimiyle (tek bağlantı) bir görev çalıştırması. */
async function runTask(extra: OptionMaintenanceDeps = {}) {
  const s = createStandaloneDb(db.appUrl, {
    max: 1,
    idleTimeoutMillis: 0,
    statement_timeout: 30_000,
    application_name: "kiraligim-option-maintenance-test",
  });
  try {
    return await runOptionMaintenance(s.db, { log: quiet, ...extra });
  } finally {
    await s.end();
  }
}

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
const PN = `9053278${String(parseInt(tag, 16) % 100_000).padStart(5, "0")}`;
const TODAY = istanbulToday();
const day = (n: number) => addDays(TODAY, n);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let O: U;
let ws: string;
let mavi: string, asya: string;
let conn: string;
let G: { id: string; jid: string };
let adminId: string;
const planCode = `opt3b_${tag}`;
const icalToken = `o3b${tag}`.padEnd(43, "x");

let jidN = 0;
const jidBase = BigInt(`0x${randomBytes(4).toString("hex")}`) % 10_000_000n;
const newJid = () =>
  `120367${String(jidBase).padStart(7, "0")}${String(++jidN).padStart(5, "0")}@g.us`;

async function group(property: string) {
  const jid = newJid();
  await appPool.query("select public.app_wa_sync_group($1, $2, 'Ekip', 4, false, false, true)", [
    conn,
    jid,
  ]);
  const id = (await admin.query("select id from wa_groups where jid = $1", [jid])).rows[0]
    .id as string;
  await admin.query(
    "update wa_groups set status = 'linked', workspace_id = $2, property_id = $3, linked_at = now() where id = $1",
    [id, ws, property],
  );
  return { id, jid };
}

const adminOne = async (text: string, values: unknown[]) => {
  const c = await adminRolePool.connect();
  try {
    return (await c.query<{ out: string }>(text, values)).rows[0]!.out;
  } finally {
    c.release();
  }
};
const setGlobal = (on: boolean) =>
  adminOne("select public.app_option_admin_set_global($1, $2) as out", [adminId, on]);
const setWorkspace = (on: boolean) =>
  adminOne("select public.app_option_admin_set_workspace($1, $2, $3, $4, $5) as out", [
    adminId,
    ws,
    on,
    null,
    [],
  ]);
const setGroup = (g: string, on: boolean) =>
  adminOne("select public.app_option_admin_set_group($1, $2, $3) as out", [adminId, g, on]);

let msgN = 0;
/** Mesajı ağ geçidi fonksiyonuyla kaydeder ve üretimdeki worker'la işler. */
async function send(body: string) {
  const mid = `Q${tag}${++msgN}`;
  await appPool.query(
    "select public.app_wa_ingest_message($1, $2, $3, '1@lid', $4, null, $5, now(), 'live')",
    [conn, G.jid, mid, PN, body],
  );
  await runCalendarWorker(app, deps);
  return (
    await admin.query<{ id: string; status: string }>(
      "select id, status from wa_inbound_messages where wa_message_id = $1",
      [mid],
    )
  ).rows[0]!;
}

async function option(o: { property?: string; checkIn: string; checkOut: string; ttlMs?: number }) {
  const id = uuidv7();
  await admin.query(
    `insert into reservation_options (id, workspace_id, property_id, source, check_in, check_out,
       expires_at, expiry_source, created_by)
     values ($1, $2, $3, 'panel', $4, $5,
       case when $6::int is null then null else now() + make_interval(secs => $6::int / 1000.0) end,
       case when $6::int is null then null else 'manual' end, $7)`,
    [id, ws, o.property ?? mavi, o.checkIn, o.checkOut, o.ttlMs ?? null, O.id],
  );
  return id;
}
const opt = async (id: string) =>
  (await admin.query("select * from reservation_options where id = $1", [id])).rows[0];
const events = async (id: string) =>
  (
    await admin.query(
      "select event, actor_admin_id from reservation_option_events where option_id = $1 order by version",
      [id],
    )
  ).rows;
const alertsOf = async (id: string) =>
  (
    await admin.query(
      "select source_kind, source_id from option_conflict_alerts where option_id = $1 order by source_kind",
      [id],
    )
  ).rows;
const scan = async (message: string) =>
  (
    await admin.query("select status, attempts from option_message_scans where message_id = $1", [
      message,
    ])
  ).rows[0];

async function reservation(property: string, a: string, b: string) {
  return as(O, ws, (tx, ctx) =>
    createReservation(tx, ctx, {
      kind: "reservation",
      propertyId: property,
      checkIn: a,
      checkOut: b,
      status: "confirmed",
      source: "phone",
      guestName: "Misafir Test",
      adults: "2",
      children: "0",
    }),
  );
}

/** Görevden etkilenmemesi gereken HER dış görünüm (işletme + villa + aralık). */
async function outside(property: string, from: string, to: string) {
  const one = async (q: string, p: unknown[]) => (await admin.query(q, p)).rows;
  return {
    reservations: await one(
      `select count(*)::int n, md5(coalesce(string_agg(t::text, '|' order by t.id), '')) h
         from reservations t where t.workspace_id = $1`,
      [ws],
    ),
    external: await one(
      `select md5(coalesce(string_agg(e::text, '|' order by e.id), '')) h
         from external_calendar_events e where e.workspace_id = $1`,
      [ws],
    ),
    panelCalendar: await as(O, ws, (tx) => listCalendarEntries(tx, property, from, to)),
    panelConflicts: await as(O, ws, (tx) => findConflicts(tx, property, from, to)),
    publicBusy: await one("select * from public.app_public_villa_busy($1, $2, $3)", [
      property,
      from,
      to,
    ]),
    apiBusy: await one("select public.app_api_busy_json($1, $2, $3) b", [property, from, to]),
    ical: await one(
      "select calendar_name, uid, check_in, check_out from public.app_ical_export($1)",
      [icalToken],
    ),
    apiDirty: await one("select count(*)::int n from api_calendar_dirty where property_id = $1", [
      property,
    ]),
    apiChanges: await one(
      "select count(*)::int n from api_calendar_changes where property_id = $1",
      [property],
    ),
    webhooks: await one(
      `select count(*)::int n from api_webhook_deliveries d
         join api_calendar_changes c on c.id = d.change_id where c.property_id = $1`,
      [property],
    ),
    messages: await one(
      `select md5(coalesce(string_agg(m.id || m.status || coalesce(m.processed_at::text, '')
              || m.attempts, '|' order by m.id), '')) h
         from wa_inbound_messages m where m.workspace_id = $1`,
      [ws],
    ),
    proposals: await one(
      `select md5(coalesce(string_agg(p::text, '|' order by p.id), '')) h
         from wa_calendar_proposals p where p.workspace_id = $1`,
      [ws],
    ),
    reactions: await one("select count(*)::int n from wa_message_reactions", []),
  };
}

beforeAll(async () => {
  await admin.connect();
  O = await mkUser("o3b");
  ws = (await createWorkspace(app, { userId: O.id, name: "Opsiyon 3b", slug: `o3b-${tag}` })).id;
  const planId = uuidv7();
  await admin.query(
    "insert into plans (id, code, name, max_properties, trial_days, is_active, is_default) values ($1, $2, 'O3B', 20, 14, true, false)",
    [planId, planCode],
  );
  await admin.query("update workspace_subscriptions set plan_id = $1 where workspace_id = $2", [
    planId,
    ws,
  ]);
  const villa = (name: string) =>
    as(O, ws, (tx, ctx) =>
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
  mavi = await villa("Villa Mavi");
  asya = await villa("Villa Asya");
  conn = (
    await appPool.query<{ id: string }>("select public.app_wa_heartbeat($1, 'open', null) as id", [
      `o3b-${tag}`,
    ])
  ).rows[0]!.id;
  await admin.query(
    "insert into wa_verified_phones (user_id, phone_hash, phone_masked) values ($1, $2, '+90 532 *** ** 02')",
    [O.id, phoneHash(PN)],
  );
  await admin.query(
    "insert into property_ical_exports (property_id, workspace_id, token, created_by) values ($1, $2, $3, $4)",
    [mavi, ws, icalToken, O.id],
  );
  G = await group(mavi);
  adminId = await createTestAdmin(admin, "opsiyon3b");
  await runCalendarWorker(app, deps); // ilk aktivasyon
});

afterAll(async () => {
  // Bütün anahtarlar KAPALI bırakılır.
  await admin.query("update option_automation_global set enabled = false where id = 1");
  await admin.query("delete from wa_inbound_messages where workspace_id = $1", [ws]);
  await admin.query(
    "update external_calendar_sources set is_active = false where workspace_id = $1",
    [ws],
  );
  await admin.query(
    "update workspace_subscriptions set plan_id = (select id from plans where is_default) where workspace_id = $1",
    [ws],
  );
  await admin.query("delete from plans where code = $1", [planCode]);
  await admin.end();
  await adminRolePool.end();
  await appPool.end();
});

// ---------------------------------------------------------------------------------------------
describe("süre dolumu", () => {
  it("süresi dolan açık opsiyonlar expired olur (geçmiş, aktörsüz); süresiz ve henüz dolmamış değişmez; ikinci çalıştırma hiçbir şey yapmaz", async () => {
    const due = [
      await option({ checkIn: day(200), checkOut: day(202), ttlMs: 500 }),
      await option({ checkIn: day(203), checkOut: day(205), ttlMs: 500 }),
      await option({ property: asya, checkIn: day(200), checkOut: day(202), ttlMs: 500 }),
    ];
    const later = await option({ checkIn: day(206), checkOut: day(208), ttlMs: 3_600_000 });
    const noExpiry = await option({ checkIn: day(209), checkOut: day(211) });
    const laterBefore = await opt(later);
    const noExpiryBefore = await opt(noExpiry);
    await sleep(800);

    const first = await runTask({ expireBatch: 2 }); // iki tur: 2 + 1
    expect(first).toMatchObject({ locked: true, messages: "disabled", failedSteps: [] });
    expect((first as { expired: number }).expired).toBeGreaterThanOrEqual(3);
    for (const id of due) {
      expect(await opt(id)).toMatchObject({ status: "expired", end_reason: "expired" });
      expect(await events(id)).toEqual([
        { event: "created", actor_admin_id: null },
        { event: "expired", actor_admin_id: null },
      ]);
    }
    expect(await opt(later)).toEqual(laterBefore);
    expect(await opt(noExpiry)).toEqual(noExpiryBefore);

    const versions = await Promise.all(due.map(async (id) => (await opt(id)).version));
    const second = await runTask();
    expect(second).toMatchObject({ locked: true, expired: 0, failedSteps: [] });
    expect(await Promise.all(due.map(async (id) => (await opt(id)).version))).toEqual(versions);
    for (const id of due) expect(await events(id)).toHaveLength(2);
  });

  it("kapanmış (iptal) opsiyon süre dolumundan etkilenmez", async () => {
    const id = await option({ checkIn: day(212), checkOut: day(214), ttlMs: 500 });
    expect(
      await adminOne("select public.app_option_admin_cancel($1, $2, 1, null) as out", [
        adminId,
        id,
      ]),
    ).toBe("cancelled");
    const before = await opt(id);
    await sleep(700);
    await runTask();
    expect(await opt(id)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------------------------
describe("çakışma uyarısı", () => {
  it("açık opsiyonla çakışan kesin kayıt ve harici olay → kaynak başına tek uyarı; tekrar çalıştırmada mükerrer yok; opsiyon / kayıt / olay değişmez", async () => {
    const id = await option({ property: asya, checkIn: day(220), checkOut: day(225) });
    const free = await option({ property: asya, checkIn: day(240), checkOut: day(242) });
    const r = await reservation(asya, day(223), day(227));
    await reservation(asya, day(230), day(232)); // çakışmaz
    const src = uuidv7();
    await admin.query(
      `insert into external_calendar_sources (id, workspace_id, property_id, name, url)
       values ($1, $2, $3, 'Takvim', 'https://ornek.com/x.ics')`,
      [src, ws, asya],
    );
    // Başka test dosyalarının iCal senkronu bu kaynağı almasın (yalnız çakışma kaynağı).
    await admin.query(
      "update external_calendar_sources set locked_until = now() + interval '1 day' where id = $1",
      [src],
    );
    const ev = uuidv7();
    await admin.query(
      `insert into external_calendar_events (id, workspace_id, property_id, source_id, uid, start_date, end_date)
       values ($1, $2, $3, $4, 'u-3b', $5, $6)`,
      [ev, ws, asya, src, day(219), day(221)],
    );
    const optBefore = await opt(id);
    const view = await outside(asya, day(215), day(245));

    const a = await runTask();
    expect(a).toMatchObject({ locked: true, failedSteps: [] });
    expect((a as { alerts: number }).alerts).toBeGreaterThanOrEqual(2);
    expect(await alertsOf(id)).toEqual([
      { source_kind: "external_event", source_id: ev },
      { source_kind: "reservation", source_id: r },
    ]);
    expect(await alertsOf(free)).toEqual([]);

    const b = await runTask();
    const c = await runTask();
    expect(b).toMatchObject({ alerts: 0 });
    expect(c).toMatchObject({ alerts: 0 });
    expect(await alertsOf(id)).toHaveLength(2);
    expect(await opt(id)).toEqual(optBefore);
    expect(await outside(asya, day(215), day(245))).toEqual(view);
  });

  it("süresi dolmuş / kapanmış opsiyon için uyarı yazılmaz", async () => {
    const id = await option({ property: asya, checkIn: day(250), checkOut: day(252), ttlMs: 500 });
    await sleep(700);
    await reservation(asya, day(251), day(253));
    await runTask();
    expect(await opt(id)).toMatchObject({ status: "expired" });
    expect(await alertsOf(id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("kilit ve tekrar çalışma güvenliği", () => {
  it("kilit başka süreçteyse görev hiçbir şey yapmadan çıkar; kilit bırakılınca normal çalışır ve kilidi bırakır", async () => {
    const id = await option({ checkIn: day(260), checkOut: day(262), ttlMs: 500 });
    await sleep(700);
    const holder = new Client({ connectionString: db.appUrl });
    await holder.connect();
    try {
      await holder.query("select pg_advisory_lock(hashtextextended($1, 0))", [
        OPTION_MAINTENANCE_LOCK,
      ]);
      expect(await runTask()).toEqual({ locked: false });
      expect(await opt(id)).toMatchObject({ status: "open" });
      await holder.query("select pg_advisory_unlock(hashtextextended($1, 0))", [
        OPTION_MAINTENANCE_LOCK,
      ]);
      expect(await runTask()).toMatchObject({ locked: true });
      expect(await opt(id)).toMatchObject({ status: "expired" });
      // Görev kilidi bıraktı: başka oturum hemen alabilir.
      const again = (
        await holder.query("select pg_try_advisory_lock(hashtextextended($1, 0)) ok", [
          OPTION_MAINTENANCE_LOCK,
        ])
      ).rows[0].ok;
      expect(again).toBe(true);
      await holder.query("select pg_advisory_unlock_all()");
    } finally {
      await holder.end();
    }
  });

  it("eşzamanlı çalıştırmalar aynı opsiyonu ikinci kez işlemez, aynı uyarıyı ikinci kez yazmaz", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++)
      ids.push(await option({ checkIn: day(270 + i * 3), checkOut: day(271 + i * 3), ttlMs: 500 }));
    const c = await option({ checkIn: day(300), checkOut: day(304) });
    await reservation(mavi, day(301), day(302));
    await sleep(700);
    const runs = await Promise.all([runTask(), runTask(), runTask()]);
    expect(runs.some((r) => r.locked)).toBe(true);
    for (const id of ids) {
      expect(await opt(id)).toMatchObject({ status: "expired", version: 2 });
      expect(await events(id)).toHaveLength(2);
    }
    expect(await alertsOf(c)).toHaveLength(1);
  });

  it("kilidi tutan bağlantı koparsa (süreç düştü) kilit kendiliğinden bırakılır", async () => {
    const holder = new Client({ connectionString: db.appUrl });
    await holder.connect();
    await holder.query("select pg_advisory_lock(hashtextextended($1, 0))", [
      OPTION_MAINTENANCE_LOCK,
    ]);
    expect(await runTask()).toEqual({ locked: false });
    await holder.end();
    await sleep(100);
    expect(await runTask()).toMatchObject({ locked: true });
  });
});

// ---------------------------------------------------------------------------------------------
describe("kill switch ve mesaj imleci", () => {
  const handled: string[] = [];
  /** Aşama 3d işleyicisinin yerine: yalnız bu testin mesajlarına işlem yazar. */
  const handler =
    (mode: "apply" | "fail"): OptionMessageHandler =>
    async (exec, m) => {
      handled.push(m.messageId);
      if (m.workspaceId !== ws) return;
      if (mode === "fail") throw Object.assign(new Error("decide_failed"), { code: "TEST" });
      await (exec as typeof app).execute(
        sql`select * from public.app_wa_option_apply(${m.messageId}::uuid, ${JSON.stringify([
          {
            item_no: 0,
            intent: "create",
            decision: "apply",
            reasons: [],
            check_in: day(330),
            check_out: day(333),
            expires_in_minutes: 1440,
          },
        ])}::jsonb)`,
      );
    };

  it("global anahtar KAPALI (varsayılan): işleyici verilse de hiçbir mesaj okunmaz, imleç yazılmaz; süre dolumu yine çalışır", async () => {
    expect(
      (await admin.query("select enabled from option_automation_global where id = 1")).rows[0]
        .enabled,
    ).toBe(false);
    expect(await setWorkspace(true)).toBe("changed");
    expect(await setGroup(G.id, true)).toBe("changed");
    const m = await send("opsiyon mesajı a");
    const exp = await option({ checkIn: day(320), checkOut: day(322), ttlMs: 500 });
    await sleep(700);
    handled.length = 0;
    const r = await runTask({ handleMessage: handler("apply") });
    expect(r).toMatchObject({ messages: { claimed: 0, handled: 0, failed: 0 }, failedSteps: [] });
    expect(handled).toEqual([]);
    expect(await scan(m.id)).toBeUndefined();
    expect(await opt(exp)).toMatchObject({ status: "expired" });
  });

  it("anahtarlar açık ama üretim girişi (işleyici yok): imleç HİÇ okunmaz, mesaj sonradan işlenebilir", async () => {
    expect(await setGlobal(true)).toBe("changed");
    const m = await send("opsiyon mesajı b");
    const r = await runTask();
    expect(r).toMatchObject({ locked: true, messages: "disabled" });
    expect(await scan(m.id)).toBeUndefined();
    // Anahtar açılmadan önce gelen mesaj (a) geriye dönük okunmaz; (b) şimdi okunur.
    handled.length = 0;
    const r2 = await runTask({ handleMessage: handler("apply") });
    expect(handled).toContain(m.id);
    expect(r2).toMatchObject({ failedSteps: [] });
    expect(await scan(m.id)).toEqual({ status: "done", attempts: 1 });
    const ops = (
      await admin.query("select kind, status from option_operations where message_id = $1", [m.id])
    ).rows;
    expect(ops).toEqual([{ kind: "create", status: "applied" }]);
    // İkinci çalıştırma: done imleç tekrar okunmaz, ikinci işlem yazılmaz.
    handled.length = 0;
    await runTask({ handleMessage: handler("apply") });
    expect(handled).not.toContain(m.id);
    expect(
      (
        await admin.query("select count(*)::int n from option_operations where message_id = $1", [
          m.id,
        ])
      ).rows[0].n,
    ).toBe(1);
  });

  it("işleyici hatası: imleç claimed kalır, 5 dk dolmadan tekrar okunmaz; sonra en fazla 3 deneme", async () => {
    const m = await send("opsiyon mesajı c");
    handled.length = 0;
    const r = await runTask({ handleMessage: handler("fail") });
    expect(r).toMatchObject({ failedSteps: [] });
    expect((r as { messages: { failed: number } }).messages.failed).toBeGreaterThanOrEqual(1);
    expect(await scan(m.id)).toEqual({ status: "claimed", attempts: 1 });
    handled.length = 0;
    await runTask({ handleMessage: handler("fail") });
    expect(handled).not.toContain(m.id); // 5 dk dolmadı
    const age = () =>
      admin.query(
        "update option_message_scans set claimed_at = now() - interval '6 minutes' where message_id = $1",
        [m.id],
      );
    await age();
    await runTask({ handleMessage: handler("fail") });
    expect(await scan(m.id)).toEqual({ status: "claimed", attempts: 2 });
    await age();
    await runTask({ handleMessage: handler("fail") });
    expect(await scan(m.id)).toEqual({ status: "claimed", attempts: 3 });
    await age();
    handled.length = 0;
    await runTask({ handleMessage: handler("apply") });
    expect(handled).not.toContain(m.id); // deneme sınırı
    expect(await scan(m.id)).toEqual({ status: "claimed", attempts: 3 });
    expect(
      (
        await admin.query("select count(*)::int n from option_operations where message_id = $1", [
          m.id,
        ])
      ).rows[0].n,
    ).toBe(0);
  });

  it("işleyici hatasından sonra (deneme kalmışsa) ikinci deneme başarılı olur ve tek işlem yazılır", async () => {
    const m = await send("opsiyon mesajı d");
    await runTask({ handleMessage: handler("fail") });
    await admin.query(
      "update option_message_scans set claimed_at = now() - interval '6 minutes' where message_id = $1",
      [m.id],
    );
    await runTask({ handleMessage: handler("apply") });
    expect(await scan(m.id)).toEqual({ status: "done", attempts: 2 });
    expect(
      (
        await admin.query("select count(*)::int n from option_operations where message_id = $1", [
          m.id,
        ])
      ).rows[0].n,
    ).toBe(1);
  });

  it("global kill switch yeniden kapanınca yeni mesaj okunmaz", async () => {
    expect(await setGlobal(false)).toBe("changed");
    const m = await send("opsiyon mesajı e");
    handled.length = 0;
    const r = await runTask({ handleMessage: handler("apply") });
    expect(r).toMatchObject({ messages: { claimed: 0 } });
    expect(await scan(m.id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
describe("mevcut sistem etkilenmez", () => {
  it("açık opsiyon + görev çalıştırmaları: müsaitlik, iCal, API, webhook, rezervasyon, harici olay, mesaj, öneri ve tepki birebir aynı", async () => {
    const from = day(400);
    const to = day(420);
    const before = await outside(mavi, from, to);
    const id = await option({ checkIn: day(405), checkOut: day(410), ttlMs: 500 });
    await option({ checkIn: day(411), checkOut: day(415) });
    expect(await outside(mavi, from, to)).toEqual(before); // opsiyon müsaitliği kapatmaz
    await sleep(700);
    await runTask();
    await runTask();
    expect(await opt(id)).toMatchObject({ status: "expired" });
    expect(await outside(mavi, from, to)).toEqual(before);
    expect((before.publicBusy as unknown[]).length).toBe(0);
    const icalIn = (before.ical as { check_in: string | Date }[]).map((r) =>
      new Date(r.check_in).toISOString().slice(0, 10),
    );
    expect(icalIn).not.toContain(day(405));
    expect(icalIn).not.toContain(day(411));
  });

  it("görev bütün anahtarları KAPALI bırakır; hiçbir ayarı değiştirmez", async () => {
    const settings = async () => ({
      g: (await admin.query("select enabled, updated_at from option_automation_global")).rows,
      w: (
        await admin.query(
          "select automation_enabled, updated_at from workspace_option_settings where workspace_id = $1",
          [ws],
        )
      ).rows,
      gr: (
        await admin.query(
          "select enabled, updated_at from wa_group_option_settings where group_id = $1",
          [G.id],
        )
      ).rows,
    });
    const s = await settings();
    expect(s.g[0].enabled).toBe(false);
    await runTask();
    expect(await settings()).toEqual(s);
  });
});
