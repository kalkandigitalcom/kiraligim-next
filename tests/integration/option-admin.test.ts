import { createHash, randomBytes } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { DB_CASING } from "@/db/casing";
import { pgErrorInfo } from "@/db/pg-error";
import * as schema from "@/db/schema";
import { createStandaloneDb } from "@/db/standalone";
import { type TenantContext, type Tx, withTenant } from "@/db/tenant";
import { createLogger } from "@/lib/logger";
import { addDays, istanbulToday } from "@/lib/reservation-meta";
import {
  acknowledgeAlert,
  AdminOptionError,
  cancelOption,
  decideOperation,
  getOperation,
  getOperationRange,
  getOption,
  getOptionCounts,
  getOptionSettings,
  listAlerts,
  listOperations,
  listOptionEvents,
  listOptionOperations,
  listOptions,
  setOptionGlobal,
  setOptionGroup,
  setOptionWorkspace,
} from "@/server/admin/options";
import { setAdminGroupProperty } from "@/server/admin/whatsapp";
import { runOptionMaintenance } from "@/server/options/run";
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
 * Opsiyon Aşama 3c — Super Admin opsiyon paneli (src/server/admin/options.ts, drizzle/0071) ve
 * option-maintenance'ın onaylı işlem adımı. Gerçek PostgreSQL: panel modülü GERÇEK app_admin rolüyle
 * (SET ROLE), görev üretimdeki gibi app_user ile tek bağlantıda çalışır; mesajlar ağ geçidi
 * fonksiyonuyla kaydedilir ve üretimdeki worker'la işlenir (yalnız test düzeneği).
 *
 * Kanıtlananlar: yalnız etkin Super Admin okur / yazar (pasif yönetici, app_user, app_worker
 * reddedilir); listeler, detay, geçmiş, bağlı işlemler, güncel takvim (misafir adı yok) ve
 * adlarıyla uyarılar; uyarıyı görüldü yapma idempotent ve denetime yazılır; panelden iptal sürüm
 * kilitli; kesinleştirme onayı 3e'ye kadar kapalı ve görev onu almaz; anahtarlar varsayılan KAPALI;
 * kill switch kapalıyken onaylı işlem uygulanmaz ve anahtar değişikliğiyle yarışmaz (satır kilidi);
 * uygulama anında grubun villası ve takvim yeniden doğrulanır (değişmişse stale); aynı işlem iki kez
 * uygulanmaz; geçmişte Super Admin aktörü ve işletme denetim kaydı durur; mevcut sistem (müsaitlik,
 * iCal, API, webhook, rezervasyon, mesaj, öneri, tepki) DEĞİŞMEZ.
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 4 });
const app = drizzle(appPool, { schema, casing: DB_CASING });
const adminRolePool = new Pool({ connectionString: db.adminUrl, max: 2 });
adminRolePool.on("connect", (c) => void c.query("set role app_admin"));
const adminDb = drizzle(adminRolePool, { schema, casing: DB_CASING });
const admin = new Client({ connectionString: db.adminUrl });
const tag = randomBytes(3).toString("hex");
const quiet = createLogger({ service: "option-admin-test" }, () => {});
const deps: WorkerDeps = {
  log: quiet,
  autoClose: createAutoCloser(app),
  autoOpen: createAutoOpener(app),
  autoChange: createAutoChanger(app),
};

async function runTask() {
  const s = createStandaloneDb(db.appUrl, {
    max: 1,
    idleTimeoutMillis: 0,
    statement_timeout: 30_000,
    application_name: "kiraligim-option-admin-test",
  });
  try {
    return await runOptionMaintenance(s.db, { log: quiet });
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
const PN = `9053279${String(parseInt(tag, 16) % 100_000).padStart(5, "0")}`;
const TODAY = istanbulToday();
const day = (n: number) => addDays(TODAY, n);

let O: U;
let ws: string;
let mavi: string, asya: string;
let conn: string;
let G: { id: string; jid: string };
let adminId: string, disabledAdmin: string;
const planCode = `opt3c_${tag}`;
const icalToken = `o3c${tag}`.padEnd(43, "x");

let jidN = 0;
const jidBase = BigInt(`0x${randomBytes(4).toString("hex")}`) % 10_000_000n;
const newJid = () =>
  `120368${String(jidBase).padStart(7, "0")}${String(++jidN).padStart(5, "0")}@g.us`;

async function group(property: string) {
  const jid = newJid();
  await appPool.query("select public.app_wa_sync_group($1, $2, 'Ekip 3c', 4, false, false, true)", [
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

async function errCode(p: Promise<unknown>) {
  return p.then(
    () => "ok",
    (e: unknown) => {
      if (e instanceof AdminOptionError) return e.reason;
      const i = pgErrorInfo(e);
      return i.message && /^[a-z_]+$/.test(i.message) ? i.message : (i.code ?? "error");
    },
  );
}

let msgN = 0;
async function send(body: string, jid = G.jid) {
  const mid = `R${tag}${++msgN}`;
  await appPool.query(
    "select public.app_wa_ingest_message($1, $2, $3, '1@lid', $4, null, $5, now(), 'live')",
    [conn, jid, mid, PN, body],
  );
  await runCalendarWorker(app, deps);
  return (
    await admin.query<{ id: string }>(
      "select id from wa_inbound_messages where wa_message_id = $1",
      [mid],
    )
  ).rows[0]!;
}
const claim = async () =>
  (await appPool.query("select * from public.app_option_claim_messages(50)")).rows;
const applyMsg = async (message: string, items: object[]) =>
  (
    await appPool.query("select * from public.app_wa_option_apply($1, $2::jsonb)", [
      message,
      JSON.stringify(items),
    ])
  ).rows;
const item = (o: object) => ({ item_no: 0, decision: "apply", reasons: [], ...o });
const opRow = async (id: string) =>
  (await admin.query("select * from option_operations where id = $1", [id])).rows[0];
const optRow = async (id: string) =>
  (await admin.query("select * from reservation_options where id = $1", [id])).rows[0];

/** Mesajdan Super Admin onayı bekleyen OLUŞTUR işlemi (süre yazılmamış → duration_missing). */
async function pendingCreate(a: number, b: number, jid = G.jid) {
  const m = await send(`opsiyon 3c ${a}`, jid);
  await claim();
  const r = await applyMsg(m.id, [item({ intent: "create", check_in: day(a), check_out: day(b) })]);
  expect(r[0]).toMatchObject({ status: "pending", option_id: null });
  return r[0].operation_id as string;
}

async function reservation(property: string, a: string, b: string, guest = "Gizli Misafir") {
  return as(O, ws, (tx, ctx) =>
    createReservation(tx, ctx, {
      kind: "reservation",
      propertyId: property,
      checkIn: a,
      checkOut: b,
      status: "confirmed",
      source: "phone",
      guestName: guest,
      adults: "2",
      children: "0",
    }),
  );
}

/** Opsiyon işlemlerinden etkilenmemesi gereken HER dış görünüm. */
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
  O = await mkUser("o3c");
  ws = (await createWorkspace(app, { userId: O.id, name: "Opsiyon 3c", slug: `o3c-${tag}` })).id;
  const planId = uuidv7();
  await admin.query(
    "insert into plans (id, code, name, max_properties, trial_days, is_active, is_default) values ($1, $2, 'O3C', 20, 14, true, false)",
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
  mavi = await villa("Villa Mavi 3c");
  asya = await villa("Villa Asya 3c");
  conn = (
    await appPool.query<{ id: string }>("select public.app_wa_heartbeat($1, 'open', null) as id", [
      `o3c-${tag}`,
    ])
  ).rows[0]!.id;
  await admin.query(
    "insert into wa_verified_phones (user_id, phone_hash, phone_masked) values ($1, $2, '+90 532 *** ** 03')",
    [O.id, phoneHash(PN)],
  );
  await admin.query(
    "insert into property_ical_exports (property_id, workspace_id, token, created_by) values ($1, $2, $3, $4)",
    [mavi, ws, icalToken, O.id],
  );
  G = await group(mavi);
  adminId = await createTestAdmin(admin, "opsiyon3c");
  disabledAdmin = await createTestAdmin(admin, "opsiyon3cpasif");
  await admin.query("update admin_users set status = 'disabled' where id = $1", [disabledAdmin]);
  await runCalendarWorker(app, deps); // ilk aktivasyon
});

afterAll(async () => {
  // Bütün anahtarlar KAPALI bırakılır (diğer test dosyaları için de).
  await admin.query("update option_automation_global set enabled = false where id = 1");
  await admin.query(
    "update workspace_option_settings set automation_enabled = false where workspace_id = $1",
    [ws],
  );
  await admin.query("delete from wa_inbound_messages where workspace_id = $1", [ws]);
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
describe("yetki: yalnız etkin Super Admin", () => {
  const ADMIN_FNS: [string, string][] = [
    ["app_option_admin_counts", "$1"],
    ["app_option_admin_option", "$1, gen_random_uuid()"],
    ["app_option_admin_operation", "$1, gen_random_uuid()"],
    ["app_option_admin_option_operations", "$1, gen_random_uuid()"],
    ["app_option_admin_range_context", "$1, gen_random_uuid()"],
    ["app_option_admin_alert_list", "$1, null, true, 10"],
    ["app_option_admin_ack_alert", "$1, gen_random_uuid()"],
  ];

  it("pasif / olmayan yönetici reddedilir (42501)", async () => {
    for (const [fn, args] of ADMIN_FNS) {
      for (const who of [disabledAdmin, uuidv7()]) {
        const c = await adminRolePool.connect();
        try {
          const e = await c.query(`select * from public.${fn}(${args})`, [who]).then(
            () => "ok",
            (err: unknown) => pgErrorInfo(err).code,
          );
          expect(e, fn).toBe("42501");
        } finally {
          c.release();
        }
      }
    }
  });

  it("app_user ve app_worker Super Admin fonksiyonlarını çağıramaz; app_admin görev fonksiyonlarını çağıramaz", async () => {
    for (const [fn, args] of ADMIN_FNS) {
      const e = await appPool.query(`select * from public.${fn}(${args})`, [adminId]).then(
        () => "ok",
        (err: unknown) => pgErrorInfo(err).code,
      );
      expect(e, fn).toBe("42501");
      expect(
        (
          await admin.query(
            `select has_function_privilege('app_worker', p.oid, 'EXECUTE') x from pg_proc p where proname = $1`,
            [fn],
          )
        ).rows[0].x,
      ).toBe(false);
    }
    for (const fn of [
      "app_option_claim_approved_operations",
      "app_option_apply_approved_operation",
    ]) {
      const r = (
        await admin.query(
          `select has_function_privilege('app_admin', p.oid, 'EXECUTE') a,
                  has_function_privilege('app_user', p.oid, 'EXECUTE') u,
                  has_function_privilege('app_worker', p.oid, 'EXECUTE') w
             from pg_proc p where proname = $1`,
          [fn],
        )
      ).rows[0];
      expect(r).toEqual({ a: false, u: true, w: false });
    }
  });

  it("modül de etkin olmayan yöneticiyi reddeder", async () => {
    expect(await errCode(getOptionCounts(adminDb, disabledAdmin))).toBe("option_admin_forbidden");
  });
});

// ---------------------------------------------------------------------------------------------
describe("ayarlar ve kill switch", () => {
  it("varsayılan: global KAPALI; işletme / grup ayarı yok; sayaçlar global durumu verir", async () => {
    const s = await getOptionSettings(adminDb, adminId);
    expect(s.global.enabled).toBe(false);
    expect(s.workspaces.has(ws)).toBe(false);
    expect(s.groups.has(G.id)).toBe(false);
    expect((await getOptionCounts(adminDb, adminId)).globalEnabled).toBe(false);
  });

  it("işletme: varsayılan seçeneklerde olmalı; sıralı ve tekil saklanır; grup bağlı değilse not_available", async () => {
    expect(
      await errCode(
        setOptionWorkspace(adminDb, adminId, {
          workspaceId: ws,
          enabled: true,
          defaultMinutes: 600,
          choices: [1440, 2880],
        }),
      ),
    ).toBe("default_not_in_choices");
    expect(
      await setOptionWorkspace(adminDb, adminId, {
        workspaceId: ws,
        enabled: true,
        defaultMinutes: null,
        choices: [2880, 1440, 2880],
      }),
    ).toBe("changed");
    const s = await getOptionSettings(adminDb, adminId);
    expect(s.workspaces.get(ws)).toMatchObject({
      enabled: true,
      effective: false,
      choices: [1440, 2880],
    });
    expect(await setOptionGroup(adminDb, adminId, G.id, true)).toBe("changed");
    expect((await getOptionSettings(adminDb, adminId)).groups.get(G.id)).toMatchObject({
      enabled: true,
      effective: false, // global kapalı
    });
    const looseJid = newJid();
    await appPool.query(
      "select public.app_wa_sync_group($1, $2, 'Bağsız', 3, false, false, true)",
      [conn, looseJid],
    );
    const loose = (await admin.query("select id from wa_groups where jid = $1", [looseJid])).rows[0]
      .id as string;
    expect(await errCode(setOptionGroup(adminDb, adminId, loose, true))).toBe("not_available");
    expect(await errCode(setOptionGroup(adminDb, adminId, "x", true))).toBe("not_found");
  });

  it("global anahtar: açılır, kapanır (kill switch); her değişiklik admin_audit_log'a yazılır", async () => {
    const before = Number(
      (
        await admin.query(
          "select count(*)::int n from admin_audit_log where admin_id = $1 and action like 'option.%'",
          [adminId],
        )
      ).rows[0].n,
    );
    expect(await setOptionGlobal(adminDb, adminId, true)).toBe("changed");
    expect((await getOptionCounts(adminDb, adminId)).globalEnabled).toBe(true);
    expect((await getOptionSettings(adminDb, adminId)).groups.get(G.id)?.effective).toBe(true);
    expect(await setOptionGlobal(adminDb, adminId, false)).toBe("changed");
    expect(await setOptionGlobal(adminDb, adminId, false)).toBe("unchanged");
    const after = Number(
      (
        await admin.query(
          "select count(*)::int n from admin_audit_log where admin_id = $1 and action like 'option.%'",
          [adminId],
        )
      ).rows[0].n,
    );
    expect(after - before).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
describe("onay, ret ve onaylı işlemin uygulanması", () => {
  let opCreate: string;

  it("onay bekleyen listesi ve işlem detayı; güncel takvimde misafir adı yok", async () => {
    await setOptionGlobal(adminDb, adminId, true);
    opCreate = await pendingCreate(30, 33);
    await reservation(mavi, day(32), day(35), "ÇokGizliAd Soyad");
    const pending = await listOperations(adminDb, adminId, null);
    expect(pending.map((p) => p.id)).toContain(opCreate);
    const op = await getOperation(adminDb, adminId, opCreate);
    expect(op).toMatchObject({
      kind: "create",
      status: "pending",
      mode: "needs_approval",
      propertyName: "Villa Mavi 3c",
      workspaceName: "Opsiyon 3c",
      checkIn: day(30),
      checkOut: day(33),
      reasons: ["duration_missing"],
      groupId: G.id,
      calendarChanged: true, // kayıttan sonra rezervasyon eklendi
    });
    const range = await getOperationRange(adminDb, adminId, opCreate);
    expect(range).toEqual([
      expect.objectContaining({ kind: "reservation", status: "confirmed", checkIn: day(32) }),
    ]);
    expect(JSON.stringify(range)).not.toContain("ÇokGizliAd");
    expect(await errCode(getOperation(adminDb, adminId, uuidv7()))).toBe("not_found");
    expect((await getOptionCounts(adminDb, adminId)).pendingApproval).toBeGreaterThanOrEqual(1);
  });

  it("süre olmadan onay reddedilir (incomplete); eski sürüm version_conflict; süreyle onay → approved", async () => {
    const v = (await getOperation(adminDb, adminId, opCreate)).version;
    const base = {
      operationId: opCreate,
      approve: true,
      note: null,
      checkIn: null,
      checkOut: null,
      guestName: null,
      adults: null,
      children: null,
    };
    expect(
      await errCode(
        decideOperation(adminDb, adminId, { ...base, version: v, expiresMinutes: null }),
      ),
    ).toBe("incomplete");
    expect(
      await errCode(
        decideOperation(adminDb, adminId, { ...base, version: v + 7, expiresMinutes: 2880 }),
      ),
    ).toBe("version_conflict");
    expect(
      await decideOperation(adminDb, adminId, {
        ...base,
        version: v,
        expiresMinutes: 2880,
        note: "tamam",
      }),
    ).toBe("approved");
    expect(await opRow(opCreate)).toMatchObject({
      status: "approved",
      decided_by_admin: adminId,
      expires_in_minutes: 2880,
      expiry_source: "manual",
    });
    expect(
      await errCode(
        decideOperation(adminDb, adminId, { ...base, version: v + 1, expiresMinutes: 2880 }),
      ),
    ).toBe("not_pending");
  });

  it("global KAPALI: görev onaylı işlemi almaz (opsiyon yok, işlem 'approved' kalır)", async () => {
    await setOptionGlobal(adminDb, adminId, false);
    const r = await runTask();
    expect(r).toMatchObject({ locked: true, failedSteps: [] });
    expect(await opRow(opCreate)).toMatchObject({ status: "approved", lock_token: null });
    expect(
      (
        await admin.query(
          "select count(*)::int n from reservation_options where workspace_id = $1",
          [ws],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("işletme anahtarı kapalıyken de alınmaz", async () => {
    await setOptionGlobal(adminDb, adminId, true);
    await setOptionWorkspace(adminDb, adminId, {
      workspaceId: ws,
      enabled: false,
      defaultMinutes: null,
      choices: [1440, 2880],
    });
    await runTask();
    expect((await opRow(opCreate)).status).toBe("approved");
    await setOptionWorkspace(adminDb, adminId, {
      workspaceId: ws,
      enabled: true,
      defaultMinutes: null,
      choices: [1440, 2880],
    });
    // İşletme anahtarı yeniden açıldı ama grup ayarı işletmeden ÖNCE güncellenmişti: grup hâlâ açık.
  });

  it("anahtarlar açık: onaydan sonra takvim değişmediyse uygulanır; geçmişte Super Admin aktörü; işletme denetimi; ikinci çalıştırma tekrar uygulamaz", async () => {
    // Onay anındaki takvim (rezervasyon dahil) değişmedi → uygulanır.
    const view = await outside(mavi, day(25), day(40));
    const r = await runTask();
    expect(r).toMatchObject({ locked: true, failedSteps: [] });
    const x = await opRow(opCreate);
    expect(x).toMatchObject({ status: "applied", lock_token: null });
    const o = await optRow(x.result_option_id);
    expect(o).toMatchObject({ status: "open", source: "whatsapp", expiry_source: "manual" });
    expect(
      (
        await admin.query(
          "select event, actor_admin_id from reservation_option_events where option_id = $1",
          [o.id],
        )
      ).rows,
    ).toEqual([{ event: "created", actor_admin_id: adminId }]);
    expect(
      (
        await admin.query(
          "select count(*)::int n from audit_log where target_id = $1 and action = 'option.operation_applied'",
          [opCreate],
        )
      ).rows[0].n,
    ).toBe(1);
    // Opsiyon müsaitliği kapatmaz: bütün dış görünümler birebir aynı.
    expect(await outside(mavi, day(25), day(40))).toEqual(view);
    await runTask();
    expect(await opRow(opCreate)).toMatchObject({ status: "applied", version: x.version });
    expect(
      (
        await admin.query(
          "select count(*)::int n from reservation_options where workspace_id = $1",
          [ws],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("onaydan sonra takvim değişirse uygulanmaz (stale, calendar_changed); opsiyon oluşmaz", async () => {
    const id = await pendingCreate(60, 62);
    const v = (await getOperation(adminDb, adminId, id)).version;
    expect(
      await decideOperation(adminDb, adminId, {
        operationId: id,
        version: v,
        approve: true,
        note: null,
        checkIn: null,
        checkOut: null,
        expiresMinutes: 1440,
        guestName: null,
        adults: null,
        children: null,
      }),
    ).toBe("approved");
    await reservation(mavi, day(61), day(63));
    await runTask();
    expect(await opRow(id)).toMatchObject({
      status: "stale",
      failure_code: "calendar_changed",
      result_option_id: null,
    });
  });

  it("onaydan sonra grubun villası değişirse uygulanmaz (stale, group_changed)", async () => {
    const g2 = await group(mavi);
    await setOptionGroup(adminDb, adminId, g2.id, true);
    const id = await pendingCreate(70, 72, g2.jid);
    const v = (await getOperation(adminDb, adminId, id)).version;
    await decideOperation(adminDb, adminId, {
      operationId: id,
      version: v,
      approve: true,
      note: null,
      checkIn: null,
      checkOut: null,
      expiresMinutes: 1440,
      guestName: null,
      adults: null,
      children: null,
    });
    await setAdminGroupProperty(adminDb, adminId, g2.id, asya);
    await runTask();
    expect(await opRow(id)).toMatchObject({
      status: "stale",
      failure_code: "group_changed",
      result_option_id: null,
    });
  });

  it("kill switch yarışı: anahtar değişikliği uygulamayla sıralanır; kapanırsa işlem uygulanmaz, 'approved' kalır", async () => {
    const id = await pendingCreate(80, 82);
    const v = (await getOperation(adminDb, adminId, id)).version;
    await decideOperation(adminDb, adminId, {
      operationId: id,
      version: v,
      approve: true,
      note: null,
      checkIn: null,
      checkOut: null,
      expiresMinutes: 1440,
      guestName: null,
      adults: null,
      children: null,
    });
    const claimed = (
      await appPool.query("select * from public.app_option_claim_approved_operations(20)")
    ).rows;
    const mine = claimed.find((c) => c.id === id)!;
    expect(mine).toBeTruthy();
    // Super Admin kill switch'i kapatıyor (transaction henüz bitmedi).
    const sw = new Client({ connectionString: db.adminUrl });
    await sw.connect();
    try {
      await sw.query("begin");
      await sw.query("set local role app_admin");
      await sw.query("select public.app_option_admin_set_global($1, false)", [adminId]);
      let done = false;
      const applying = appPool
        .query("select public.app_option_apply_approved_operation($1, $2) out", [
          mine.id,
          mine.lock_token,
        ])
        .then((r) => {
          done = true;
          return r.rows[0].out as string;
        });
      await new Promise((r) => setTimeout(r, 300));
      expect(done).toBe(false); // anahtar satırı kilitli: uygulama bekliyor
      await sw.query("commit");
      expect(await applying).toBe("automation_off");
    } finally {
      await sw.end();
    }
    expect(await opRow(id)).toMatchObject({ status: "approved", lock_token: null });
    for (const c of claimed.filter((y) => y.id !== id)) {
      await appPool.query("select public.app_option_finish_operation($1, $2, 'release', null)", [
        c.id,
        c.lock_token,
      ]);
    }
    // Yeniden açılınca uygulanır (takvim değişmedi).
    await setOptionGlobal(adminDb, adminId, true);
    await runTask();
    expect((await opRow(id)).status).toBe("applied");
  });

  it("aynı kilit belirteciyle ikinci uygulama 'lost'; işlem yalnız bir kez uygulanır", async () => {
    const id = await pendingCreate(90, 92);
    const v = (await getOperation(adminDb, adminId, id)).version;
    await decideOperation(adminDb, adminId, {
      operationId: id,
      version: v,
      approve: true,
      note: null,
      checkIn: null,
      checkOut: null,
      expiresMinutes: 1440,
      guestName: null,
      adults: null,
      children: null,
    });
    const c = (
      await appPool.query("select * from public.app_option_claim_approved_operations(20)")
    ).rows.find((y) => y.id === id)!;
    const call = () =>
      appPool
        .query("select public.app_option_apply_approved_operation($1, $2) out", [
          c.id,
          c.lock_token,
        ])
        .then((r) => r.rows[0].out as string);
    const outs = await Promise.all([call(), call()]);
    expect(outs.sort()).toEqual(["applied", "lost"]);
    expect(
      (
        await admin.query(
          "select count(*)::int n from audit_log where target_id = $1 and action = 'option.operation_applied'",
          [id],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("ret: işlem 'rejected', opsiyon oluşmaz, denetime yazılır", async () => {
    const id = await pendingCreate(100, 102);
    const v = (await getOperation(adminDb, adminId, id)).version;
    expect(
      await decideOperation(adminDb, adminId, {
        operationId: id,
        version: v,
        approve: false,
        note: "uygun değil",
        checkIn: null,
        checkOut: null,
        expiresMinutes: null,
        guestName: null,
        adults: null,
        children: null,
      }),
    ).toBe("rejected");
    await runTask();
    expect(await opRow(id)).toMatchObject({ status: "rejected", result_option_id: null });
    expect(
      (
        await admin.query(
          "select count(*)::int n from admin_audit_log where target_id = $1 and action = 'option.operation_rejected'",
          [id],
        )
      ).rows[0].n,
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe("kesinleştirme 3e'ye kadar kapalı; onaylı iptal uygulanır", () => {
  let target: string;
  let convertOp: string;

  beforeAll(async () => {
    const m = await send("opsiyon 3c iptal hedefi");
    await claim();
    const r = await applyMsg(m.id, [
      item({ intent: "create", check_in: day(120), check_out: day(123), expires_in_minutes: 1440 }),
    ]);
    target = r[0].option_id;
    const c = await send("opsiyon 3c kesinleştir");
    await claim();
    convertOp = (
      await applyMsg(c.id, [item({ intent: "convert", check_in: day(120), check_out: day(123) })])
    )[0].operation_id;
  });

  it("kesinleştirme onayı modülde reddedilir (convert_disabled); ret serbest", async () => {
    const v = (await getOperation(adminDb, adminId, convertOp)).version;
    const base = {
      operationId: convertOp,
      version: v,
      note: null,
      checkIn: null,
      checkOut: null,
      expiresMinutes: null,
      guestName: "Test Misafir",
      adults: 2,
      children: 0,
    };
    expect(await errCode(decideOperation(adminDb, adminId, { ...base, approve: true }))).toBe(
      "convert_disabled",
    );
    expect((await opRow(convertOp)).status).toBe("pending");
  });

  it("veritabanında onaylanmış kesinleştirme bile görevce ALINMAZ (opsiyon açık kalır)", async () => {
    const v = (await opRow(convertOp)).version;
    const c = await adminRolePool.connect();
    try {
      await c.query(
        "select public.app_option_admin_decide($1, $2, $3, true, null, null, null, null, 'Test Misafir', 2, 0)",
        [adminId, convertOp, v],
      );
    } finally {
      c.release();
    }
    expect((await opRow(convertOp)).status).toBe("approved");
    const r = await runTask();
    expect(r).toMatchObject({ failedSteps: [] });
    expect(await opRow(convertOp)).toMatchObject({ status: "approved", attempts: 0 });
    expect((await optRow(target)).status).toBe("open");
  });

  it("onaylı iptal uygulanır (hedef sürüm kilidiyle); yalnız hedef değişir", async () => {
    const c2 = await send("opsiyon 3c iptal");
    await claim();
    // İki açık opsiyonun olduğu grupta tarihsiz iptal → onaya düşer, hedef Super Admin'de değil:
    // tarihli iptal ama 'ask' kararı → onaya.
    const r = await applyMsg(c2.id, [
      item({
        intent: "cancel",
        decision: "ask",
        reasons: ["hedged"],
        check_in: day(120),
        check_out: day(123),
        end_reason: "customer_declined",
      }),
    ]);
    const id = r[0].operation_id as string;
    expect(await opRow(id)).toMatchObject({
      kind: "cancel",
      status: "pending",
      target_option_id: target,
    });
    const others = (
      await admin.query(
        "select id, status, version from reservation_options where workspace_id = $1 and id <> $2 order by id",
        [ws, target],
      )
    ).rows;
    const v = (await getOperation(adminDb, adminId, id)).version;
    expect(
      await decideOperation(adminDb, adminId, {
        operationId: id,
        version: v,
        approve: true,
        note: null,
        checkIn: null,
        checkOut: null,
        expiresMinutes: null,
        guestName: null,
        adults: null,
        children: null,
      }),
    ).toBe("approved");
    await runTask();
    expect(await opRow(id)).toMatchObject({ status: "applied", result_option_id: target });
    expect(await optRow(target)).toMatchObject({
      status: "cancelled",
      end_reason: "customer_declined",
    });
    expect(
      (
        await admin.query(
          "select id, status, version from reservation_options where workspace_id = $1 and id <> $2 order by id",
          [ws, target],
        )
      ).rows,
    ).toEqual(others);
  });
});

// ---------------------------------------------------------------------------------------------
describe("listeler, detay, uyarılar ve panelden iptal", () => {
  let o1: string;

  it("durum listeleri; detay, geçmiş ve bağlı işlemler", async () => {
    const open = await listOptions(adminDb, adminId, "open");
    const mine = open.filter((o) => o.workspaceId === ws);
    expect(mine.length).toBeGreaterThanOrEqual(2);
    for (const o of mine) {
      expect(o.status).toBe("open");
      expect(o.remainingSeconds).toBeGreaterThan(0);
    }
    o1 = mine.find((o) => o.checkIn === day(30))!.id;
    const d = await getOption(adminDb, adminId, o1);
    expect(d).toMatchObject({
      status: "open",
      propertyName: "Villa Mavi 3c",
      groupId: G.id,
      byMessage: true,
      checkIn: day(30),
      checkOut: day(33),
    });
    expect((await listOptionEvents(adminDb, adminId, o1)).map((e) => [e.event, e.byAdmin])).toEqual(
      [["created", true]],
    );
    expect(
      (await listOptionOperations(adminDb, adminId, o1)).map((x) => [x.role, x.kind, x.status]),
    ).toEqual([["result", "create", "applied"]]);
    expect(
      (await listOptions(adminDb, adminId, "cancelled")).some((o) => o.workspaceId === ws),
    ).toBe(true);
    expect(await errCode(listOptions(adminDb, adminId, "x" as never))).toBe("invalid");
    expect(await errCode(getOption(adminDb, adminId, uuidv7()))).toBe("not_found");
  });

  it("çakışma uyarısı adlarıyla listelenir; görüldü yapma idempotent, denetime yazılır; opsiyon ve kayıt değişmez", async () => {
    await runTask(); // day(32) rezervasyonu ile o1 çakışıyor → uyarı
    const alerts = await listAlerts(adminDb, adminId, { optionId: o1 });
    expect(alerts).toHaveLength(1);
    const a = alerts[0]!;
    expect(a).toMatchObject({
      workspaceName: "Opsiyon 3c",
      propertyName: "Villa Mavi 3c",
      sourceKind: "reservation",
      sourceStatus: "confirmed",
      sourceCheckIn: day(32),
      sourceLabel: "reservation",
      acknowledgedAt: null,
    });
    expect(JSON.stringify(alerts)).not.toContain("ÇokGizliAd");
    const optBefore = await optRow(o1);
    const view = await outside(mavi, day(25), day(40));
    expect(await acknowledgeAlert(adminDb, adminId, a.id)).toBe("acknowledged");
    expect(await acknowledgeAlert(adminDb, adminId, a.id)).toBe("already");
    expect(await listAlerts(adminDb, adminId, { optionId: o1 })).toEqual([]);
    const all = await listAlerts(adminDb, adminId, { optionId: o1, includeAcknowledged: true });
    expect(all[0]).toMatchObject({ id: a.id, acknowledgedByName: "Admin opsiyon3c" });
    expect(
      (
        await admin.query(
          "select count(*)::int n from admin_audit_log where target_id = $1 and action = 'option.alert_acknowledged'",
          [a.id],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(await optRow(o1)).toEqual(optBefore);
    expect(await outside(mavi, day(25), day(40))).toEqual(view);
    expect(await errCode(acknowledgeAlert(adminDb, adminId, uuidv7()))).toBe("not_found");
    await runTask(); // görüldü uyarı yeniden açılmaz
    expect(await listAlerts(adminDb, adminId, { optionId: o1 })).toEqual([]);
  });

  it("panelden iptal: sürüm kilidi; panel_cancel; Super Admin aktörü; ikinci iptal not_open; dış görünüm aynı", async () => {
    const before = await getOption(adminDb, adminId, o1);
    const view = await outside(mavi, day(25), day(40));
    expect(await errCode(cancelOption(adminDb, adminId, o1, before.version + 3, null))).toBe(
      "version_conflict",
    );
    expect(await cancelOption(adminDb, adminId, o1, before.version, "panel testi")).toBe(
      "cancelled",
    );
    expect(await optRow(o1)).toMatchObject({ status: "cancelled", end_reason: "panel_cancel" });
    const ev = await listOptionEvents(adminDb, adminId, o1);
    expect(ev.at(-1)).toMatchObject({ event: "cancelled", reason: "panel_cancel", byAdmin: true });
    expect(await errCode(cancelOption(adminDb, adminId, o1, before.version + 1, null))).toBe(
      "not_open",
    );
    expect(await outside(mavi, day(25), day(40))).toEqual(view);
  });

  it("sayaçlar ve son durum: kill switch kapatılır, görev hiçbir onaylı işlemi almaz", async () => {
    const c = await getOptionCounts(adminDb, adminId);
    expect(c.openOptions).toBeGreaterThanOrEqual(1);
    expect(await setOptionGlobal(adminDb, adminId, false)).toBe("changed");
    const r = await runTask();
    expect(r).toMatchObject({
      locked: true,
      operations: { claimed: 0 },
      failedSteps: [],
    });
  });
});
