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
import { createProperty } from "@/server/properties/service";
import { createReservation } from "@/server/reservations/service";
import { createAutoChanger } from "@/server/whatsapp/auto-change";
import { createAutoCloser } from "@/server/whatsapp/auto-close";
import { createAutoOpener } from "@/server/whatsapp/auto-open";
import { runCalendarWorker, type WorkerDeps } from "@/server/whatsapp/calendar/worker";
import { addWorkspaceMember, createWorkspace } from "@/server/workspaces/service";

import { createTestAdmin } from "./wa-admin";

/**
 * Opsiyon Aşama 3a — otomasyon ayarları, işlem kayıtları ve güvenlik (drizzle/0066 – 0069).
 * Gerçek PostgreSQL: görev fonksiyonları app_user ile, Super Admin fonksiyonları GERÇEK app_admin
 * rolüyle (SET ROLE), mesajlar ağ geçidi fonksiyonuyla kaydedilir ve üretimdeki worker'la işlenir.
 *
 * Kanıtlananlar: bütün anahtarlar varsayılan KAPALI; üç anahtar (global, işletme, grup) birlikte
 * açılmadan hiçbir mesaj okunmaz ve hiçbir işlem yazılmaz; anahtar açılmadan önceki mesajlar
 * geriye dönük işlenmez; yalnız Super Admin ayar değiştirir ve onay verir; app_user yalnız kendi
 * işletmesini okur, hiçbir tabloya yazamaz; mesajın durumu, worker önerisi ve WhatsApp tepki
 * kuyruğu hiçbir opsiyon işleminden etkilenmez; aynı mesaj ikinci kez işlem üretmez; süre
 * uydurulmaz; takvim değişen onaylı işlem uygulanmaz (stale); grup bağlantısını kaldırma işlem
 * kaydı varken de çalışır.
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 6 });
const app = drizzle(appPool, { schema, casing: DB_CASING });
const adminRolePool = new Pool({ connectionString: db.adminUrl, max: 3 });
adminRolePool.on("connect", (c) => void c.query("set role app_admin"));
const admin = new Client({ connectionString: db.adminUrl });
const tag = randomBytes(3).toString("hex");
const log = createLogger({ service: "option-automation-test" }, () => {});
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
const PN = `9053277${String(parseInt(tag, 16) % 100_000).padStart(5, "0")}`;
const TODAY = istanbulToday();
const day = (n: number) => addDays(TODAY, n);

let O: U, M: U, S: U, X: U;
let ws: string, wsX: string;
let mavi: string, asya: string, villaX: string;
let conn: string;
let G: { id: string; jid: string };
let G2: { id: string; jid: string };
let adminId: string, disabledAdmin: string;
const planCode = `opt3a_${tag}`;

let jidN = 0;
const jidBase = BigInt(`0x${randomBytes(4).toString("hex")}`) % 10_000_000n;
const newJid = () =>
  `120366${String(jidBase).padStart(7, "0")}${String(++jidN).padStart(5, "0")}@g.us`;

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

/** Super Admin fonksiyonu (gerçek app_admin rolü). */
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
const setGlobal = (on: boolean, who = adminId) =>
  adminOne("select public.app_option_admin_set_global($1, $2) as out", [who, on]);
const setWorkspace = (
  w: string,
  on: boolean,
  def: number | null = null,
  choices: number[] = [],
  who = adminId,
) =>
  adminOne("select public.app_option_admin_set_workspace($1, $2, $3, $4, $5) as out", [
    who,
    w,
    on,
    def,
    choices,
  ]);
const setGroup = (g: string, on: boolean, who = adminId) =>
  adminOne("select public.app_option_admin_set_group($1, $2, $3) as out", [who, g, on]);
/** Fonksiyon yetkileri: yalnız kümede var olan roller (ağ geçidi rolü ayrı betikle kurulur). */
async function fnPriv(fn: string) {
  const roles = ["app_user", "app_admin", "app_worker", "app_wa_gateway"];
  const out: Record<string, boolean> = {};
  for (const r of roles) {
    const exists = (await admin.query("select to_regrole($1) is not null e", [r])).rows[0].e;
    if (!exists) continue;
    out[r] = (
      await admin.query(`select has_function_privilege($1, 'public.${fn}', 'EXECUTE') p`, [r])
    ).rows[0].p;
  }
  const acl = (
    await admin.query(
      `select coalesce(proacl::text, '') a from pg_proc where oid = 'public.${fn}'::regprocedure`,
    )
  ).rows[0].a as string;
  out.PUBLIC = /(^|[{,])=X/.test(acl);
  return out;
}
const enabled = async (g: string) =>
  (await appPool.query("select public.app_option_automation_enabled($1) as on", [g])).rows[0]
    .on as boolean;

async function errCode(p: Promise<unknown>) {
  return p.then(
    () => "ok",
    (e: unknown) => {
      const i = pgErrorInfo(e);
      return i.message && /^[a-z_]+$/.test(i.message) ? i.message : (i.code ?? "error");
    },
  );
}

let msgN = 0;
/** Mesajı ağ geçidi fonksiyonuyla kaydeder ve üretimdeki worker'la işler. */
async function send(body: string, jid = G.jid) {
  const mid = `P${tag}${++msgN}`;
  await appPool.query(
    "select public.app_wa_ingest_message($1, $2, $3, '1@lid', $4, null, $5, now(), 'live')",
    [conn, jid, mid, PN, body],
  );
  await runCalendarWorker(app, deps);
  return (
    await admin.query<{ id: string; status: string }>(
      "select id, status from wa_inbound_messages where wa_message_id = $1",
      [mid],
    )
  ).rows[0]!;
}
const claim = async (limit = 50) =>
  (await appPool.query("select * from public.app_option_claim_messages($1)", [limit])).rows;
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

/** Mevcut sistemin bu mesaj için ürettiği her şey (öneri, tepki, mesaj durumu). */
async function existingView(messageId: string) {
  const q = async (s: string) => (await admin.query(s, [messageId])).rows;
  return {
    message: await q(
      "select status, attempts, processed_at, last_error from wa_inbound_messages where id = $1",
    ),
    proposals: await q(
      "select item_no, action, status, flags, review_reasons, version from wa_calendar_proposals where message_id = $1 order by item_no",
    ),
    reactions: await q(
      "select kind, emoji, status, attempts from wa_message_reactions where message_id = $1",
    ),
  };
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
  O = await mkUser("o3o");
  M = await mkUser("o3m");
  S = await mkUser("o3s");
  X = await mkUser("o3x");
  ws = (await createWorkspace(app, { userId: O.id, name: "Opsiyon 3a", slug: `o3a-${tag}` })).id;
  wsX = (await createWorkspace(app, { userId: X.id, name: "Başka", slug: `o3x-${tag}` })).id;
  const planId = uuidv7();
  await admin.query(
    "insert into plans (id, code, name, max_properties, trial_days, is_active, is_default) values ($1, $2, 'O3', 20, 14, true, false)",
    [planId, planCode],
  );
  await admin.query(
    "update workspace_subscriptions set plan_id = $1 where workspace_id in ($2, $3)",
    [planId, ws, wsX],
  );
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: M.id, role: "manager" }));
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: S.id, role: "staff" }));
  mavi = await villa("Villa Mavi", O, ws);
  asya = await villa("Villa Asya", O, ws);
  villaX = await villa("Villa Başka", X, wsX);
  conn = (
    await appPool.query<{ id: string }>("select public.app_wa_heartbeat($1, 'open', null) as id", [
      `o3a-${tag}`,
    ])
  ).rows[0]!.id;
  await admin.query(
    "insert into wa_verified_phones (user_id, phone_hash, phone_masked) values ($1, $2, '+90 532 *** ** 01')",
    [O.id, phoneHash(PN)],
  );
  G = await group(ws, mavi);
  G2 = await group(ws, asya);
  adminId = await createTestAdmin(admin, "opsiyon");
  disabledAdmin = await createTestAdmin(admin, "opsiyonpasif");
  await admin.query("update admin_users set status = 'disabled' where id = $1", [disabledAdmin]);
  await runCalendarWorker(app, deps); // ilk aktivasyon
});

afterAll(async () => {
  // Kill switch'i diğer test dosyaları için kapalı bırak.
  await admin.query("update option_automation_global set enabled = false where id = 1");
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
describe("varsayılanlar ve kill switch", () => {
  it("global anahtar tek satır ve KAPALI; işletme ve grup satırı yok; yeni grup kapalı", async () => {
    const g = (await admin.query("select id, enabled from option_automation_global")).rows;
    expect(g).toEqual([{ id: 1, enabled: false }]);
    expect(
      (
        await admin.query(
          "select count(*)::int n from workspace_option_settings where workspace_id = $1",
          [ws],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await admin.query(
          "select count(*)::int n from wa_group_option_settings where group_id = $1",
          [G.id],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(await enabled(G.id)).toBe(false);
  });

  it("üç anahtar birlikte açılmadan otomasyon kapalı; global kill switch hepsini kapatır", async () => {
    expect(await setWorkspace(ws, true, null, [])).toBe("changed");
    expect(await enabled(G.id)).toBe(false); // global + grup kapalı
    expect(await setGroup(G.id, true)).toBe("changed");
    expect(await enabled(G.id)).toBe(false); // global kapalı
    expect(await setGlobal(true)).toBe("changed");
    expect(await enabled(G.id)).toBe(true);
    expect(await enabled(G2.id)).toBe(false); // grup satırı yok
    expect(await setGlobal(false)).toBe("changed");
    expect(await enabled(G.id)).toBe(false); // kill switch
    expect(await setGlobal(false)).toBe("unchanged");
    expect(await setGlobal(true)).toBe("changed");
    expect(await setWorkspace(ws, false, null, [])).toBe("changed");
    expect(await enabled(G.id)).toBe(false); // işletme kill switch
    expect(await setWorkspace(ws, true, null, [])).toBe("changed");
    expect(await setGroup(G.id, false)).toBe("changed");
    expect(await enabled(G.id)).toBe(false); // grup kill switch
    expect(await setGroup(G.id, true)).toBe("changed");
    expect(await enabled(G.id)).toBe(true);
  });

  it("grup bağlantısı kaldırılıp yeniden bağlanınca grup ayarı geçersiz (yeniden açılmalı)", async () => {
    const g = await group(ws, mavi);
    expect(await setGroup(g.id, true)).toBe("changed");
    expect(await enabled(g.id)).toBe(true);
    await admin.query(
      "update wa_groups set status = 'discovered', workspace_id = null, property_id = null, linked_at = null where id = $1",
      [g.id],
    );
    expect(await enabled(g.id)).toBe(false);
    expect(await setGroup(g.id, true)).toBe("not_available");
    await admin.query(
      "update wa_groups set status = 'linked', workspace_id = $2, property_id = $3, linked_at = now() where id = $1",
      [g.id, ws, mavi],
    );
    expect(await enabled(g.id)).toBe(false); // eski ayar, yeni bağlanmadan önce
    expect(await setGroup(g.id, true)).toBe("changed");
    expect(await enabled(g.id)).toBe(true);
    // Başka işletmeye bağlanırsa eski işletmenin ayarı geçmez.
    await admin.query(
      "update wa_groups set workspace_id = $2, property_id = $3, linked_at = now() where id = $1",
      [g.id, wsX, villaX],
    );
    expect(await enabled(g.id)).toBe(false);
    expect(await setGroup(g.id, false)).toBe("changed");
  });
});

// ---------------------------------------------------------------------------------------------
describe("Super Admin ayarları: yetki, doğrulama, denetim", () => {
  it("pasif / olmayan yönetici reddedilir (42501); app_user ve ağ geçidi rolü fonksiyonları çağıramaz", async () => {
    for (const who of [disabledAdmin, uuidv7()]) {
      expect(await errCode(setGlobal(true, who))).toBe("option_admin_forbidden");
    }
    expect(
      await errCode(
        appPool.query("select public.app_option_admin_set_global($1, true)", [adminId]),
      ),
    ).toBe("42501");
    const fns = [
      "app_option_admin_settings(uuid)",
      "app_option_admin_set_global(uuid, boolean)",
      "app_option_admin_set_workspace(uuid, uuid, boolean, integer, integer[])",
      "app_option_admin_set_group(uuid, uuid, boolean)",
      "app_option_admin_options(uuid, text, integer)",
      "app_option_admin_operations(uuid, text, integer)",
      "app_option_admin_option_events(uuid, uuid)",
      "app_option_admin_alerts(uuid, integer)",
      "app_option_admin_decide(uuid, uuid, integer, boolean, text, date, date, integer, text, integer, integer)",
      "app_option_admin_cancel(uuid, uuid, integer, text)",
    ];
    for (const f of fns) {
      const p = await fnPriv(f);
      expect([
        f,
        Object.entries(p)
          .filter(([, v]) => v)
          .map(([k]) => k),
      ]).toEqual([f, ["app_admin"]]);
    }
  });

  it("süre değerleri: 1 saat – 14 gün; varsayılan seçeneklerde olmalı; seçenekler sıralı ve tekil saklanır", async () => {
    for (const bad of [
      () => setWorkspace(ws, true, 30, []),
      () => setWorkspace(ws, true, 20161, []),
      () => setWorkspace(ws, true, null, [59]),
      () => setWorkspace(ws, true, 120, [60, 180]),
      () =>
        setWorkspace(
          ws,
          true,
          null,
          Array.from({ length: 13 }, (_, i) => 60 + i),
        ),
    ]) {
      expect(await errCode(bad())).toBe("option_settings_invalid");
    }
    expect(await setWorkspace(ws, true, 1440, [2880, 1440, 1440, 720])).toBe("changed");
    const s = (
      await admin.query(
        "select default_duration_minutes d, duration_choices c, updated_by_admin a from workspace_option_settings where workspace_id = $1",
        [ws],
      )
    ).rows[0];
    expect(s).toEqual({ d: 1440, c: [720, 1440, 2880], a: adminId });
    expect(await setWorkspace(ws, true, 1440, [720, 1440, 2880])).toBe("unchanged");
    expect(await setWorkspace(uuidv7(), true, null, [])).toBe("not_found");
    // Testlerin geri kalanı için: varsayılan süre yok.
    expect(await setWorkspace(ws, true, null, [])).toBe("changed");
  });

  it("her değişiklik admin_audit_log ve işletmenin audit_log kaydına yazılır; liste fonksiyonu etkin durumu verir", async () => {
    const a = (
      await admin.query(
        "select action, count(*)::int n from admin_audit_log where admin_id = $1 and action like 'option.%' group by 1 order by 1",
        [adminId],
      )
    ).rows;
    expect(a.map((r) => r.action)).toEqual([
      "option.automation_global",
      "option.automation_group",
      "option.automation_workspace",
    ]);
    const w = (
      await admin.query(
        "select count(*)::int n from audit_log where workspace_id = $1 and action = 'option.settings_changed'",
        [ws],
      )
    ).rows[0].n;
    expect(w).toBeGreaterThan(0);
    const rows = await asAdmin<{ scope: string; target_id: string; effective: boolean }>(
      "select scope, target_id, effective from public.app_option_admin_settings($1)",
      [adminId],
    );
    expect(rows.find((r) => r.scope === "global")?.effective).toBe(true);
    expect(rows.find((r) => r.scope === "group" && r.target_id === G.id)?.effective).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
describe("RLS ve yetkiler", () => {
  it("app_user hiçbir yeni tabloya yazamaz; ayarları yalnız kendi işletmesinin owner/manager'ı okur", async () => {
    const write = (u: U, w: string, q: string) => errCode(as(u, w, (tx) => tx.execute(sql.raw(q))));
    for (const q of [
      "update option_automation_global set enabled = true",
      `insert into workspace_option_settings (workspace_id) values ('${ws}')`,
      `update wa_group_option_settings set enabled = true`,
      `delete from option_operations`,
      `update option_conflict_alerts set acknowledged_at = now()`,
      `select * from option_message_scans`,
    ]) {
      expect([q.slice(0, 30), await write(O, ws, q)]).toEqual([q.slice(0, 30), "42501"]);
    }
    const read = (u: U, w: string, t: string) =>
      as(u, w, async (tx) => (await tx.execute(sql.raw(`select * from ${t}`))).rows.length);
    expect(await read(O, ws, "workspace_option_settings")).toBe(1);
    expect(await read(M, ws, "wa_group_option_settings")).toBeGreaterThan(0);
    expect(await read(S, ws, "workspace_option_settings")).toBe(0);
    expect(await read(X, wsX, `workspace_option_settings where workspace_id = '${ws}'`)).toBe(0);
    expect(await read(X, wsX, `wa_group_option_settings where workspace_id = '${ws}'`)).toBe(0);
    expect(await read(S, ws, "option_automation_global")).toBe(1);
  });

  it("yeni tablolar FORCE RLS; app_user'ın yazma, app_worker / app_admin / ağ geçidinin hiçbir tablo yetkisi yok", async () => {
    const t = (
      await admin.query(
        `select c.relname, c.relrowsecurity rls, c.relforcerowsecurity force,
                has_table_privilege('app_user', c.oid, 'INSERT') or has_table_privilege('app_user', c.oid, 'UPDATE')
                  or has_table_privilege('app_user', c.oid, 'DELETE') uw,
                has_table_privilege('app_worker', c.oid, 'SELECT') w,
                has_table_privilege('app_admin', c.oid, 'SELECT') a
           from pg_class c
          where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
            and c.relname in ('option_automation_global', 'workspace_option_settings', 'wa_group_option_settings',
                              'option_operations', 'option_conflict_alerts', 'option_message_scans')
          order by 1`,
      )
    ).rows;
    expect(t).toHaveLength(6);
    for (const r of t) {
      expect(r).toMatchObject({ rls: true, force: true, uw: false, w: false, a: false });
    }
    const task = [
      "app_option_claim_messages(integer)",
      "app_wa_option_apply(uuid, jsonb)",
      "app_option_expire_due(integer)",
      "app_option_scan_conflicts(integer)",
      "app_option_claim_operations(integer)",
      "app_option_apply_operation(uuid, uuid)",
      "app_option_finish_operation(uuid, uuid, text, text)",
      "app_option_automation_enabled(uuid)",
      "app_option_automation_since(uuid)",
    ];
    for (const f of task) {
      const p = await fnPriv(f);
      expect([
        f,
        Object.entries(p)
          .filter(([, v]) => v)
          .map(([k]) => k),
      ]).toEqual([f, ["app_user"]]);
    }
    const internal = (
      await admin.query(
        `select proname, has_function_privilege('app_user', p.oid, 'EXECUTE') u
           from pg_proc p where pronamespace = 'public'::regnamespace
            and proname in ('app_option_admin_check', 'app_option_fingerprint', 'app_option_conflict_count')`,
      )
    ).rows;
    expect(internal.every((r) => r.u === false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
describe("mesajdan işlem (görev fonksiyonları)", () => {
  it("otomasyon kapalı grubun ve anahtar açılmadan önceki mesajların hiçbiri okunmaz", async () => {
    const before = await send(`${day(20)}`, G2.jid); // G2'de grup anahtarı yok
    expect((await claim()).map((r) => r.message_id)).not.toContain(before.id);
    // G2'yi aç: açılmadan önce gelen mesaj yine okunmaz (geriye dönük işlem yok).
    expect(await setGroup(G2.id, true)).toBe("changed");
    expect((await claim()).map((r) => r.message_id)).not.toContain(before.id);
    expect(await setGroup(G2.id, false)).toBe("changed");
  });

  it("oluşturma (süre mesajda): opsiyon + 'applied' işlem; mesaj, öneri ve WhatsApp tepkisi değişmez; ikinci kez işlem yok", async () => {
    const m = await send("opsiyon mesajı 1");
    const seen = await existingView(m.id);
    const reactionsBefore = (await admin.query("select count(*)::int n from wa_message_reactions"))
      .rows[0].n;
    const c = await claim();
    expect(c.map((r) => r.message_id)).toContain(m.id);
    expect(c.find((r) => r.message_id === m.id)).toMatchObject({
      property_id: mavi,
      group_id: G.id,
    });
    const r = await apply(m.id, [
      item({
        intent: "create",
        check_in: day(30),
        check_out: day(33),
        expires_in_minutes: 1440,
        adults: 2,
      }),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].status).toBe("applied");
    const o = await opt(r[0].option_id);
    const sent = (
      await admin.query("select sent_at from wa_inbound_messages where id = $1", [m.id])
    ).rows[0].sent_at as Date;
    expect(o).toMatchObject({
      status: "open",
      source: "whatsapp",
      group_id: G.id,
      property_id: mavi,
      expiry_source: "message",
      adults: 2,
    });
    expect(new Date(o.expires_at).getTime() - sent.getTime()).toBe(1440 * 60_000);
    const x = await op(r[0].operation_id);
    expect(x).toMatchObject({
      kind: "create",
      mode: "auto",
      status: "applied",
      result_option_id: o.id,
      version: 1,
    });
    expect(x.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    // Mevcut sistem: mesaj durumu, öneri ve ⚠️ tepkisi birebir aynı; yeni tepki satırı yok.
    expect(await existingView(m.id)).toEqual(seen);
    expect((await admin.query("select count(*)::int n from wa_message_reactions")).rows[0].n).toBe(
      reactionsBefore,
    );
    // İmleç "done": tekrar okunmaz; fonksiyon yeniden çağrılsa da işlem yazılmaz.
    expect((await claim()).map((r2) => r2.message_id)).not.toContain(m.id);
    expect(
      await apply(m.id, [
        item({ intent: "create", check_in: day(30), check_out: day(33), expires_in_minutes: 1440 }),
      ]),
    ).toEqual([]);
    expect(
      (
        await admin.query("select count(*)::int n from option_operations where message_id = $1", [
          m.id,
        ])
      ).rows[0].n,
    ).toBe(1);
  });

  it("süre yok + varsayılan yok → opsiyon YOK, Super Admin onayı (duration_missing); varsayılan varsa workspace_default", async () => {
    const m = await send("opsiyon mesajı 2");
    await claim();
    const r = await apply(m.id, [
      item({ intent: "create", check_in: day(40), check_out: day(42) }),
    ]);
    expect(r[0]).toMatchObject({ status: "pending", option_id: null });
    expect(await op(r[0].operation_id)).toMatchObject({
      mode: "needs_approval",
      reasons: ["duration_missing"],
      expires_in_minutes: null,
    });

    expect(await setWorkspace(ws, true, 2880, [1440, 2880])).toBe("changed");
    const m2 = await send("opsiyon mesajı 3");
    await claim();
    const r2 = await apply(m2.id, [
      item({ intent: "create", check_in: day(44), check_out: day(46) }),
    ]);
    expect(r2[0].status).toBe("applied");
    expect(await opt(r2[0].option_id)).toMatchObject({ expiry_source: "workspace_default" });
    expect(await setWorkspace(ws, true, null, [])).toBe("changed");
  });

  it("çakışan opsiyon, kesin kayıt, belirsiz öğe → onaya; soru ve bilinmeyen niyet işlem üretmez", async () => {
    const m = await send("opsiyon mesajı 4");
    await claim();
    // day(30)-day(33) arasında açık opsiyon var.
    const r = await apply(m.id, [
      item({ intent: "create", check_in: day(31), check_out: day(34), expires_in_minutes: 600 }),
    ]);
    expect(await op(r[0].operation_id)).toMatchObject({
      status: "pending",
      reasons: ["option_overlap"],
    });

    await as(O, ws, (tx, ctx) =>
      createReservation(tx, ctx, {
        kind: "block",
        propertyId: mavi,
        checkIn: day(50),
        checkOut: day(52),
      }),
    );
    const m2 = await send("opsiyon mesajı 5");
    await claim();
    const r2 = await apply(m2.id, [
      item({ intent: "create", check_in: day(50), check_out: day(51), expires_in_minutes: 600 }),
      item({
        item_no: 1,
        intent: "create",
        decision: "ask",
        reasons: ["villa_unclear"],
        check_in: day(60),
        check_out: day(61),
      }),
      item({ item_no: 2, intent: "unknown", decision: "ask", reasons: ["intent_unclear"] }),
      item({ item_no: 3, intent: "create", decision: "ignore", reasons: ["question"] }),
    ]);
    expect(r2.map((x) => [x.item_no, x.status])).toEqual([
      [0, "pending"],
      [1, "pending"],
    ]);
    expect((await op(r2[0].operation_id)).reasons).toEqual(["calendar_conflict"]);
    expect((await op(r2[1].operation_id)).reasons).toEqual(["duration_missing", "villa_unclear"]);
  });

  it("geçersiz öğe reddedilir; veritabanı nedeni dışarıdan verilemez; panel_cancel WhatsApp'tan gelemez", async () => {
    const m = await send("opsiyon mesajı 6");
    await claim();
    for (const bad of [
      item({ intent: "x" }),
      item({ intent: "create", reasons: ["calendar_conflict"] }),
      item({ intent: "create", check_in: day(70), check_out: day(69) }),
      item({ intent: "create", expires_in_minutes: 30 }),
      item({ intent: "cancel", end_reason: "panel_cancel" }),
      item({ item_no: 25, intent: "create" }),
    ]) {
      expect(await errCode(apply(m.id, [bad]))).toBe("option_items_invalid");
    }
  });

  it("iptal: tek açık opsiyon hedeflenir (yalnız o değişir); iki aday → onay; kesinleştirme yalnız kayıt (bilgi eksikse onay)", async () => {
    const m = await send("opsiyon mesajı 7");
    await claim();
    const created = await apply(m.id, [
      item({ intent: "create", check_in: day(80), check_out: day(83), expires_in_minutes: 1440 }),
    ]);
    const target = created[0].option_id as string;
    const others = (
      await admin.query(
        "select id, status, version from reservation_options where id <> $1 order by id",
        [target],
      )
    ).rows;

    const c1 = await send("opsiyon iptal mesajı");
    await claim();
    const conv = await apply(c1.id, [
      item({ intent: "convert", check_in: day(80), check_out: day(83) }),
    ]);
    expect(await op(conv[0].operation_id)).toMatchObject({
      kind: "convert",
      status: "pending",
      mode: "needs_approval",
      target_option_id: target,
      reasons: ["guest_info_missing"],
    });
    expect((await opt(target)).status).toBe("open"); // kesinleştirme 3a'da uygulanmaz

    const c2 = await send("opsiyon iptal mesajı 2");
    await claim();
    const can = await apply(c2.id, [
      item({
        intent: "cancel",
        check_in: day(80),
        check_out: day(83),
        end_reason: "owner_cancelled",
      }),
    ]);
    expect(can[0].status).toBe("applied");
    expect(await opt(target)).toMatchObject({
      status: "cancelled",
      end_reason: "owner_cancelled",
      ended_by_message_id: c2.id,
    });
    expect(
      (
        await admin.query(
          "select id, status, version from reservation_options where id <> $1 order by id",
          [target],
        )
      ).rows,
    ).toEqual(others);

    // Tarihsiz iptal: grupta birden fazla açık opsiyon → onay (hiçbiri değişmez).
    const c3 = await send("opsiyon iptal mesajı 3");
    await claim();
    const multi = await apply(c3.id, [item({ intent: "cancel" })]);
    expect(await op(multi[0].operation_id)).toMatchObject({
      status: "pending",
      reasons: ["multiple_open_options"],
    });
    expect(
      (
        await admin.query(
          "select id, status, version from reservation_options where id <> $1 order by id",
          [target],
        )
      ).rows,
    ).toEqual(others);
  });
});

// ---------------------------------------------------------------------------------------------
describe("süre dolumu ve çakışma uyarısı", () => {
  it("süresi dolan açık opsiyon 'expired' olur (geçmiş yazılır); rezervasyon ve bloklar değişmez", async () => {
    const id = uuidv7();
    await admin.query(
      `insert into reservation_options (id, workspace_id, property_id, source, check_in, check_out, expires_at, expiry_source)
       values ($1, $2, $3, 'panel', $4, $5, now() + interval '1 second', 'manual')`,
      [id, ws, asya, day(90), day(92)],
    );
    const res = (
      await admin.query(
        "select md5(string_agg(r::text, '|' order by r.id)) h from reservations r where workspace_id = $1",
        [ws],
      )
    ).rows[0].h;
    await new Promise((r) => setTimeout(r, 1_200));
    const n = (await appPool.query("select public.app_option_expire_due(100) n")).rows[0].n;
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await opt(id)).toMatchObject({ status: "expired", end_reason: "expired" });
    const ev = (
      await admin.query(
        "select event, actor_admin_id from reservation_option_events where option_id = $1 order by version",
        [id],
      )
    ).rows;
    expect(ev).toEqual([
      { event: "created", actor_admin_id: null },
      { event: "expired", actor_admin_id: null },
    ]);
    expect(
      (
        await admin.query(
          "select md5(string_agg(r::text, '|' order by r.id)) h from reservations r where workspace_id = $1",
          [ws],
        )
      ).rows[0].h,
    ).toBe(res);
  });

  it("açık opsiyonla çakışan kesin kayıt → tek uyarı (yeniden taramada mükerrer yok); opsiyon ve kayıt değişmez", async () => {
    const id = uuidv7();
    await admin.query(
      "insert into reservation_options (id, workspace_id, property_id, source, check_in, check_out) values ($1, $2, $3, 'panel', $4, $5)",
      [id, ws, asya, day(100), day(104)],
    );
    const before = await opt(id);
    const r = await as(O, ws, (tx, ctx) =>
      createReservation(tx, ctx, {
        kind: "reservation",
        propertyId: asya,
        checkIn: day(102),
        checkOut: day(105),
        status: "confirmed",
        source: "phone",
        guestName: "Misafir Test",
        adults: "2",
        children: "0",
      }),
    );
    const resBefore = (await admin.query("select * from reservations where id = $1", [r])).rows[0];
    await appPool.query("select public.app_option_scan_conflicts(500)");
    await appPool.query("select public.app_option_scan_conflicts(500)");
    const alerts = (
      await admin.query(
        "select source_kind, source_id from option_conflict_alerts where option_id = $1",
        [id],
      )
    ).rows;
    expect(alerts).toEqual([{ source_kind: "reservation", source_id: r }]);
    expect(await opt(id)).toEqual(before);
    expect((await admin.query("select * from reservations where id = $1", [r])).rows[0]).toEqual(
      resBefore,
    );
    const listed = await asAdmin<{ option_id: string }>(
      "select option_id from public.app_option_admin_alerts($1, 500)",
      [adminId],
    );
    expect(listed.map((a) => a.option_id)).toContain(id);
  });
});

// ---------------------------------------------------------------------------------------------
describe("Super Admin onayı, uygulama ve panelden iptal", () => {
  let pendingCreate: string;
  beforeAll(async () => {
    const m = await send("opsiyon mesajı 8");
    await claim();
    const r = await apply(m.id, [
      item({ intent: "create", check_in: day(120), check_out: day(123) }),
    ]);
    pendingCreate = r[0].operation_id;
  });

  it("onay listesi yalnız bekleyenler; eksik bilgiyle onay reddedilir; eski sürüm 'version_conflict'", async () => {
    const list = await asAdmin<{ id: string }>(
      "select id from public.app_option_admin_operations($1, null, 500)",
      [adminId],
    );
    expect(list.map((x) => x.id)).toContain(pendingCreate);
    const decide = (version: number, approve: boolean, minutes: number | null) =>
      adminOne(
        "select public.app_option_admin_decide($1, $2, $3, $4, 'not', null, null, $5, null, null, null) as out",
        [adminId, pendingCreate, version, approve, minutes],
      );
    expect(await errCode(decide(1, true, null))).toBe("option_decision_incomplete");
    expect(await decide(9, true, 600)).toBe("version_conflict");
    expect(await decide(1, true, 600)).toBe("approved");
    expect(await op(pendingCreate)).toMatchObject({
      status: "approved",
      decided_by_admin: adminId,
      expires_in_minutes: 600,
      expiry_source: "manual",
      version: 2,
    });
    expect(await decide(2, false, null)).toBe("not_pending");
  });

  it("kill switch kapalıyken onaylı işlem alınmaz; açıkken uygulanır (opsiyon + geçmişte Super Admin aktörü)", async () => {
    await setGlobal(false);
    expect(
      (await appPool.query("select * from public.app_option_claim_operations(20)")).rows,
    ).toEqual([]);
    await setGlobal(true);
    const claimed = (await appPool.query("select * from public.app_option_claim_operations(20)"))
      .rows;
    const mine = claimed.find((x) => x.id === pendingCreate)!;
    expect(mine).toBeTruthy();
    const out = (
      await appPool.query("select public.app_option_apply_operation($1, $2) out", [
        mine.id,
        mine.lock_token,
      ])
    ).rows[0].out;
    expect(out).toBe("applied");
    const x = await op(pendingCreate);
    expect(x.status).toBe("applied");
    const ev = (
      await admin.query(
        "select event, actor_admin_id from reservation_option_events where option_id = $1",
        [x.result_option_id],
      )
    ).rows;
    expect(ev).toEqual([{ event: "created", actor_admin_id: adminId }]);
    // Aynı kilitle ikinci uygulama yok.
    expect(
      (
        await appPool.query("select public.app_option_apply_operation($1, $2) out", [
          mine.id,
          mine.lock_token,
        ])
      ).rows[0].out,
    ).toBe("lost");
    // Diğer alınan işlemlerin kilidini bırak.
    for (const c of claimed.filter((y) => y.id !== pendingCreate)) {
      await appPool.query("select public.app_option_finish_operation($1, $2, 'release', null)", [
        c.id,
        c.lock_token,
      ]);
    }
  });

  it("onaydan sonra takvim değişirse işlem uygulanmaz ('stale'); ret kaydı tutulur", async () => {
    const m = await send("opsiyon mesajı 9");
    await claim();
    const r = await apply(m.id, [
      item({ intent: "create", check_in: day(130), check_out: day(132) }),
    ]);
    const id = r[0].operation_id as string;
    expect(
      await adminOne(
        "select public.app_option_admin_decide($1, $2, 1, true, null, null, null, 300, null, null, null) as out",
        [adminId, id],
      ),
    ).toBe("approved");
    await as(O, ws, (tx, ctx) =>
      createReservation(tx, ctx, {
        kind: "block",
        propertyId: mavi,
        checkIn: day(131),
        checkOut: day(133),
      }),
    );
    const claimed = (await appPool.query("select * from public.app_option_claim_operations(20)"))
      .rows;
    const mine = claimed.find((x) => x.id === id)!;
    expect(
      (
        await appPool.query("select public.app_option_apply_operation($1, $2) out", [
          mine.id,
          mine.lock_token,
        ])
      ).rows[0].out,
    ).toBe("stale");
    expect(await op(id)).toMatchObject({
      status: "stale",
      failure_code: "calendar_changed",
      result_option_id: null,
    });
    for (const c of claimed.filter((y) => y.id !== id)) {
      await appPool.query("select public.app_option_finish_operation($1, $2, 'release', null)", [
        c.id,
        c.lock_token,
      ]);
    }

    const m2 = await send("opsiyon mesajı 10");
    await claim();
    const r2 = await apply(m2.id, [
      item({ intent: "create", check_in: day(140), check_out: day(142) }),
    ]);
    expect(
      await adminOne(
        "select public.app_option_admin_decide($1, $2, 1, false, 'gerek yok', null, null, null, null, null, null) as out",
        [adminId, r2[0].operation_id],
      ),
    ).toBe("rejected");
    expect(await op(r2[0].operation_id)).toMatchObject({
      status: "rejected",
      decision_note: "gerek yok",
    });
    const audit = (
      await admin.query("select action from admin_audit_log where target_id = $1", [
        r2[0].operation_id,
      ])
    ).rows;
    expect(audit).toEqual([{ action: "option.operation_rejected" }]);
  });

  it("panelden iptal: panel_cancel, Super Admin aktörü, sürüm kilidi; kesin kayıtlar değişmez", async () => {
    const id = uuidv7();
    await admin.query(
      "insert into reservation_options (id, workspace_id, property_id, source, check_in, check_out) values ($1, $2, $3, 'panel', $4, $5)",
      [id, ws, mavi, day(150), day(152)],
    );
    const res = (
      await admin.query(
        "select md5(string_agg(r::text, '|' order by r.id)) h from reservations r where workspace_id = $1",
        [ws],
      )
    ).rows[0].h;
    const cancel = (v: number) =>
      adminOne("select public.app_option_admin_cancel($1, $2, $3, 'not') as out", [adminId, id, v]);
    expect(await cancel(5)).toBe("version_conflict");
    expect(await cancel(1)).toBe("cancelled");
    expect(await cancel(2)).toBe("not_open");
    expect(await opt(id)).toMatchObject({ status: "cancelled", end_reason: "panel_cancel" });
    const ev = await asAdmin<{ event: string; actor_admin_id: string | null }>(
      "select event, actor_admin_id from public.app_option_admin_option_events($1, $2)",
      [adminId, id],
    );
    expect(ev).toEqual([
      { event: "created", actor_admin_id: null },
      { event: "cancelled", actor_admin_id: adminId },
    ]);
    expect(
      (
        await admin.query(
          "select md5(string_agg(r::text, '|' order by r.id)) h from reservations r where workspace_id = $1",
          [ws],
        )
      ).rows[0].h,
    ).toBe(res);
    const listed = await asAdmin<{ id: string; status: string }>(
      "select id, status from public.app_option_admin_options($1, 'cancelled', 500)",
      [adminId],
    );
    expect(listed.map((x) => x.id)).toContain(id);
  });

  it("işlem kaydı silinemez, son durum değişmez", async () => {
    expect(
      await errCode(admin.query("delete from option_operations where id = $1", [pendingCreate])),
    ).toBe("option_operation_delete_forbidden");
    expect(
      await errCode(
        admin.query(
          "update option_operations set status = 'pending', applied_at = null where id = $1",
          [pendingCreate],
        ),
      ),
    ).toBe("option_operation_final");
    expect(
      await errCode(
        admin.query("update option_operations set kind = 'cancel' where id = $1", [pendingCreate]),
      ),
    ).toBe("option_operation_immutable_field");
  });
});

// ---------------------------------------------------------------------------------------------
describe("mevcut davranış korunur", () => {
  it("0070: opsiyonu ve gölge kaydı olan grubun bağlantısını kaldırma (mevcut Super Admin işlemi) çalışır; kayıtlar değişmez", async () => {
    const g = await group(ws, asya);
    const m = await send("opsiyon mesajı 12", g.jid);
    const optId = uuidv7();
    await admin.query(
      `insert into reservation_options (id, workspace_id, property_id, source, group_id, origin_message_id,
         origin_wa_message_id, check_in, check_out)
       values ($1, $2, $3, 'whatsapp', $4, $5, $6, $7, $8)`,
      [optId, ws, asya, g.id, m.id, `W${optId}`, day(170), day(172)],
    );
    await admin.query(
      `insert into wa_option_shadow_decisions (id, workspace_id, group_id, message_id, item_no, parser_version,
         intent, decision, reasons, property_id, check_in, check_out)
       values (gen_random_uuid(), $1, $2, $3, 0, 8, 'create', 'apply', '{}', $4, $5, $6)`,
      [ws, g.id, m.id, asya, day(170), day(172)],
    );
    const before = await opt(optId);
    const out = await adminOne("select public.app_wa_admin_unlink_group($1, $2) as out", [
      adminId,
      g.id,
    ]);
    expect(out).toBe("unlinked");
    const grp = (
      await admin.query("select status, workspace_id, property_id from wa_groups where id = $1", [
        g.id,
      ])
    ).rows[0];
    expect(grp).toEqual({ status: "discovered", workspace_id: null, property_id: null });
    // Opsiyon yerinde: yalnız mesaj temizliğinin NULL'a indirdiği referans değişti (A2 kuralı).
    const after = await opt(optId);
    expect({ ...after, origin_message_id: before.origin_message_id }).toEqual(before);
    expect(after.origin_message_id).toBeNull();
    expect(after.group_id).toBe(g.id);
    // Gölge kaydı mesajla birlikte silinir (A2: mesaj temizliğinde cascade) — mevcut davranış.
    expect(
      (
        await admin.query(
          "select count(*)::int n from wa_option_shadow_decisions where group_id = $1",
          [g.id],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("işlem kaydı olan grubun bağlantısını kaldırma (mevcut Super Admin işlemi) aynen çalışır", async () => {
    const g = await group(ws, asya);
    await setGroup(g.id, true);
    const m = await send("opsiyon mesajı 11", g.jid);
    await claim();
    const r = await apply(m.id, [
      item({ intent: "create", check_in: day(160), check_out: day(162) }),
    ]);
    expect(r[0].status).toBe("pending");
    const out = await adminOne("select public.app_wa_admin_unlink_group($1, $2) as out", [
      adminId,
      g.id,
    ]);
    expect(out).toBe("unlinked");
    expect(await op(r[0].operation_id)).toMatchObject({
      group_id: g.id,
      message_id: null,
      status: "pending",
    });
    expect(await enabled(g.id)).toBe(false);
  });
});
