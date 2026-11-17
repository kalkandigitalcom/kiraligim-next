import { createHash, randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { DB_CASING } from "@/db/casing";
import { pgErrorInfo } from "@/db/pg-error";
import * as schema from "@/db/schema";
import { type TenantContext, type Tx, withTenant } from "@/db/tenant";
import { createLogger } from "@/lib/logger";
import { addDays, istanbulToday } from "@/lib/reservation-meta";
import {
  getOwnerOptionSettings,
  listOwnerClarifications,
  setOwnerDefaultDuration,
} from "@/server/options/owner";
import { createProperty } from "@/server/properties/service";
import { createAutoChanger } from "@/server/whatsapp/auto-change";
import { createAutoCloser } from "@/server/whatsapp/auto-close";
import { createAutoOpener } from "@/server/whatsapp/auto-open";
import { runCalendarWorker, type WorkerDeps } from "@/server/whatsapp/calendar/worker";
import { addWorkspaceMember, createWorkspace } from "@/server/workspaces/service";

import { createTestAdmin } from "./wa-admin";

/**
 * Opsiyon Faz A — varsayılan süre (drizzle/0075). Gerçek PostgreSQL: görev fonksiyonu app_user ile,
 * Super Admin fonksiyonları gerçek app_admin rolüyle, işletme paneli servisleri withTenant ile.
 *
 * Kanıtlananlar: süre önceliği mesaj → işletme → sistem (24 saat); mesajda yazılı süre girişi
 * aşarsa opsiyon YOK ve kısaltma YOK (açıklama bekler); varsayılan girişi aşarsa bitiş giriş anına
 * çekilir, girişe 60 dakikadan az kaldıysa açıklama bekler; başlamış / geçmiş giriş otomatik
 * işlenmez; "açıklama bekliyor" işlemleri hiçbir görev almaz ve Super Admin onaylayamaz; iptal /
 * kesinleştirme belirsizlikleri eskisi gibi Super Admin onayına düşer; sistem varsayılanını yalnız
 * Super Admin değiştirir ve otomasyon başlangıç zamanı (anahtar) değişmez; işletme varsayılanını
 * YALNIZ işletme sahibi değiştirir (yönetici / personel / başka işletme değiştiremez); her
 * değişiklik denetim kaydına yazılır; değişiklik mevcut opsiyonların bitişini etkilemez.
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 6 });
const app = drizzle(appPool, { schema, casing: DB_CASING });
const adminRolePool = new Pool({ connectionString: db.adminUrl, max: 3 });
adminRolePool.on("connect", (c) => void c.query("set role app_admin"));
const admin = new Client({ connectionString: db.adminUrl });
const tag = randomBytes(3).toString("hex");
const log = createLogger({ service: "option-default-duration-test" }, () => {});
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
/** Girişin başlangıcı: Europe/Istanbul 00:00 (UTC+3, yaz saati yok). */
const checkInStart = (iso: string) => new Date(`${iso}T00:00:00+03:00`).getTime();

let O: U, M: U, S: U, X: U;
let ws: string, wsX: string;
let mavi: string;
let conn: string;
let G: { id: string; jid: string };
let adminId: string;
const planCode = `opt_fa_${tag}`;

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
const setSystemDefault = (minutes: number | null, who = adminId) =>
  adminOne("select public.app_option_admin_set_default_duration($1, $2) as out", [who, minutes]);
const setWorkspaceAdmin = (w: string, def: number | null, choices: number[] = []) =>
  adminOne("select public.app_option_admin_set_workspace($1, $2, false, $3, $4) as out", [
    adminId,
    w,
    def,
    choices,
  ]);

async function errCode(p: Promise<unknown>) {
  return p.then(
    () => "ok",
    (e: unknown) => {
      const i = pgErrorInfo(e);
      if (i.message && /^[a-z_]+$/.test(i.message)) return i.message;
      if (i.code) return i.code;
      return e instanceof Error ? e.constructor.name : "error";
    },
  );
}

let msgN = 0;
async function send(body: string, jid = G.jid) {
  const mid = `FA${tag}${++msgN}`;
  await appPool.query(
    "select public.app_wa_ingest_message($1, $2, $3, '1@lid', $4, null, $5, now(), 'live')",
    [conn, jid, mid, PN, body],
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
/** Mesaj + imleç + tek öğe. */
async function create(o: object) {
  const m = await send(`opsiyon faz a ${++msgN}`);
  await claim();
  const r = await apply(m.id, [item({ intent: "create", ...o })]);
  return { m, r: r[0], op: r[0].operation_id ? await op(r[0].operation_id) : undefined };
}

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
  O = await mkUser("fao");
  M = await mkUser("fam");
  S = await mkUser("fas");
  X = await mkUser("fax");
  ws = (await createWorkspace(app, { userId: O.id, name: "Faz A", slug: `fa-${tag}` })).id;
  wsX = (await createWorkspace(app, { userId: X.id, name: "Faz A Başka", slug: `fax-${tag}` })).id;
  const planId = uuidv7();
  await admin.query(
    "insert into plans (id, code, name, max_properties, trial_days, is_active, is_default) values ($1, $2, 'FA', 20, 14, true, false)",
    [planId, planCode],
  );
  await admin.query(
    "update workspace_subscriptions set plan_id = $1 where workspace_id in ($2, $3)",
    [planId, ws, wsX],
  );
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: M.id, role: "manager" }));
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: S.id, role: "staff" }));
  mavi = await villa("Villa Mavi", O, ws);
  await villa("Villa Başka", X, wsX);
  conn = (
    await appPool.query<{ id: string }>("select public.app_wa_heartbeat($1, 'open', null) as id", [
      `fa-${tag}`,
    ])
  ).rows[0]!.id;
  await admin.query(
    "insert into wa_verified_phones (user_id, phone_hash, phone_masked) values ($1, $2, '+90 532 *** ** 02')",
    [O.id, phoneHash(PN)],
  );
  G = await group(ws, mavi);
  adminId = await createTestAdmin(admin, "faza");
  await runCalendarWorker(app, deps);
  await setGlobal(true);
});

afterAll(async () => {
  // Diğer test dosyaları için: kill switch kapalı, sistem varsayılanı 24 saat.
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
describe("sistem varsayılanı (Super Admin)", () => {
  it("varsayılan 24 saat; yalnız app_admin değiştirir; sınırlar; anahtar zamanı değişmez; denetim kaydı", async () => {
    const g0 = (
      await admin.query(
        "select default_duration_minutes m, updated_at, updated_by_admin from option_automation_global where id = 1",
      )
    ).rows[0];
    expect(g0.m).toBe(1440);
    const since0 = (await admin.query("select public.app_option_automation_since($1) s", [G.id]))
      .rows[0].s;
    expect(
      (await asAdmin("select * from public.app_option_admin_default_duration($1)", [adminId]))[0],
    ).toMatchObject({ minutes: 1440 });

    for (const bad of [59, 20161, null]) {
      expect(await errCode(setSystemDefault(bad))).toBe("option_settings_invalid");
    }
    expect(await errCode(setSystemDefault(600, uuidv7()))).toBe("option_admin_forbidden");
    expect(
      await errCode(
        appPool.query("select public.app_option_admin_set_default_duration($1, 600)", [adminId]),
      ),
    ).toBe("42501");

    expect(await setSystemDefault(2880)).toBe("changed");
    expect(await setSystemDefault(2880)).toBe("unchanged");
    const g1 = (
      await admin.query(
        "select default_duration_minutes m, default_duration_updated_at du, updated_at, updated_by_admin from option_automation_global where id = 1",
      )
    ).rows[0];
    expect(g1.m).toBe(2880);
    expect(g1.du).not.toBeNull();
    // Otomasyon anahtarının zamanı / yöneticisi değişmez (mesaj penceresi kaymaz).
    expect(g1.updated_at.getTime()).toBe(g0.updated_at.getTime());
    expect(g1.updated_by_admin).toBe(g0.updated_by_admin);
    expect(
      new Date(
        (await admin.query("select public.app_option_automation_since($1) s", [G.id])).rows[0].s,
      ).getTime(),
    ).toBe(new Date(since0).getTime());
    const audit = (
      await admin.query(
        "select metadata from admin_audit_log where admin_id = $1 and action = 'option.default_duration_system' order by occurred_at",
        [adminId],
      )
    ).rows;
    expect(audit.map((a) => a.metadata)).toEqual([{ from: 1440, to: 2880 }]);
    expect(await setSystemDefault(1440)).toBe("changed");
  });
});

// ---------------------------------------------------------------------------------------------
describe("süre önceliği ve giriş kuralları (app_wa_option_apply)", () => {
  it("işletme varsayılanı yok → sistem varsayılanı (system_default); onay yok", async () => {
    const { m, r, op: o } = await create({ check_in: day(40), check_out: day(42) });
    expect(r.status).toBe("applied");
    expect(o).toMatchObject({
      mode: "auto",
      expiry_source: "system_default",
      expires_in_minutes: 1440,
    });
    const x = await opt(r.option_id);
    expect(x.expiry_source).toBe("system_default");
    expect(new Date(x.expires_at).getTime() - m.sent_at.getTime()).toBe(1440 * 60_000);
  });

  it("işletme varsayılanı sistem varsayılanından önce; mesajdaki süre ikisinden de önce", async () => {
    expect(await setWorkspaceAdmin(ws, 2880)).toBe("changed");
    const a = await create({ check_in: day(44), check_out: day(46) });
    expect(a.op).toMatchObject({ expiry_source: "workspace_default", expires_in_minutes: 2880 });
    const b = await create({ check_in: day(48), check_out: day(50), expires_in_minutes: 600 });
    expect(b.op).toMatchObject({ mode: "auto", expiry_source: "message", expires_in_minutes: 600 });
    expect(new Date((await opt(b.r.option_id)).expires_at).getTime() - b.m.sent_at.getTime()).toBe(
      600 * 60_000,
    );
    expect(await setWorkspaceAdmin(ws, null)).toBe("changed");
  });

  it("mesajda yazılı süre girişi aşarsa opsiyon YOK, kısaltma YOK → açıklama bekler", async () => {
    // Giriş 2 gün sonra; 14 günlük yazılı süre girişi aşar.
    const { r, op: o } = await create({
      check_in: day(2),
      check_out: day(4),
      expires_in_minutes: 20160,
    });
    expect(r).toMatchObject({ status: "pending", option_id: null });
    expect(o).toMatchObject({
      mode: "clarify",
      status: "pending",
      expiry_source: "message",
      expires_in_minutes: 20160,
      reasons: ["duration_after_check_in"],
      result_option_id: null,
    });
  });

  it("varsayılan girişi aşarsa bitiş giriş anına çekilir (kaynak korunur, işlem kaydında işaretli)", async () => {
    // İşletme varsayılanı 14 gün, giriş 3 gün sonra: girişe ≥ 48 saat var, kısaltılır.
    expect(await setWorkspaceAdmin(ws, 20160)).toBe("changed");
    const { m, r, op: o } = await create({ check_in: day(3), check_out: day(5) });
    expect({ status: r.status, reasons: o.reasons }).toEqual({ status: "applied", reasons: [] });
    const x = await opt(r.option_id);
    expect(new Date(x.expires_at).getTime()).toBe(checkInStart(day(3)));
    expect(x.expiry_source).toBe("workspace_default");
    expect(o).toMatchObject({ mode: "auto", expiry_source: "workspace_default", reasons: [] });
    expect(o.expires_in_minutes).toBe(
      Math.floor((checkInStart(day(3)) - m.sent_at.getTime()) / 60_000),
    );
    expect(o.after_state).toMatchObject({ status: "open", clamped_to_check_in: true });

    // Sistem varsayılanı da aynı kuralla kısaltılır.
    expect(await setWorkspaceAdmin(ws, null)).toBe("changed");
    expect(await setSystemDefault(20160)).toBe("changed");
    const s = await create({ check_in: day(7), check_out: day(8) });
    expect(s.r.status).toBe("applied");
    expect(new Date((await opt(s.r.option_id)).expires_at).getTime()).toBe(checkInStart(day(7)));
    expect(s.op).toMatchObject({ expiry_source: "system_default" });
    expect(await setSystemDefault(1440)).toBe("changed");
  });

  it("girişe 60 dakikadan az kalıyorsa (varsayılan) açıklama bekler", async () => {
    // Saat sabitlenir: fonksiyonun bu test için kopyasında now() = girişten 30 dk önce.
    const def = (
      await admin.query(
        "select pg_get_functiondef('public.app_wa_option_apply(uuid, jsonb)'::regprocedure) d",
      )
    ).rows[0].d as string;
    const fixed = new Date(checkInStart(day(1)) - 30 * 60_000).toISOString();
    const patched = def.replaceAll("pg_catalog.now()", `'${fixed}'::timestamptz`);
    expect(patched).not.toBe(def);
    // 14 günlük varsayılan her iki girişi de aşar (kısaltma kuralı devreye girer).
    expect(await setSystemDefault(20160)).toBe("changed");
    await admin.query(patched);
    try {
      const { r, op: o } = await create({ check_in: day(1), check_out: day(3) });
      expect(r).toMatchObject({ status: "pending", option_id: null });
      expect(o).toMatchObject({ mode: "clarify", reasons: ["check_in_too_close"] });
      // 90 dakika kala ise kısaltılarak açılır.
      const fixed90 = new Date(checkInStart(day(9)) - 90 * 60_000).toISOString();
      await admin.query(def.replaceAll("pg_catalog.now()", `'${fixed90}'::timestamptz`));
      const ok = await create({ check_in: day(9), check_out: day(10) });
      expect(ok.r.status).toBe("applied");
      expect(new Date((await opt(ok.r.option_id)).expires_at).getTime()).toBe(checkInStart(day(9)));
    } finally {
      await admin.query(def);
      await setSystemDefault(1440);
    }
    expect(
      (
        await admin.query(
          "select pg_get_functiondef('public.app_wa_option_apply(uuid, jsonb)'::regprocedure) d",
        )
      ).rows[0].d,
    ).toBe(def);
  });

  it("başlamış / geçmiş giriş otomatik işlenmez → açıklama bekler (date_past)", async () => {
    for (const [a, b] of [
      [day(0), day(2)],
      [day(-3), day(-1)],
    ]) {
      const { r, op: o } = await create({ check_in: a, check_out: b });
      expect(r).toMatchObject({ status: "pending", option_id: null });
      expect(o).toMatchObject({ mode: "clarify" });
      expect(o.reasons).toContain("date_past");
    }
    // Yazılı süreyle de aynı.
    const { op: o2 } = await create({
      check_in: day(0),
      check_out: day(2),
      expires_in_minutes: 60,
    });
    expect(o2.reasons).toContain("date_past");
  });

  it("açıklama bekleyen işlemi hiçbir görev almaz, Super Admin onaylayamaz; iptal / kesinleştirme belirsizliği eskisi gibi onaya", async () => {
    const { op: o } = await create({
      check_in: day(60),
      check_out: day(62),
      decision: "ask",
      reasons: ["villa_unclear"],
    });
    expect(o).toMatchObject({ mode: "clarify", status: "pending" });
    const claimed = (await appPool.query("select * from public.app_option_claim_operations(50)"))
      .rows;
    expect(claimed.map((c) => c.id)).not.toContain(o.id);
    for (const c of claimed) {
      await appPool.query("select public.app_option_finish_operation($1, $2, 'release', null)", [
        c.id,
        c.lock_token,
      ]);
    }
    expect(
      await adminOne(
        "select public.app_option_admin_decide($1, $2, 1, true, null, null, null, 600, null, null, null) as out",
        [adminId, o.id],
      ),
    ).toBe("not_pending");
    expect(await op(o.id)).toMatchObject({ mode: "clarify", status: "pending", version: 1 });
    // Varsayılan Super Admin listesi (onay bekleyenler) açıklama bekleyenleri içermez.
    const list = await asAdmin<{ id: string }>(
      "select id from public.app_option_admin_operations($1, null, 500)",
      [adminId],
    );
    expect(list.map((x) => x.id)).not.toContain(o.id);

    const m = await send("opsiyon iptal faz a");
    await claim();
    const r = await apply(m.id, [
      item({
        intent: "cancel",
        end_reason: "owner_cancelled",
        check_in: day(90),
        check_out: day(92),
      }),
    ]);
    expect(await op(r[0].operation_id)).toMatchObject({
      kind: "cancel",
      mode: "needs_approval",
      reasons: ["no_open_option"],
    });
  });

  it("varsayılan değişikliği mevcut opsiyonların bitişini değiştirmez", async () => {
    const before = (
      await admin.query(
        "select id, expires_at, expiry_source, version from reservation_options where workspace_id = $1 order by id",
        [ws],
      )
    ).rows;
    expect(before.length).toBeGreaterThan(0);
    expect(await setSystemDefault(600)).toBe("changed");
    expect(await setWorkspaceAdmin(ws, 4320)).toBe("changed");
    expect(await as(O, ws, (tx, ctx) => setOwnerDefaultDuration(tx, ctx, 2880))).toEqual({
      changed: true,
    });
    expect(
      (
        await admin.query(
          "select id, expires_at, expiry_source, version from reservation_options where workspace_id = $1 order by id",
          [ws],
        )
      ).rows,
    ).toEqual(before);
    expect(await setSystemDefault(1440)).toBe("changed");
    expect(await setWorkspaceAdmin(ws, null)).toBe("changed");
  });
});

// ---------------------------------------------------------------------------------------------
describe("işletme paneli: varsayılan süre ve açıklama bekleyenler", () => {
  it("yalnız işletme sahibi değiştirir; yönetici okur; personel erişemez; denetim kaydı", async () => {
    expect(await as(O, ws, (tx, ctx) => getOwnerOptionSettings(tx, ctx))).toMatchObject({
      workspaceMinutes: null,
      systemMinutes: 1440,
      effectiveMinutes: 1440,
      effectiveSource: "system_default",
      canEdit: true,
    });
    expect(await as(O, ws, (tx, ctx) => setOwnerDefaultDuration(tx, ctx, 2880))).toEqual({
      changed: true,
    });
    expect(await as(O, ws, (tx, ctx) => setOwnerDefaultDuration(tx, ctx, 2880))).toEqual({
      changed: false,
    });
    expect(await as(M, ws, (tx, ctx) => getOwnerOptionSettings(tx, ctx))).toMatchObject({
      workspaceMinutes: 2880,
      effectiveSource: "workspace_default",
      canEdit: false,
    });
    await expect(as(M, ws, (tx, ctx) => setOwnerDefaultDuration(tx, ctx, 600))).rejects.toThrow();
    await expect(as(S, ws, (tx, ctx) => setOwnerDefaultDuration(tx, ctx, 600))).rejects.toThrow();
    await expect(as(S, ws, (tx, ctx) => getOwnerOptionSettings(tx, ctx))).rejects.toThrow();
    // Veritabanı da rolü denetler (servis atlansa bile).
    for (const u of [M, S]) {
      expect(
        await errCode(
          as(u, ws, (tx) => tx.execute(sql`select public.app_option_owner_set_default(600)`)),
        ),
      ).toBe("option_owner_forbidden");
    }
    expect(await errCode(appPool.query("select public.app_option_owner_set_default(600)"))).toBe(
      "option_owner_forbidden",
    );
    for (const bad of [59, 20161]) {
      expect(
        await errCode(
          as(O, ws, (tx) =>
            tx.execute(sql`select public.app_option_owner_set_default(${bad}::integer)`),
          ),
        ),
      ).toBe("option_settings_invalid");
    }
    // Super Admin seçenek listesi tanımladıysa varsayılan listeden olmalı.
    expect(await setWorkspaceAdmin(ws, 2880, [1440, 2880])).toBe("changed");
    expect(
      await errCode(
        as(O, ws, (tx) => tx.execute(sql`select public.app_option_owner_set_default(600)`)),
      ),
    ).toBe("option_settings_invalid");
    expect(await as(O, ws, (tx, ctx) => setOwnerDefaultDuration(tx, ctx, 1440))).toEqual({
      changed: true,
    });
    expect(
      (
        await admin.query(
          "select duration_choices c, automation_enabled e from workspace_option_settings where workspace_id = $1",
          [ws],
        )
      ).rows[0],
    ).toEqual({ c: [1440, 2880], e: false });
    // Boş: sistem varsayılanına dön.
    expect(await as(O, ws, (tx, ctx) => setOwnerDefaultDuration(tx, ctx, null))).toEqual({
      changed: true,
    });
    const audit = (
      await admin.query(
        "select actor_user_id, metadata from audit_log where workspace_id = $1 and action = 'option.default_duration_changed' order by occurred_at",
        [ws],
      )
    ).rows;
    expect(audit.every((a) => a.actor_user_id === O.id)).toBe(true);
    expect(audit.at(-1)!.metadata).toEqual({ from: 1440, to: null });
    expect(await setWorkspaceAdmin(ws, null, [])).toBe("changed");
  });

  it("başka işletmenin sahibi bu işletmenin ayarına ve açıklama listesine dokunamaz", async () => {
    expect(await as(X, wsX, (tx, ctx) => setOwnerDefaultDuration(tx, ctx, 600))).toEqual({
      changed: true,
    });
    expect(
      (
        await admin.query(
          "select workspace_id, default_duration_minutes m from workspace_option_settings where workspace_id = any($1) order by workspace_id",
          [[ws, wsX]],
        )
      ).rows.find((r) => r.workspace_id === wsX)?.m,
    ).toBe(600);
    expect((await as(O, ws, (tx, ctx) => getOwnerOptionSettings(tx, ctx))).workspaceMinutes).toBe(
      null,
    );
    expect(await as(X, wsX, (tx, ctx) => listOwnerClarifications(tx, ctx))).toEqual([]);
  });

  it("açıklama bekleyenler: yalnız kendi işletmesi, en yeni önce; mesaj metni yok; personel göremez", async () => {
    const list = await as(O, ws, (tx, ctx) => listOwnerClarifications(tx, ctx));
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((c) => c.propertyName === "Villa Mavi")).toBe(true);
    const times = list.map((c) => c.createdAt.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(Object.keys(list[0]!).sort()).toEqual(
      ["checkIn", "checkOut", "createdAt", "id", "propertyName", "reasons", "sentAt"].sort(),
    );
    expect((await as(M, ws, (tx, ctx) => listOwnerClarifications(tx, ctx))).length).toBe(
      list.length,
    );
    await expect(as(S, ws, (tx, ctx) => listOwnerClarifications(tx, ctx))).rejects.toThrow();
    // Personel tabloyu doğrudan da okuyamaz (RLS).
    expect(
      (
        await as(S, ws, (tx) =>
          tx.execute(sql`select count(*)::int n from option_operations where mode = 'clarify'`),
        )
      ).rows[0],
    ).toEqual({ n: 0 });
  });
});
