import { createHash, randomBytes } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { DB_CASING } from "@/db/casing";
import * as schema from "@/db/schema";
import { createStandaloneDb } from "@/db/standalone";
import { type TenantContext, type Tx, withTenant } from "@/db/tenant";
import { createLogger } from "@/lib/logger";
import { istanbulToday } from "@/lib/reservation-meta";
import { parseCalendarMessage } from "@/lib/wa-calendar-parse";
import { decideOperation, getOperation } from "@/server/admin/options";
import { setAdminGroupProperty } from "@/server/admin/whatsapp";
import { createOptionConverter, OPTION_CONVERT_NOTE } from "@/server/options/convert";
import { createOptionMessageHandler } from "@/server/options/message-handler";
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
import { addWorkspaceMember, createWorkspace } from "@/server/workspaces/service";

import { createTestAdmin } from "./wa-admin";

/**
 * Opsiyon Aşama 3e — Super Admin onaylı kesinleştirme: opsiyon → kesin rezervasyon
 * (src/server/options/convert.ts, drizzle/0073). Gerçek PostgreSQL: mesajlar ağ geçidi fonksiyonuyla
 * kaydedilir ve ÜRETİMDEKİ worker'la işlenir; görev üretimdeki gibi (tek bağlantı, mesaj işleyicisi
 * ve dönüştürücü) çalışır; onay GERÇEK app_admin rolüyle panel modülünden verilir.
 *
 * Kanıtlananlar: ödeme mesajı yalnız onaya düşer; onay ve uygulamaya kadar müsaitlik / iCal / API
 * değişmez; onaylı dönüşüm işletme sahibi adına tek transaction'da kesin rezervasyon oluşturur
 * (kaynak whatsapp, misafir bilgisi onaydaki gibi, reservation.created denetimi), opsiyon converted
 * (payment_received, geçmişte Super Admin aktörü), işlem applied; API / iCal / müsaitlik yalnız
 * kesin rezervasyonu görür (panelden girilen kayıtla aynı etki); eşzamanlı iki uygulama ve tekrar
 * çalıştırma tek rezervasyon; misafir bilgisi eksikse onay yok; onaydan sonra takvim değişirse,
 * uygulama anında çakışma varsa, kapasite aşılırsa, opsiyonun süresi dolarsa rezervasyon YOK;
 * kill switch ve işletme anahtarı kapalıyken dönüşüm bekler.
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 4 });
const app = drizzle(appPool, { schema, casing: DB_CASING });
const adminRolePool = new Pool({ connectionString: db.adminUrl, max: 2 });
adminRolePool.on("connect", (c) => void c.query("set role app_admin"));
const adminDb = drizzle(adminRolePool, { schema, casing: DB_CASING });
const admin = new Client({ connectionString: db.adminUrl });
const tag = randomBytes(3).toString("hex");
const quiet = createLogger({ service: "option-convert-test" }, () => {});
const deps: WorkerDeps = {
  log: quiet,
  autoClose: createAutoCloser(app),
  autoOpen: createAutoOpener(app),
  autoChange: createAutoChanger(app),
};

/** Üretimdeki giriş noktasıyla aynı: tek bağlantı + gerçek mesaj işleyicisi. */
async function runTask() {
  const s = createStandaloneDb(db.appUrl, {
    max: 1,
    idleTimeoutMillis: 0,
    statement_timeout: 30_000,
    application_name: "kiraligim-option-convert-test",
  });
  try {
    return await runOptionMaintenance(s.db, {
      log: quiet,
      handleMessage: createOptionMessageHandler({ log: quiet }),
      convert: createOptionConverter(s.db, { log: quiet }),
    });
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
const num = (n: number) => `90532${n}${String(parseInt(tag, 16) % 100_000).padStart(5, "0")}`;
const PN_OWNER = num(81);
const PN_MANAGER = num(82);
const PN_STAFF = num(83);
const TODAY = istanbulToday();

let O: U, M: U, S: U;
let ws: string;
let mavi: string, asya: string;
let conn: string;
let G: { id: string; jid: string };
let adminId: string;
const planCode = `opt3e_${tag}`;
const icalToken = `o3e${tag}`.padEnd(43, "x");

let jidN = 0;
const jidBase = BigInt(`0x${randomBytes(4).toString("hex")}`) % 10_000_000n;
const newJid = () =>
  `120364${String(jidBase).padStart(7, "0")}${String(++jidN).padStart(5, "0")}@g.us`;

async function group(property: string) {
  const jid = newJid();
  await appPool.query("select public.app_wa_sync_group($1, $2, 'Ekip 3e', 4, false, false, true)", [
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
const setWorkspace = (on: boolean, def: number | null = null) =>
  adminOne("select public.app_option_admin_set_workspace($1, $2, $3, $4, $5) as out", [
    adminId,
    ws,
    on,
    def,
    [],
  ]);
const setGroup = (g: string, on: boolean) =>
  adminOne("select public.app_option_admin_set_group($1, $2, $3) as out", [adminId, g, on]);

let msgN = 0;
/** Mesajı ağ geçidi fonksiyonuyla kaydeder ve üretimdeki worker'la işler. */
async function send(
  body: string,
  opts: { pn?: string; jid?: string; sentAt?: Date } = {},
): Promise<{ id: string; status: string }> {
  const mid = `E${tag}${++msgN}`;
  await appPool.query(
    "select public.app_wa_ingest_message($1, $2, $3, '1@lid', $4, null, $5, $6, 'live')",
    [conn, opts.jid ?? G.jid, mid, opts.pn ?? PN_OWNER, body, opts.sentAt ?? new Date()],
  );
  await runCalendarWorker(app, deps);
  return (
    await admin.query<{ id: string; status: string }>(
      "select id, status from wa_inbound_messages where wa_message_id = $1",
      [mid],
    )
  ).rows[0]!;
}

const opsOf = async (message: string) =>
  (
    await admin.query(
      `select kind, mode, status, reasons, end_reason, expiry_source, expires_in_minutes,
              check_in::text, check_out::text, result_option_id, target_option_id
         from option_operations where message_id = $1 order by item_no`,
      [message],
    )
  ).rows;
/** Mesajın tarih aralığı (üretimdeki ayrıştırıcının sonucu). */
const rangeOf = (body: string) => {
  const it = parseCalendarMessage(body, TODAY).items.find((i) => i.checkIn && i.checkOut)!;
  return [it.checkIn!, it.checkOut!] as const;
};

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
  };
}

beforeAll(async () => {
  await admin.connect();
  O = await mkUser("o3e");
  M = await mkUser("o3em");
  S = await mkUser("o3es");
  ws = (await createWorkspace(app, { userId: O.id, name: "Opsiyon 3e", slug: `o3e-${tag}` })).id;
  const planId = uuidv7();
  await admin.query(
    "insert into plans (id, code, name, max_properties, trial_days, is_active, is_default) values ($1, $2, 'O3E', 20, 14, true, false)",
    [planId, planCode],
  );
  await admin.query("update workspace_subscriptions set plan_id = $1 where workspace_id = $2", [
    planId,
    ws,
  ]);
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: M.id, role: "manager" }));
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: S.id, role: "staff" }));
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
      `o3e-${tag}`,
    ])
  ).rows[0]!.id;
  for (const [u, pn] of [
    [O, PN_OWNER],
    [M, PN_MANAGER],
    [S, PN_STAFF],
  ] as const) {
    await admin.query(
      "insert into wa_verified_phones (user_id, phone_hash, phone_masked) values ($1, $2, '+90 532 *** ** 04')",
      [u.id, phoneHash(pn)],
    );
  }
  await admin.query(
    "insert into property_ical_exports (property_id, workspace_id, token, created_by) values ($1, $2, $3, $4)",
    [mavi, ws, icalToken, O.id],
  );
  G = await group(mavi);
  adminId = await createTestAdmin(admin, "opsiyon3e");
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
/** Açık opsiyon + onaya düşmüş kesinleştirme işlemi (gerçek mesaj, worker ve görev). */
async function optionWithConvert(range: string, hours = 48) {
  const m1 = await send(`${range} opsiyon ${hours} saat`);
  await runTask();
  const [created] = await opsOf(m1.id);
  expect(created).toMatchObject({ kind: "create", status: "applied" });
  const m2 = await send(`${range} opsiyon ödeme alındı`);
  const seen = await existingView(m2.id);
  await runTask();
  const ops = (
    await admin.query(
      "select id, kind, status, mode, target_option_id from option_operations where message_id = $1",
      [m2.id],
    )
  ).rows;
  expect(ops).toEqual([
    expect.objectContaining({ kind: "convert", status: "pending", mode: "needs_approval" }),
  ]);
  expect(ops[0].target_option_id).toBe(created.result_option_id);
  // Worker'ın mesaj için ürettiği her şey (öneri, ⚠️) görevden etkilenmez.
  expect(await existingView(m2.id)).toEqual(seen);
  return { option: created.result_option_id as string, op: ops[0].id as string, message: m2.id };
}

const approve = async (
  opId: string,
  guest: { guestName?: string | null; adults?: number | null; children?: number | null } = {},
) => {
  const v = (await getOperation(adminDb, adminId, opId)).version;
  return decideOperation(adminDb, adminId, {
    operationId: opId,
    version: v,
    approve: true,
    note: null,
    checkIn: null,
    checkOut: null,
    expiresMinutes: null,
    guestName: "guestName" in guest ? (guest.guestName ?? null) : "Ayşe Test",
    adults: "adults" in guest ? (guest.adults ?? null) : 2,
    children: "children" in guest ? (guest.children ?? null) : 1,
  });
};

const opRow = async (id: string) =>
  (await admin.query("select * from option_operations where id = $1", [id])).rows[0];
const resCount = async () =>
  Number(
    (await admin.query("select count(*)::int n from reservations where workspace_id = $1", [ws]))
      .rows[0].n,
  );

beforeAll(async () => {
  // Tek ortak sistem (0074): yalnız global anahtar; işletme ve grup ayarı gerekmez.
  expect(await setGlobal(true)).toBe("changed");
});

// ---------------------------------------------------------------------------------------------
describe("başarılı dönüşüm", () => {
  it("ödeme mesajı → onay → görev: kesin rezervasyon, opsiyon converted, işlem applied; onaya / uygulamaya kadar dış görünüm aynı", async () => {
    const range = "3-6 Şubat";
    const [ci, co] = rangeOf(range + " kapat");
    const { option, op } = await optionWithConvert(range);
    const view = await outside(mavi, ci, co);
    expect((view.panelConflicts as unknown[]).length).toBe(0); // opsiyon müsaitliği kapatmaz

    // Misafir bilgisi tam değilse onay yok (çocuk boş → 0 sayılmaz).
    expect(await approve(op, { children: null }).catch((e) => e.reason)).toBe(
      "guest_info_required",
    );
    expect(await outside(mavi, ci, co)).toEqual(view);

    // Onay: yalnız "approved"; görev çalışana kadar takvim aynı.
    expect(await approve(op)).toBe("approved");
    expect(await outside(mavi, ci, co)).toEqual(view);

    const before = await resCount();
    const r = await runTask();
    expect(r).toMatchObject({ failedSteps: [], conversions: { applied: 1 } });
    expect(await resCount()).toBe(before + 1);

    const x = await opRow(op);
    expect(x).toMatchObject({ status: "applied", result_option_id: option, lock_token: null });
    const res = (
      await admin.query("select * from reservations where id = $1", [x.result_reservation_id])
    ).rows[0];
    expect(res).toMatchObject({
      workspace_id: ws,
      property_id: mavi,
      kind: "reservation",
      status: "confirmed",
      source: "whatsapp",
      guest_name: "Ayşe Test",
      adults: 2,
      children: 1,
      note: OPTION_CONVERT_NOTE,
      created_by: O.id, // işletme sahibi adına
    });
    expect(
      (
        await admin.query(
          "select check_in::text ci, check_out::text co from reservations where id = $1",
          [res.id],
        )
      ).rows[0],
    ).toEqual({ ci, co });
    const o = (await admin.query("select * from reservation_options where id = $1", [option]))
      .rows[0];
    expect(o).toMatchObject({
      status: "converted",
      end_reason: "payment_received",
      converted_reservation_id: res.id,
      guest_name: "Ayşe Test",
      adults: 2,
      children: 1,
    });
    const ev = (
      await admin.query(
        "select event, actor_admin_id from reservation_option_events where option_id = $1 order by version",
        [option],
      )
    ).rows;
    expect(ev).toEqual([
      { event: "created", actor_admin_id: null },
      { event: "converted", actor_admin_id: adminId },
    ]);
    // Denetim: reservation.created (sahip), işletme ve Super Admin opsiyon kayıtları.
    expect(
      (
        await admin.query(
          "select actor_user_id from audit_log where target_id = $1 and action = 'reservation.created'",
          [res.id],
        )
      ).rows,
    ).toEqual([{ actor_user_id: O.id }]);
    expect(
      (
        await admin.query(
          "select count(*)::int n from audit_log where target_id = $1 and action = 'option.operation_applied'",
          [op],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await admin.query(
          "select count(*)::int n from admin_audit_log where admin_id = $1 and action = 'option.converted' and target_id = $2",
          [adminId, option],
        )
      ).rows[0].n,
    ).toBe(1);

    // Dış görünüm: yalnız kesin rezervasyon (müsaitlik, villa sayfası, API, iCal kapalı tarih).
    const after = await outside(mavi, ci, co);
    expect((after.panelConflicts as unknown[]).length).toBe(1); // panel çakışma denetimi
    expect(after.panelCalendar).not.toEqual(view.panelCalendar);
    expect(after.apiBusy).not.toEqual(view.apiBusy);
    const icalDays = (after.ical as { check_in: Date | string }[]).map((e) =>
      new Date(e.check_in).toISOString().slice(0, 10),
    );
    expect(icalDays).toContain(ci);

    // Tekrar çalıştırma ikinci rezervasyon oluşturmaz.
    await runTask();
    await runTask();
    expect(await resCount()).toBe(before + 1);
  });

  it("API / iCal etkisi panelden girilen aynı rezervasyonla aynı (değişiklik kaydı sayısı)", async () => {
    const range = "10-13 Şubat";
    const [ci, co] = rangeOf(range + " kapat");
    const { op } = await optionWithConvert(range);
    await approve(op);
    const d0 = await outside(mavi, ci, co);
    await runTask();
    const d1 = await outside(mavi, ci, co);
    // Aynı uzunlukta bir kaydı panelden (createReservation, sahip) Villa Asya'ya gir.
    const a0 = await outside(asya, ci, co);
    await as(O, ws, (tx, ctx) =>
      createReservation(tx, ctx, {
        kind: "reservation",
        propertyId: asya,
        checkIn: ci,
        checkOut: co,
        status: "confirmed",
        source: "phone",
        guestName: "Panel Misafir",
        adults: "2",
        children: "1",
      }),
    );
    const a1 = await outside(asya, ci, co);
    const delta = (x: { n: number }[], y: { n: number }[]) => y[0]!.n - x[0]!.n;
    expect(delta(d0.apiDirty as never, d1.apiDirty as never)).toBe(
      delta(a0.apiDirty as never, a1.apiDirty as never),
    );
    expect(delta(d0.apiChanges as never, d1.apiChanges as never)).toBe(
      delta(a0.apiChanges as never, a1.apiChanges as never),
    );
    expect((d1.panelConflicts as unknown[]).length).toBe((a1.panelConflicts as unknown[]).length);
    expect((d1.panelConflicts as unknown[]).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe("tekrar ve eşzamanlılık", () => {
  it("aynı işleme eşzamanlı iki uygulama: yalnız bir rezervasyon", async () => {
    const { op } = await optionWithConvert("17-20 Şubat");
    await approve(op);
    const claimed = (
      await appPool.query("select * from public.app_option_claim_approved_conversions(10)")
    ).rows;
    const mine = claimed.find((c) => c.id === op)!;
    expect(mine).toBeTruthy();
    const before = await resCount();
    const s1 = createStandaloneDb(db.appUrl, { max: 1 });
    const s2 = createStandaloneDb(db.appUrl, { max: 1 });
    try {
      const outs = await Promise.all(
        [s1, s2].map((s) =>
          createOptionConverter(s.db)({
            id: mine.id,
            lockToken: mine.lock_token,
            workspaceId: mine.workspace_id,
          }),
        ),
      );
      expect(outs.sort()).toEqual(["applied", "lost"]);
    } finally {
      await s1.end();
      await s2.end();
    }
    expect(await resCount()).toBe(before + 1);
    expect((await opRow(op)).status).toBe("applied");
    for (const c of claimed.filter((y) => y.id !== op)) {
      await appPool.query("select public.app_option_finish_operation($1, $2, 'release', null)", [
        c.id,
        c.lock_token,
      ]);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe("başarısız dönüşümler: rezervasyon oluşmaz", () => {
  it("onaydan sonra takvim değişirse → stale (calendar_changed); opsiyon açık", async () => {
    const range = "24-27 Şubat";
    const [ci, co] = rangeOf(range + " kapat");
    const { option, op } = await optionWithConvert(range);
    await approve(op);
    await as(O, ws, (tx, ctx) =>
      createReservation(tx, ctx, { kind: "block", propertyId: mavi, checkIn: ci, checkOut: co }),
    );
    const before = await resCount();
    await runTask();
    expect(await opRow(op)).toMatchObject({ status: "stale", failure_code: "calendar_changed" });
    expect(await resCount()).toBe(before);
    expect(
      (await admin.query("select status from reservation_options where id = $1", [option])).rows[0]
        .status,
    ).toBe("open");
  });

  it("uygulama anında çakışma (parmak izinden sonra oluşan kayıt) → failed (calendar_conflict); hiçbir şey yazılmaz", async () => {
    const range = "3-6 Mart";
    const [ci, co] = rangeOf(range + " kapat");
    const { option, op } = await optionWithConvert(range);
    await approve(op);
    // Yarış benzetimi: blok eklendi ve işlemin parmak izi yeni takvime eşitlendi (görev çakışmayı
    // ancak rezervasyon servisinin kısıtıyla görür).
    await as(O, ws, (tx, ctx) =>
      createReservation(tx, ctx, { kind: "block", propertyId: mavi, checkIn: ci, checkOut: co }),
    );
    await admin.query(
      `update option_operations set fingerprint = public.app_option_fingerprint(workspace_id, property_id, check_in, check_out, target_option_id) where id = $1`,
      [op],
    );
    const before = await resCount();
    await runTask();
    expect(await opRow(op)).toMatchObject({ status: "failed", failure_code: "calendar_conflict" });
    expect(await resCount()).toBe(before);
    expect(
      (await admin.query("select status from reservation_options where id = $1", [option])).rows[0]
        .status,
    ).toBe("open");
  });

  it("kapasite aşımı → failed (capacity)", async () => {
    const { op } = await optionWithConvert("10-13 Mart");
    await approve(op, { adults: 5, children: 3 }); // villa kapasitesi 6
    const before = await resCount();
    await runTask();
    expect(await opRow(op)).toMatchObject({ status: "failed", failure_code: "capacity" });
    expect(await resCount()).toBe(before);
  });

  it("onaydan sonra opsiyonun süresi dolarsa → stale; süre uzatılmaz; rezervasyon yok", async () => {
    const { option, op } = await optionWithConvert("17-20 Mart");
    await approve(op);
    // Süre dolumunu benzet: yalnız expires_at geçmişe çekilir (tetikleyicisiz test müdahalesi).
    await admin.query("set session_replication_role = replica");
    await admin.query(
      "update reservation_options set expires_at = now() - interval '1 minute' where id = $1",
      [option],
    );
    await admin.query("set session_replication_role = origin");
    const before = await resCount();
    await runTask();
    expect((await opRow(op)).status).toBe("stale");
    expect(await resCount()).toBe(before);
    const o = (
      await admin.query("select status, expires_at from reservation_options where id = $1", [
        option,
      ])
    ).rows[0];
    expect(o.status).toBe("expired");
    expect(new Date(o.expires_at).getTime()).toBeLessThan(Date.now());
  });

  it("misafir bilgisi veritabanında da zorunlu: panel dışı onayda çocuk sayısı yoksa → failed (guest_info_missing)", async () => {
    const { op } = await optionWithConvert("1-4 Nisan");
    const v = (await opRow(op)).version;
    const c = await adminRolePool.connect();
    try {
      // 0069 onay fonksiyonu çocuk sayısını zorunlu tutmaz; dönüşüm yine de yapılmaz.
      await c.query(
        "select public.app_option_admin_decide($1, $2, $3, true, null, null, null, null, 'Ayşe Test', 2, null)",
        [adminId, op, v],
      );
    } finally {
      c.release();
    }
    const before = await resCount();
    await runTask();
    expect(await opRow(op)).toMatchObject({ status: "failed", failure_code: "guest_info_missing" });
    expect(await resCount()).toBe(before);
  });

  it("onaydan sonra grubun villası değişirse → stale (group_changed)", async () => {
    const g3 = await group(mavi);
    expect(await setGroup(g3.id, true)).toBe("changed");
    const m1 = await send("8-11 Nisan opsiyon 48 saat", { jid: g3.jid });
    await runTask();
    const m2 = await send("8-11 Nisan opsiyon ödeme alındı", { jid: g3.jid });
    await runTask();
    const op = (
      await admin.query("select id from option_operations where message_id = $1", [m2.id])
    ).rows[0].id as string;
    expect((await opsOf(m1.id))[0].status).toBe("applied");
    await approve(op);
    await setAdminGroupProperty(adminDb, adminId, g3.id, asya);
    const before = await resCount();
    await runTask();
    expect(await opRow(op)).toMatchObject({ status: "stale", failure_code: "group_changed" });
    expect(await resCount()).toBe(before);
  });

  it("giriş tarihi geçmişse → failed (date_past)", async () => {
    const { option, op } = await optionWithConvert("15-18 Nisan");
    await approve(op);
    // Tarihleri geçmişe taşı (tetikleyicisiz test müdahalesi; parmak izi yeni tarihlere eşitlenir).
    await admin.query("set session_replication_role = replica");
    await admin.query(
      "update reservation_options set check_in = current_date - 3, check_out = current_date - 1 where id = $1",
      [option],
    );
    await admin.query(
      `update option_operations set check_in = current_date - 3, check_out = current_date - 1,
              fingerprint = public.app_option_fingerprint(workspace_id, property_id, current_date - 3,
                                                          current_date - 1, target_option_id)
        where id = $1`,
      [op],
    );
    await admin.query("set session_replication_role = origin");
    const before = await resCount();
    await runTask();
    expect(await opRow(op)).toMatchObject({ status: "failed", failure_code: "date_past" });
    expect(await resCount()).toBe(before);
  });

  it("kill switch kapalıyken onaylı dönüşüm bekler; açılınca uygulanır (eski işletme anahtarı belirleyici değil)", async () => {
    const { op } = await optionWithConvert("24-27 Mart");
    await approve(op);
    expect(await setGlobal(false)).toBe("changed");
    const before = await resCount();
    await runTask();
    expect(await opRow(op)).toMatchObject({ status: "approved", attempts: 0 });
    expect(await resCount()).toBe(before);
    // Tek ortak sistem (0074): işletme anahtarı kapalı olsa da global açılınca uygulanır.
    expect(await setWorkspace(false)).toBe("changed");
    expect(await setGlobal(true)).toBe("changed");
    await runTask();
    expect((await opRow(op)).status).toBe("applied");
    expect(await resCount()).toBe(before + 1);
  });
});
