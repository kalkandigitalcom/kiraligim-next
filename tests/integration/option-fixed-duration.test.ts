import { createHash, randomBytes } from "node:crypto";

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
const log = createLogger({ service: "option-fixed-duration-test" }, () => {});
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

let O: U, X: U;
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
const setWorkspaceAdmin = (w: string, def: number | null, choices: number[] = []) =>
  adminOne("select public.app_option_admin_set_workspace($1, $2, false, $3, $4) as out", [
    adminId,
    w,
    def,
    choices,
  ]);

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
/** Mesajın gönderilme anını sabitler (yalnız test süper kullanıcısı; tetikleyiciler atlanır). */
async function setSentAt(messageId: string, at: Date) {
  await admin.query("set session_replication_role = replica");
  try {
    await admin.query("update wa_inbound_messages set sent_at = $2 where id = $1", [messageId, at]);
  } finally {
    await admin.query("set session_replication_role = origin");
  }
}

describe("sabit 24 saat: ayar yolu yok", () => {
  it("süre ayarı fonksiyonları kaldırıldı; hiçbir rol süre değiştiremez", async () => {
    for (const f of [
      "app_option_owner_set_default(integer)",
      "app_option_admin_set_default_duration(uuid, integer)",
      "app_option_admin_default_duration(uuid)",
    ]) {
      expect((await admin.query(`select to_regprocedure('public.${f}') r`)).rows[0].r).toBeNull();
    }
    // İşletme rolleri opsiyon ve ayar tablolarına yazamaz (yönetim yalnız WhatsApp'tan).
    for (const t of [
      "reservation_options",
      "option_operations",
      "workspace_option_settings",
      "option_automation_global",
    ]) {
      expect(
        (
          await admin.query(
            `select has_table_privilege('app_user', 'public.${t}', 'INSERT,UPDATE,DELETE') p`,
          )
        ).rows[0].p,
      ).toBe(false);
    }
  });

  it("süre yazılmamış → 24 saat (system_default); işletme varsayılanı ve sistem sütunu okunmaz", async () => {
    const a = await create({ check_in: day(40), check_out: day(42) });
    expect(a.r.status).toBe("applied");
    expect(a.op).toMatchObject({
      mode: "auto",
      expiry_source: "system_default",
      expires_in_minutes: 1440,
    });
    const x = await opt(a.r.option_id);
    expect(x.expiry_source).toBe("system_default");
    expect(new Date(x.expires_at).getTime() - a.m.sent_at.getTime()).toBe(1440 * 60_000);

    // Eski ayar değerleri dolu olsa da sonuç değişmez.
    expect(await setWorkspaceAdmin(ws, 2880)).toBe("changed");
    await admin.query(
      "update option_automation_global set default_duration_minutes = 4320 where id = 1",
    );
    try {
      const b = await create({ check_in: day(44), check_out: day(46) });
      expect(b.op).toMatchObject({ expiry_source: "system_default", expires_in_minutes: 1440 });
      expect(
        new Date((await opt(b.r.option_id)).expires_at).getTime() - b.m.sent_at.getTime(),
      ).toBe(1440 * 60_000);
    } finally {
      await admin.query(
        "update option_automation_global set default_duration_minutes = 1440 where id = 1",
      );
      expect(await setWorkspaceAdmin(ws, null)).toBe("changed");
    }
  });

  it("mesajda açıkça yazılan süre aynen kullanılır", async () => {
    const b = await create({ check_in: day(48), check_out: day(50), expires_in_minutes: 600 });
    expect(b.op).toMatchObject({ mode: "auto", expiry_source: "message", expires_in_minutes: 600 });
    expect(new Date((await opt(b.r.option_id)).expires_at).getTime() - b.m.sent_at.getTime()).toBe(
      600 * 60_000,
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe("giriş kuralları (app_wa_option_apply)", () => {
  it("mesajda yazılı süre girişi aşarsa opsiyon YOK, kısaltma YOK → açıklama bekler", async () => {
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

  it("24 saat girişi aşarsa bitiş giriş anına çekilir; girişe 60 dakikadan az kalıyorsa açıklama bekler", async () => {
    // Giriş yarın 00:00 (İstanbul). Mesaj girişten 6 saat önce gönderilmiş; saat girişten 5 saat önce.
    const cap = checkInStart(day(1));
    const ok = await (async () => {
      const m = await send(`opsiyon sabit ${++msgN}`);
      await claim();
      await setSentAt(m.id, new Date(cap - 6 * 3_600_000));
      return withClock(new Date(cap - 5 * 3_600_000), async () => {
        const r = (
          await apply(m.id, [item({ intent: "create", check_in: day(1), check_out: day(3) })])
        )[0];
        return { r, op: await op(r.operation_id) };
      });
    })();
    expect({ status: ok.r.status, reasons: ok.op.reasons }).toEqual({
      status: "applied",
      reasons: [],
    });
    expect(new Date((await opt(ok.r.option_id)).expires_at).getTime()).toBe(cap);
    expect(ok.op).toMatchObject({
      mode: "auto",
      expiry_source: "system_default",
      expires_in_minutes: 360,
    });
    expect(ok.op.after_state).toMatchObject({ status: "open", clamped_to_check_in: true });

    // Girişe 30 dakika kala: açıklama bekler (opsiyon yok).
    const m2 = await send(`opsiyon sabit ${++msgN}`);
    await claim();
    const cap5 = checkInStart(day(5));
    await setSentAt(m2.id, new Date(cap5 - 40 * 60_000));
    const late = await withClock(
      new Date(cap5 - 30 * 60_000),
      async () =>
        (await apply(m2.id, [item({ intent: "create", check_in: day(5), check_out: day(6) })]))[0],
    );
    expect(late).toMatchObject({ status: "pending", option_id: null });
    expect(await op(late.operation_id)).toMatchObject({
      mode: "clarify",
      reasons: ["check_in_too_close"],
    });

    // Gönderim anı saat kaymasıyla şimdiden ileride (girişe 59 dk; saat girişe 61 dk): işlem
    // kısıtına takılmadan açıklama bekler (kısaltılan süre 60 dakikanın altına düşmez).
    const m3 = await send(`opsiyon sabit ${++msgN}`);
    await claim();
    const cap7 = checkInStart(day(7));
    await setSentAt(m3.id, new Date(cap7 - 59 * 60_000));
    const skew = await withClock(
      new Date(cap7 - 61 * 60_000),
      async () =>
        (await apply(m3.id, [item({ intent: "create", check_in: day(7), check_out: day(8) })]))[0],
    );
    expect(skew).toMatchObject({ status: "pending", option_id: null });
    expect(await op(skew.operation_id)).toMatchObject({
      mode: "clarify",
      reasons: ["check_in_too_close"],
    });
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
    const { op: o2 } = await create({
      check_in: day(0),
      check_out: day(2),
      expires_in_minutes: 60,
    });
    expect(o2.reasons).toContain("date_past");
  });

  it("açıklama bekleyen işlemi hiçbir görev almaz, Super Admin onaylayamaz ama teknik takip için listeler; iptal / kesinleştirme belirsizliği eskisi gibi onaya", async () => {
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
    // Onay bekleyenler listesinde yok; teknik takip ("pending" filtresi) listesinde var.
    const approvals = await asAdmin<{ id: string }>(
      "select id from public.app_option_admin_operations($1, null, 500)",
      [adminId],
    );
    expect(approvals.map((x) => x.id)).not.toContain(o.id);
    const pending = await asAdmin<{ id: string; mode: string }>(
      "select id, mode from public.app_option_admin_operations($1, 'pending', 500)",
      [adminId],
    );
    expect(pending.find((x) => x.id === o.id)).toMatchObject({ mode: "clarify" });

    const m = await send("opsiyon iptal sabit");
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
});
