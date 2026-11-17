import { createHash, randomBytes } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { DB_CASING } from "@/db/casing";
import { createStandaloneDb } from "@/db/standalone";
import * as schema from "@/db/schema";
import { type TenantContext, type Tx, withTenant } from "@/db/tenant";
import { createLogger } from "@/lib/logger";
import { addDays, istanbulToday } from "@/lib/reservation-meta";
import { listOptionLinks } from "@/server/admin/options";
import { createOptionMessageHandler } from "@/server/options/message-handler";
import { runOptionMaintenance } from "@/server/options/run";
import { createProperty } from "@/server/properties/service";
import { createAutoChanger } from "@/server/whatsapp/auto-change";
import { createAutoCloser } from "@/server/whatsapp/auto-close";
import { createAutoOpener } from "@/server/whatsapp/auto-open";
import { runCalendarWorker, type WorkerDeps } from "@/server/whatsapp/calendar/worker";
import { createWorkspace } from "@/server/workspaces/service";

import { createTestAdmin } from "./wa-admin";

/**
 * Opsiyon — sabit 24 saatlik opsiyon (drizzle/0075 + 0076). Gerçek PostgreSQL: görev fonksiyonu
 * app_user ile, Super Admin fonksiyonları gerçek app_admin rolüyle.
 *
 * Kanıtlananlar: süre yazılmamış opsiyon SABİT 24 saat ('system_default'); işletme varsayılanı ve
 * sistem varsayılanı sütunu artık OKUNMAZ (değerleri ne olursa olsun 24 saat); süre ayarı
 * fonksiyonları (işletme sahibi / Super Admin) yok; mesajda açıkça yazılan süre aynen kullanılır,
 * girişi aşarsa opsiyon YOK ve kısaltma YOK (açıklama bekler); sabit süre girişi aşarsa bitiş giriş
 * anına çekilir, girişe 60 dakikadan az kaldıysa açıklama bekler; başlamış / geçmiş giriş otomatik
 * işlenmez; "açıklama bekliyor" işlemleri hiçbir görev almaz, Super Admin onaylayamaz ama teknik
 * takip için listeler; iptal / kesinleştirme belirsizlikleri eskisi gibi Super Admin onayına düşer;
 * işletme rolleri opsiyon tablolarına yazamaz (yönetim yalnız WhatsApp'tan).
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 6 });
const app = drizzle(appPool, { schema, casing: DB_CASING });
const adminRolePool = new Pool({ connectionString: db.adminUrl, max: 3 });
adminRolePool.on("connect", (c) => void c.query("set role app_admin"));
const admin = new Client({ connectionString: db.adminUrl });
const tag = randomBytes(3).toString("hex");
const log = createLogger({ service: "option-extend-reschedule-test" }, () => {});
const deps: WorkerDeps = {
  log,
  autoClose: createAutoCloser(app),
  autoOpen: createAutoOpener(app),
  autoChange: createAutoChanger(app),
};

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
const PN = `9053288${String(parseInt(tag, 16) % 100_000).padStart(5, "0")}`;
const TODAY = istanbulToday();
const day = (n: number) => addDays(TODAY, n);

let O: U, X: U;
let ws: string, wsX: string;
let mavi: string;
let conn: string;
let G: { id: string; jid: string };
let adminId: string;
const planCode = `opt_fb_${tag}`;

let jidN = 0;
const jidBase = BigInt(`0x${randomBytes(4).toString("hex")}`) % 10_000_000n;
const newJid = () =>
  `120367${String(jidBase).padStart(7, "0")}${String(++jidN).padStart(5, "0")}@g.us`;

async function group(workspace: string, property: string) {
  const jid = newJid();
  await appPool.query("select public.app_wa_sync_group($1, $2, 'Ekip', 4, false, false, true)", [
    conn,
    jid,
  ]);
  const id = (await admin.query("select id from wa_groups where jid = $1", [jid])).rows[0]
    .id as string;
  await admin.query(
    "update wa_groups set status = 'linked', workspace_id = $2, property_id = $3, linked_at = now() where id = $1",
    [id, workspace, property],
  );
  return { id, jid };
}

async function asAdmin<T = Record<string, unknown>>(text: string, values: unknown[]) {
  const c = await adminRolePool.connect();
  try {
    return (await c.query(text, values)).rows as T[];
  } finally {
    c.release();
  }
}
const adminOne = async (text: string, values: unknown[]) =>
  (await asAdmin<{ out: string }>(text, values))[0]!.out;
const setGlobal = (on: boolean) =>
  adminOne("select public.app_option_admin_set_global($1, $2) as out", [adminId, on]);

let msgN = 0;
async function send(body: string, jid = G.jid, pn = PN) {
  const mid = `FB${tag}${++msgN}`;
  await appPool.query(
    "select public.app_wa_ingest_message($1, $2, $3, '1@lid', $4, null, $5, now(), 'live')",
    [conn, jid, mid, pn, body],
  );
  await runCalendarWorker(app, deps);
  return (
    await admin.query<{ id: string; sent_at: Date }>(
      "select id, sent_at from wa_inbound_messages where wa_message_id = $1",
      [mid],
    )
  ).rows[0]!;
}
const claim = async () =>
  (await appPool.query("select * from public.app_option_claim_messages(50)")).rows;
const apply = async (message: string, items: object[]) =>
  (
    await appPool.query("select * from public.app_wa_option_apply($1, $2::jsonb)", [
      message,
      JSON.stringify(items),
    ])
  ).rows;
const item = (o: object) => ({ item_no: 0, decision: "apply", reasons: [], ...o });
const op = async (id: string) =>
  (await admin.query("select * from option_operations where id = $1", [id])).rows[0];
const opt = async (id: string) =>
  (await admin.query("select * from reservation_options where id = $1", [id])).rows[0];

async function villa(name: string, owner: U, workspace: string) {
  return as(owner, workspace, (tx, ctx) =>
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

beforeAll(async () => {
  await admin.connect();
  O = await mkUser("fbo");
  X = await mkUser("fbx");
  ws = (await createWorkspace(app, { userId: O.id, name: "Faz B", slug: `fb-${tag}` })).id;
  wsX = (await createWorkspace(app, { userId: X.id, name: "Faz B Başka", slug: `fbx-${tag}` })).id;
  const planId = uuidv7();
  await admin.query(
    "insert into plans (id, code, name, max_properties, trial_days, is_active, is_default) values ($1, $2, 'FB', 20, 14, true, false)",
    [planId, planCode],
  );
  await admin.query(
    "update workspace_subscriptions set plan_id = $1 where workspace_id in ($2, $3)",
    [planId, ws, wsX],
  );
  mavi = await villa("Villa Mavi", O, ws);
  await villa("Villa Başka", X, wsX);
  conn = (
    await appPool.query<{ id: string }>("select public.app_wa_heartbeat($1, 'open', null) as id", [
      `fb-${tag}`,
    ])
  ).rows[0]!.id;
  await admin.query(
    "insert into wa_verified_phones (user_id, phone_hash, phone_masked) values ($1, $2, '+90 532 *** ** 02')",
    [O.id, phoneHash(PN)],
  );
  G = await group(ws, mavi);
  adminId = await createTestAdmin(admin, "fazb");
  await runCalendarWorker(app, deps);
  await setGlobal(true);
});

afterAll(async () => {
  // Diğer test dosyaları için: kill switch kapalı.
  await admin.query(
    "update option_automation_global set enabled = false, default_duration_minutes = 1440 where id = 1",
  );
  await admin.query("delete from wa_inbound_messages where workspace_id = any($1)", [[ws, wsX]]);
  await admin.query(
    "update workspace_subscriptions set plan_id = (select id from plans where is_default) where workspace_id in ($1, $2)",
    [ws, wsX],
  );
  await admin.query("delete from plans where code = $1", [planCode]);
  await admin.end();
  await adminRolePool.end();
  await appPool.end();
});

// ---------------------------------------------------------------------------------------------
/** Fonksiyonun bu test için kopyasında now() sabitlenir; çıkışta özgün tanım geri yüklenir. */
async function withClock<T>(at: Date, fn: () => Promise<T>): Promise<T> {
  const def = (
    await admin.query(
      "select pg_get_functiondef('public.app_wa_option_apply(uuid, jsonb)'::regprocedure) d",
    )
  ).rows[0].d as string;
  const patched = def.replaceAll("pg_catalog.now()", `'${at.toISOString()}'::timestamptz`);
  expect(patched).not.toBe(def);
  await admin.query(patched);
  try {
    return await fn();
  } finally {
    await admin.query(def);
    expect(
      (
        await admin.query(
          "select pg_get_functiondef('public.app_wa_option_apply(uuid, jsonb)'::regprocedure) d",
        )
      ).rows[0].d,
    ).toBe(def);
  }
}

// ---------------------------------------------------------------------------------------------

/** Üretimdeki giriş noktasıyla aynı: tek bağlantı + gerçek mesaj işleyicisi. */
async function runTask() {
  const s = createStandaloneDb(db.appUrl, {
    max: 1,
    idleTimeoutMillis: 0,
    statement_timeout: 30_000,
    application_name: "kiraligim-option-faz-b-test",
  });
  try {
    return await runOptionMaintenance(s.db, {
      log,
      handleMessage: createOptionMessageHandler({ log }),
    });
  } finally {
    await s.end();
  }
}

type Grp = { id: string; jid: string; villa: string };
let villaN = 0;
/** Yeni villa + ona bağlı yeni grup (tarihsiz hedef testleri birbirini etkilemesin). */
async function fresh(workspace = ws, owner = O): Promise<Grp> {
  const v = await villa(`Villa FB ${++villaN}`, owner, workspace);
  const g = await group(workspace, v);
  return { ...g, villa: v };
}
/** Grup mesajı + imleç + öğeler. */
async function applyIn(g: { jid: string }, items: object[], pn = PN) {
  const m = await send(`opsiyon faz b ${++msgN}`, g.jid, pn);
  await claim();
  const rows = await apply(m.id, items);
  return { m, rows };
}
async function createIn(g: { jid: string }, a: string, b: string) {
  const { m, rows } = await applyIn(g, [item({ intent: "create", check_in: a, check_out: b })]);
  expect(rows[0]).toMatchObject({ status: "applied" });
  return { m, id: rows[0].option_id as string };
}
const events = async (option: string) =>
  (
    await admin.query(
      "select event, from_status, to_status, reason, message_id, version, expires_at from reservation_option_events where option_id = $1 order by version",
      [option],
    )
  ).rows;
const opsOf = async (message: string) =>
  (await admin.query("select * from option_operations where message_id = $1", [message])).rows;
const ms = (d: Date | string) => new Date(d).getTime();
/** İşletme denetim kaydı (audit_log) — opsiyon eylemleri. */
const audits = async (option: string) =>
  (
    await admin.query(
      "select workspace_id, actor_user_id, action, target_type, target_id, metadata from audit_log where target_id = $1 and action like 'option.%' order by occurred_at",
      [option],
    )
  ).rows;
const links = (option: string, who = adminId) =>
  asAdmin<{ relation: string; id: string; status: string; end_reason: string | null }>(
    "select relation, id, status, end_reason from public.app_option_admin_option_links($1, $2)",
    [who, option],
  );
const MIN = 60_000;

// ---------------------------------------------------------------------------------------------
describe("uzatma (app_wa_option_apply)", () => {
  it("tarihli hedef: yeni bitiş = mevcut bitiş + süre; sürüm +1; denetim ve olay kaydı", async () => {
    const g = await fresh();
    const c = await createIn(g, day(40), day(42));
    const before = await opt(c.id);
    const { m, rows } = await applyIn(g, [
      item({ intent: "extend", check_in: day(40), check_out: day(42), expires_in_minutes: 120 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "applied", option_id: c.id });
    const after = await opt(c.id);
    expect(ms(after.expires_at) - ms(before.expires_at)).toBe(120 * MIN);
    expect(after).toMatchObject({
      status: "open",
      version: before.version + 1,
      expiry_source: before.expiry_source,
      check_in: before.check_in,
      check_out: before.check_out,
    });
    const o = await op(rows[0].operation_id);
    expect(o).toMatchObject({
      kind: "extend",
      mode: "auto",
      status: "applied",
      expires_in_minutes: 120,
      target_option_id: c.id,
      target_option_version: before.version,
      result_option_id: c.id,
      reasons: [],
    });
    expect(o.before_state).toMatchObject({ option: c.id, version: before.version });
    expect(ms(o.before_state.expires_at)).toBe(ms(before.expires_at));
    expect(o.after_state).toMatchObject({ option: c.id, status: "open", added_minutes: 120 });
    expect(ms(o.after_state.expires_at)).toBe(ms(after.expires_at));
    const ev = await events(c.id);
    expect(ev.map((e) => e.event)).toEqual(["created", "updated"]);
    expect(ev[0]).toMatchObject({ message_id: c.m.id });
    expect(ms(ev[0].expires_at)).toBe(ms(before.expires_at));
    expect(ev[1]).toMatchObject({ message_id: m.id, from_status: "open", to_status: "open" });
    expect(ms(ev[1].expires_at)).toBe(ms(after.expires_at));
    // İşletme denetim kaydı: yalnız kimlik, süre ve bitişler; mesaj metni / telefon / misafir yok.
    const au = await audits(c.id);
    expect(au).toHaveLength(1);
    expect(au[0]).toMatchObject({
      workspace_id: ws,
      actor_user_id: null,
      action: "option.extended",
      target_type: "reservation_option",
      target_id: c.id,
    });
    expect(Object.keys(au[0].metadata).sort()).toEqual(
      ["added_minutes", "expires_after", "expires_before", "operation", "source"].sort(),
    );
    expect(au[0].metadata).toMatchObject({
      operation: o.id,
      source: "whatsapp",
      added_minutes: 120,
    });
    expect(ms(au[0].metadata.expires_before)).toBe(ms(before.expires_at));
    expect(ms(au[0].metadata.expires_after)).toBe(ms(after.expires_at));
    expect(JSON.stringify(au[0].metadata)).not.toMatch(/opsiyon|faz b|9053/);
    // Ayar transaction sonunda temizlenir (sonraki güncellemeye sızmaz).
    expect(
      (await admin.query("select current_setting('app.option_message', true) s")).rows[0].s ?? "",
    ).toBe("");
  });

  it("tarihsiz hedef yalnız grubun TEK açık opsiyonu; iki açık opsiyonda hiçbiri değişmez", async () => {
    const g = await fresh();
    const a = await createIn(g, day(44), day(46));
    const ext = await applyIn(g, [item({ intent: "extend", expires_in_minutes: 1440 })]);
    expect(ext.rows[0]).toMatchObject({ status: "applied", option_id: a.id });
    const exp1 = (await opt(a.id)).expires_at;

    const b = await createIn(g, day(48), day(50));
    const exp2 = (await opt(b.id)).expires_at;
    const amb = await applyIn(g, [item({ intent: "extend", expires_in_minutes: 60 })]);
    expect(amb.rows[0]).toMatchObject({ status: "pending", option_id: null });
    expect(await op(amb.rows[0].operation_id)).toMatchObject({
      kind: "extend",
      mode: "clarify",
      reasons: ["multiple_open_options"],
      target_option_id: null,
    });
    expect(ms((await opt(a.id)).expires_at)).toBe(ms(exp1));
    expect(ms((await opt(b.id)).expires_at)).toBe(ms(exp2));
  });

  it("süre yok / hedef yok / süre dolmuş → açıklama bekler, hiçbir şey değişmez", async () => {
    const g = await fresh();
    const a = await createIn(g, day(52), day(54));
    const exp = (await opt(a.id)).expires_at;

    const none = await applyIn(g, [
      item({ intent: "extend", decision: "ask", reasons: ["duration_missing"] }),
    ]);
    expect(await op(none.rows[0].operation_id)).toMatchObject({
      mode: "clarify",
      status: "pending",
      reasons: ["duration_missing"],
      target_option_id: a.id,
    });

    const missing = await applyIn(g, [
      item({ intent: "extend", check_in: day(53), check_out: day(55), expires_in_minutes: 60 }),
    ]);
    expect(await op(missing.rows[0].operation_id)).toMatchObject({
      mode: "clarify",
      reasons: ["no_open_option"],
    });

    // Bitişten 1 saat sonrası: süre dolmuş (görev henüz kapatmamış) → uzatılmaz.
    const m = await send(`opsiyon faz b ${++msgN}`, g.jid);
    await claim();
    const late = await withClock(
      new Date(ms(exp) + 60 * MIN),
      async () => (await apply(m.id, [item({ intent: "extend", expires_in_minutes: 1440 })]))[0],
    );
    expect(await op(late.operation_id)).toMatchObject({
      mode: "clarify",
      reasons: ["option_expired"],
    });
    expect(await opt(a.id)).toMatchObject({ status: "open", version: 1 });
    expect(ms((await opt(a.id)).expires_at)).toBe(ms(exp));
    // Açıklama bekleyen uzatma denetim kaydı yazmaz.
    expect(await audits(a.id)).toEqual([]);
  });

  it("girişi aşan uzatma kısaltılmaz → açıklama bekler", async () => {
    const g = await fresh();
    const a = await createIn(g, day(2), day(4));
    const exp = (await opt(a.id)).expires_at;
    const r = await applyIn(g, [item({ intent: "extend", expires_in_minutes: 1440 })]);
    expect(await op(r.rows[0].operation_id)).toMatchObject({
      mode: "clarify",
      reasons: ["extend_after_check_in"],
      expires_in_minutes: 1440,
    });
    expect(ms((await opt(a.id)).expires_at)).toBe(ms(exp));
  });

  it("14 gün sınırı opsiyonun ilk oluşturulmasından ölçülür; art arda uzatma aşamaz", async () => {
    const g = await fresh();
    const a = await createIn(g, day(80), day(82));
    // 24 saat + 13 gün = 14 gün (oluşturma anından az): uygulanır.
    const ok = await applyIn(g, [item({ intent: "extend", expires_in_minutes: 13 * 1440 })]);
    expect(ok.rows[0]).toMatchObject({ status: "applied" });
    const exp = (await opt(a.id)).expires_at;
    expect(ms(exp)).toBeLessThanOrEqual(ms((await opt(a.id)).created_at) + 14 * 1440 * MIN);
    // Bir saat daha: ilk oluşturmadan itibaren 14 günü aşar.
    const over = await applyIn(g, [item({ intent: "extend", expires_in_minutes: 60 })]);
    expect(await op(over.rows[0].operation_id)).toMatchObject({
      mode: "clarify",
      reasons: ["extend_over_max"],
    });
    expect(ms((await opt(a.id)).expires_at)).toBe(ms(exp));
  });

  it("geçersiz öğe reddedilir: 1 saatten kısa süre, uzatmada eski aralık", async () => {
    const g = await fresh();
    for (const bad of [
      item({ intent: "extend", expires_in_minutes: 30 }),
      item({
        intent: "extend",
        expires_in_minutes: 60,
        old_check_in: day(1),
        old_check_out: day(2),
      }),
      item({ intent: "reschedule", check_in: day(5), check_out: day(6), old_check_in: day(2) }),
    ]) {
      const m = await send(`opsiyon faz b ${++msgN}`, g.jid);
      await claim();
      await expect(apply(m.id, [bad])).rejects.toThrow(/option_items_invalid/);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe("tarih değişikliği (app_wa_option_apply)", () => {
  it("eski kapanır (date_changed), yenisi bağlı açılır; bitiş KORUNUR; denetim ve olaylar", async () => {
    const g = await fresh();
    const a = await createIn(g, day(60), day(62));
    const old = await opt(a.id);
    const { m, rows } = await applyIn(g, [
      item({
        intent: "reschedule",
        check_in: day(61),
        check_out: day(64),
        old_check_in: day(60),
        old_check_out: day(62),
      }),
    ]);
    expect(rows[0]).toMatchObject({ status: "applied" });
    const nid = rows[0].option_id as string;
    expect(nid).not.toBe(a.id);
    expect(await opt(a.id)).toMatchObject({
      status: "cancelled",
      end_reason: "date_changed",
      ended_by_message_id: m.id,
      version: old.version + 1,
    });
    const n = await opt(nid);
    expect(n).toMatchObject({
      status: "open",
      replaces_option_id: a.id,
      origin_message_id: m.id,
      group_id: g.id,
      property_id: g.villa,
      expiry_source: old.expiry_source,
      version: 1,
    });
    expect(ms(n.expires_at)).toBe(ms(old.expires_at));
    const o = await op(rows[0].operation_id);
    expect(o).toMatchObject({
      kind: "reschedule",
      mode: "auto",
      status: "applied",
      end_reason: "date_changed",
      target_option_id: a.id,
      result_option_id: nid,
      expires_in_minutes: null,
    });
    expect(o.after_state).toMatchObject({ option: nid, replaces: a.id, status: "open" });
    expect(o.before_state).toMatchObject({ option: a.id });
    expect((await events(a.id)).map((e) => [e.event, e.reason])).toEqual([
      ["created", null],
      ["cancelled", "date_changed"],
    ]);
    expect((await events(nid)).map((e) => [e.event, e.message_id])).toEqual([["created", m.id]]);
    // İşletme denetim kaydı yeni opsiyona bağlı; eski aralık ve bitiş; kişisel veri yok.
    expect(await audits(a.id)).toEqual([]);
    const au = await audits(nid);
    expect(au).toHaveLength(1);
    expect(au[0]).toMatchObject({
      workspace_id: ws,
      actor_user_id: null,
      action: "option.rescheduled",
      target_type: "reservation_option",
      target_id: nid,
      metadata: {
        operation: o.id,
        source: "whatsapp",
        previous_option: a.id,
        previous_check_in: day(60),
        previous_check_out: day(62),
        check_in: day(61),
        check_out: day(64),
      },
    });
    expect(Object.keys(au[0].metadata).sort()).toEqual(
      [
        "check_in",
        "check_out",
        "expires_at",
        "operation",
        "previous_check_in",
        "previous_check_out",
        "previous_option",
        "source",
      ].sort(),
    );
    expect(ms(au[0].metadata.expires_at)).toBe(ms(old.expires_at));
    // Super Admin: eskiden yeniye, yeniden eskiye bağlantı.
    expect(await links(a.id)).toEqual([
      { relation: "next", id: nid, status: "open", end_reason: null },
    ]);
    expect(await links(nid)).toEqual([
      { relation: "previous", id: a.id, status: "cancelled", end_reason: "date_changed" },
    ]);
    // Bağlantı ve olay bitişi sonradan değiştirilemez.
    await expect(
      admin.query("update reservation_options set replaces_option_id = null where id = $1", [nid]),
    ).rejects.toThrow(/option_immutable_field/);
    await expect(
      admin.query("update reservation_option_events set expires_at = now() where option_id = $1", [
        nid,
      ]),
    ).rejects.toThrow(/option_history_immutable/);
  });

  it("tarihsiz eski aralık: grubun tek açık opsiyonu taşınır", async () => {
    const g = await fresh();
    const a = await createIn(g, day(66), day(68));
    const r = await applyIn(g, [
      item({ intent: "reschedule", check_in: day(66), check_out: day(69) }),
    ]);
    expect(r.rows[0]).toMatchObject({ status: "applied" });
    expect(await opt(a.id)).toMatchObject({ status: "cancelled", end_reason: "date_changed" });
    const b = r.rows[0].option_id as string;
    expect(await opt(b)).toMatchObject({ replaces_option_id: a.id });
    // İkinci değişiklik: ortadaki opsiyonun hem önceki hem sonraki bağlantısı görünür.
    const r2 = await applyIn(g, [
      item({ intent: "reschedule", check_in: day(67), check_out: day(69) }),
    ]);
    expect(r2.rows[0]).toMatchObject({ status: "applied" });
    const c = r2.rows[0].option_id as string;
    expect((await links(b)).sort((x, y) => x.relation.localeCompare(y.relation))).toEqual([
      { relation: "next", id: c, status: "open", end_reason: null },
      { relation: "previous", id: a.id, status: "cancelled", end_reason: "date_changed" },
    ]);
    // Super Admin sunucu katmanı (opsiyon detay sayfasının kullandığı fonksiyon).
    const adminDb = drizzle(adminRolePool, { schema, casing: DB_CASING });
    expect(
      (await listOptionLinks(adminDb, adminId, b)).map((l) => [l.relation, l.id, l.checkIn]),
    ).toEqual(
      expect.arrayContaining([
        ["previous", a.id, day(66)],
        ["next", c, day(67)],
      ]),
    );
    // Bağlantısız opsiyon: boş.
    expect(await links((await createIn(await fresh(), day(130), day(131))).id)).toEqual([]);
  });

  it("bağlantı fonksiyonu YALNIZ etkin Super Admin (app_admin); işletme ve görev rolleri çalıştıramaz", async () => {
    const g = await fresh();
    const a = await createIn(g, day(132), day(134));
    await expect(
      appPool.query("select * from public.app_option_admin_option_links($1, $2)", [adminId, a.id]),
    ).rejects.toThrow(/permission denied/);
    await expect(links(a.id, uuidv7())).rejects.toThrow(/option_admin_forbidden/);
    const priv = (
      await admin.query(
        "select has_function_privilege('app_user', 'public.app_option_admin_option_links(uuid, uuid)', 'EXECUTE') u, has_function_privilege('app_admin', 'public.app_option_admin_option_links(uuid, uuid)', 'EXECUTE') a",
      )
    ).rows[0];
    expect(priv).toEqual({ u: false, a: true });
  });

  it("aynı aralık / yeni aralık yok / başka açık opsiyonla çakışma / bitiş yeni girişi aşar → açıklama", async () => {
    const g = await fresh();
    const a = await createIn(g, day(70), day(72));
    await createIn(g, day(75), day(77));
    const cases: [object, string[]][] = [
      [
        { check_in: day(70), check_out: day(72), old_check_in: day(70), old_check_out: day(72) },
        ["same_range"],
      ],
      [
        {
          decision: "ask",
          reasons: ["new_range_missing"],
          old_check_in: day(70),
          old_check_out: day(72),
        },
        ["new_range_missing"],
      ],
      [
        { check_in: day(74), check_out: day(76), old_check_in: day(70), old_check_out: day(72) },
        ["option_overlap"],
      ],
      [
        { check_in: day(1), check_out: day(3), old_check_in: day(70), old_check_out: day(72) },
        ["duration_after_check_in"],
      ],
      // Tarihsiz eski aralık ama grupta iki açık opsiyon var.
      [{ check_in: day(90), check_out: day(92) }, ["multiple_open_options"]],
    ];
    for (const [o, reasons] of cases) {
      const r = await applyIn(g, [item({ intent: "reschedule", ...o })]);
      expect(r.rows[0]).toMatchObject({ status: "pending", option_id: null });
      expect(await op(r.rows[0].operation_id)).toMatchObject({
        kind: "reschedule",
        mode: "clarify",
        reasons,
      });
    }
    expect(await opt(a.id)).toMatchObject({ status: "open", version: 1 });
  });
});

// ---------------------------------------------------------------------------------------------
describe("yalıtım, gönderen ve tekrar", () => {
  it("başka villa / grup / işletmenin opsiyonu hedef olmaz", async () => {
    const g1 = await fresh();
    const g2 = await fresh();
    const gx = await fresh(wsX, X);
    const o2 = await createIn(g2, day(100), day(102));
    const ox = await createIn(gx, day(100), day(102));
    const e2 = (await opt(o2.id)).expires_at;
    const ex = (await opt(ox.id)).expires_at;
    for (const it of [
      item({ intent: "extend", check_in: day(100), check_out: day(102), expires_in_minutes: 60 }),
      item({ intent: "extend", expires_in_minutes: 60 }),
      item({
        intent: "reschedule",
        check_in: day(101),
        check_out: day(103),
        old_check_in: day(100),
        old_check_out: day(102),
      }),
    ]) {
      const r = await applyIn(g1, [it]);
      expect(await op(r.rows[0].operation_id)).toMatchObject({
        mode: "clarify",
        target_option_id: null,
      });
      expect((await op(r.rows[0].operation_id)).reasons).toContain("no_open_option");
    }
    expect(await opt(o2.id)).toMatchObject({ status: "open", version: 1 });
    expect(await opt(ox.id)).toMatchObject({ status: "open", version: 1 });
    expect(ms((await opt(o2.id)).expires_at)).toBe(ms(e2));
    expect(ms((await opt(ox.id)).expires_at)).toBe(ms(ex));
  });

  it("doğrulanmamış ya da engelli gönderen: hiçbir işlem yok", async () => {
    const g = await fresh();
    const a = await createIn(g, day(104), day(106));
    const other = `9053299${String(parseInt(tag, 16) % 100_000).padStart(5, "0")}`;
    const u = await applyIn(g, [item({ intent: "extend", expires_in_minutes: 60 })], other);
    expect(u.rows).toEqual([]);
    expect(await opsOf(u.m.id)).toEqual([]);

    await admin.query(
      "insert into wa_blocked_senders (id, phone_hash, phone_hint, group_id) values ($1, $2, '02', $3)",
      [uuidv7(), phoneHash(PN), g.id],
    );
    try {
      const b = await applyIn(g, [
        item({ intent: "reschedule", check_in: day(105), check_out: day(107) }),
      ]);
      expect(b.rows).toEqual([]);
      expect(await opsOf(b.m.id)).toEqual([]);
    } finally {
      await admin.query("delete from wa_blocked_senders where group_id = $1", [g.id]);
    }
    expect(await opt(a.id)).toMatchObject({ status: "open", version: 1 });
  });

  it("aynı mesaj ikinci kez işlenmez", async () => {
    const g = await fresh();
    const a = await createIn(g, day(108), day(110));
    const { m, rows } = await applyIn(g, [item({ intent: "extend", expires_in_minutes: 60 })]);
    expect(rows[0]).toMatchObject({ status: "applied" });
    const exp = (await opt(a.id)).expires_at;
    expect(await apply(m.id, [item({ intent: "extend", expires_in_minutes: 60 })])).toEqual([]);
    expect(ms((await opt(a.id)).expires_at)).toBe(ms(exp));
    expect(await opsOf(m.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
const MONTHS = [
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
/** day(n) ve day(n + len) aynı ayda, gün 5–25 arası olan ilk n (metin "D1-D2 Ay"). */
function sameMonthRange(from: number, len: number) {
  for (let n = from; n < from + 60; n++) {
    const a = day(n);
    const b = day(n + len);
    if (a.slice(0, 7) === b.slice(0, 7) && +a.slice(8) >= 5 && +b.slice(8) <= 25) {
      return { n, a, b, text: `${+a.slice(8)}-${+b.slice(8)} ${MONTHS[+a.slice(5, 7) - 1]}` };
    }
  }
  throw new Error("aralık bulunamadı");
}

describe("uçtan uca: WhatsApp mesajı → worker → option-maintenance", () => {
  it("oluştur (24 saat) → 'Ödeme bekliyorum, 2 saat daha bekleyelim' → '…opsiyonunu … yap'", async () => {
    const g = await fresh();
    const r1 = sameMonthRange(120, 3);
    await send(`${r1.text} opsiyon`, g.jid);
    await runTask();
    const created = (
      await admin.query(
        "select * from reservation_options where group_id = $1 and status = 'open'",
        [g.id],
      )
    ).rows;
    expect(created).toHaveLength(1);
    const c = created[0];
    expect(c).toMatchObject({ expiry_source: "system_default" });

    const m2 = await send("Ödeme bekliyorum, 2 saat daha bekleyelim", g.jid);
    await runTask();
    expect(ms((await opt(c.id)).expires_at) - ms(c.expires_at)).toBe(120 * MIN);
    expect(await opsOf(m2.id)).toMatchObject([{ kind: "extend", mode: "auto", status: "applied" }]);

    const r2 = {
      ...r1,
      text: `${+r1.a.slice(8) + 1}-${+r1.b.slice(8) + 1} ${r1.text.split(" ")[1]}`,
    };
    const m3 = await send(`${r1.text} opsiyonunu ${r2.text} yap`, g.jid);
    await runTask();
    const ops = await opsOf(m3.id);
    expect(ops).toMatchObject([{ kind: "reschedule", mode: "auto", status: "applied" }]);
    const n = await opt(ops[0].result_option_id);
    expect(n).toMatchObject({ status: "open", replaces_option_id: c.id });
    expect(ms(n.expires_at)).toBe(ms(c.expires_at) + 120 * MIN);
    expect(await opt(c.id)).toMatchObject({ status: "cancelled", end_reason: "date_changed" });

    // Bağlamsız "2 saat daha bekleyelim" ve soru: hiçbir şey.
    const exp = n.expires_at;
    const m4 = await send("2 saat daha bekleyelim", g.jid);
    const m5 = await send("Opsiyonu 2 saat uzatalım mı?", g.jid);
    await runTask();
    expect(await opsOf(m4.id)).toEqual([]);
    expect(await opsOf(m5.id)).toEqual([]);
    expect(ms((await opt(n.id)).expires_at)).toBe(ms(exp));
  });

  it("doğrulanmamış gönderenin uzatma mesajı (worker öğesi yok) işlem üretmez", async () => {
    const g = await fresh();
    const r1 = sameMonthRange(150, 2);
    await send(`${r1.text} opsiyon`, g.jid);
    await runTask();
    const c = (await admin.query("select * from reservation_options where group_id = $1", [g.id]))
      .rows[0];
    const other = `9053277${String(parseInt(tag, 16) % 100_000).padStart(5, "0")}`;
    const m = await send("Opsiyonu 2 saat uzatın", g.jid, other);
    await runTask();
    expect(await opsOf(m.id)).toEqual([]);
    expect(await opt(c.id)).toMatchObject({ version: 1 });
  });
});
