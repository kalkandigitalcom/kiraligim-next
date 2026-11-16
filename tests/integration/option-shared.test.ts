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
import {
  setAdminGroupActive,
  setAdminGroupProperty,
  unlinkAdminGroup,
} from "@/server/admin/whatsapp";
import { createOptionConverter } from "@/server/options/convert";
import { createOptionMessageHandler } from "@/server/options/message-handler";
import { runOptionMaintenance } from "@/server/options/run";
import { createProperty } from "@/server/properties/service";
import { findConflicts, listCalendarEntries } from "@/server/reservations/service";
import { createAutoChanger } from "@/server/whatsapp/auto-change";
import { createAutoCloser } from "@/server/whatsapp/auto-close";
import { createAutoOpener } from "@/server/whatsapp/auto-open";
import { runCalendarWorker, type WorkerDeps } from "@/server/whatsapp/calendar/worker";
import { addWorkspaceMember, createWorkspace } from "@/server/workspaces/service";

import { createTestAdmin } from "./wa-admin";

/**
 * Opsiyon — tek ve ortak opsiyon sistemi (drizzle/0074). Gerçek PostgreSQL: mesajlar ağ geçidi
 * fonksiyonuyla kaydedilir ve ÜRETİMDEKİ worker'la işlenir; görev üretimdeki giriş noktasıyla aynı
 * (tek bağlantı, mesaj işleyicisi, dönüştürücü); anahtar ve onaylar GERÇEK app_admin rolüyle.
 *
 * Kanıtlananlar:
 *   - Yalnız global anahtar açıkken bağlı, villası atanmış, işletmesi aktif HER grup işler; işletme
 *     ve grup başına açma yok (ayar satırı olmadan). Yeni işletme / yeni grup ek işlem gerektirmez.
 *   - İşletmeler birbirinden izole: aynı tarihler iki işletmede birbirini etkilemez; her grup yalnız
 *     kendi işletmesinin kendi villası için işlem yapar; başka işletmenin villa adı yazılsa da o
 *     işletmeye dokunulmaz. Varsayılan opsiyon süresi işletmeye özel.
 *   - Global kill switch her zaman önceliklidir: kapatınca hiçbir mesaj okunmaz, onaylı işlem /
 *     kesinleştirme uygulanmaz (bekler, silinmez); açılınca aradaki mesajlar geriye dönük işlenmez.
 *   - Grup pasifleştirilir / bağlantısı kaldırılırsa durur; villası değişirse eski villaya ait onaylı
 *     işlem uygulanmaz (group_changed).
 *   - Uçtan uca oluşturma, iptal, süre dolumu, onaylı kesinleştirme: dış görünüm (müsaitlik, API,
 *     iCal, webhook) yalnız kesin rezervasyonla değişir; mevcut "kapat" komutu aynen çalışır.
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 4 });
const app = drizzle(appPool, { schema, casing: DB_CASING });
const adminRolePool = new Pool({ connectionString: db.adminUrl, max: 2 });
adminRolePool.on("connect", (c) => void c.query("set role app_admin"));
const adminDb = drizzle(adminRolePool, { schema, casing: DB_CASING });
const admin = new Client({ connectionString: db.adminUrl });
const tag = randomBytes(3).toString("hex");
const quiet = createLogger({ service: "option-pilot-test" }, () => {});
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
    application_name: "kiraligim-option-pilot-test",
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
/** Testte sonradan oluşturulan işletmeler (temizlik için). */
const others: string[] = [];
const planCode = `opt3f_${tag}`;
const icalToken = `o3f${tag}`.padEnd(43, "x");

let jidN = 0;
const jidBase = BigInt(`0x${randomBytes(4).toString("hex")}`) % 10_000_000n;
const newJid = () =>
  `120364${String(jidBase).padStart(7, "0")}${String(++jidN).padStart(5, "0")}@g.us`;

async function group(property: string, workspace = ws) {
  const jid = newJid();
  await appPool.query("select public.app_wa_sync_group($1, $2, 'Ekip 3f', 4, false, false, true)", [
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
const setWorkspace = (on: boolean, def: number | null = null, workspace = ws) =>
  adminOne("select public.app_option_admin_set_workspace($1, $2, $3, $4, $5) as out", [
    adminId,
    workspace,
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
  const mid = `F${tag}${++msgN}`;
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
  O = await mkUser("o3f");
  M = await mkUser("o3fm");
  S = await mkUser("o3fs");
  ws = (await createWorkspace(app, { userId: O.id, name: "Opsiyon 3f", slug: `o3f-${tag}` })).id;
  const planId = uuidv7();
  await admin.query(
    "insert into plans (id, code, name, max_properties, trial_days, is_active, is_default) values ($1, $2, 'O3F', 20, 14, true, false)",
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
      `o3f-${tag}`,
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
  adminId = await createTestAdmin(admin, "opsiyon3f");
  await runCalendarWorker(app, deps); // ilk aktivasyon
});

afterAll(async () => {
  // Bütün anahtarlar KAPALI bırakılır (diğer test dosyaları için de).
  await admin.query("update option_automation_global set enabled = false where id = 1");
  await admin.query(
    "update workspace_option_settings set automation_enabled = false where workspace_id = $1",
    [ws],
  );
  await admin.query("delete from wa_inbound_messages where workspace_id = any($1)", [
    [ws, ...others],
  ]);
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

const scan = async (message: string) =>
  (await admin.query("select status from option_message_scans where message_id = $1", [message]))
    .rows[0] as { status: string } | undefined;
const optionsOf = async (property: string) =>
  (
    await admin.query(
      "select id, status, end_reason, check_in::text, check_out::text from reservation_options where property_id = $1 order by created_at",
      [property],
    )
  ).rows;
const enabledFn = async (g: string) =>
  (await admin.query("select public.app_option_automation_enabled($1) as on", [g])).rows[0]
    .on as boolean;

/** Opsiyon oluşturma işlemini onaya düşürür (süre yazılmamış, işletme varsayılanı yok). */
async function pendingCreate(range: string, jid: string) {
  const m = await send(`${range} opsiyon`, { jid });
  await runTask();
  const [op] = await opsOf(m.id);
  expect(op).toMatchObject({ kind: "create", status: "pending", mode: "needs_approval" });
  const id = (await admin.query("select id from option_operations where message_id = $1", [m.id]))
    .rows[0].id as string;
  return id;
}
const approveCreate = async (opId: string) => {
  const v = (await getOperation(adminDb, adminId, opId)).version;
  return decideOperation(adminDb, adminId, {
    operationId: opId,
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
};

/** Ayrı bir işletme: sahibi (doğrulanmış telefon), tek villa ve bağlı grup. Ayar satırı YOK. */
async function tenant(label: string, villaName: string) {
  const u = await mkUser(label);
  const w = (
    await createWorkspace(app, { userId: u.id, name: `İşletme ${label}`, slug: `${label}-${tag}` })
  ).id;
  others.push(w);
  const villa = await as(u, w, (tx, ctx) =>
    createProperty(tx, ctx, {
      name: villaName,
      propertyType: "villa",
      maxGuests: "6",
      bedrooms: "3",
      bathrooms: "2",
      province: "Antalya",
      district: "Kaş",
    }),
  );
  const pn = num(90 + others.length);
  await admin.query(
    "insert into wa_verified_phones (user_id, phone_hash, phone_masked) values ($1, $2, '+90 532 *** ** 09')",
    [u.id, phoneHash(pn)],
  );
  const g = await group(villa, w);
  return { user: u, ws: w, villa, group: g, pn };
}
/** Bu dosyanın işletmelerinde açık işletme / grup anahtarı sayısı (tek ortak sistemde gerekmez). */
const settingsRows = async () =>
  (
    await admin.query(
      `select (select count(*) from workspace_option_settings
                where automation_enabled and workspace_id = any($1))::int w,
              (select count(*) from wa_group_option_settings
                where enabled and workspace_id = any($1))::int g`,
      [[ws, ...others]],
    )
  ).rows[0];

beforeAll(async () => {
  // Tek ortak sistem: YALNIZ global anahtar (acil durum kill switch'i). İşletme / grup ayarı yok.
  expect(await setGlobal(true)).toBe("changed");
});

// ---------------------------------------------------------------------------------------------
describe("tek ortak sistem: yeni işletme ve yeni grup ek aktivasyon gerektirmez", () => {
  it("işletme ve grup ayar satırı olmadan bağlı grup işler", async () => {
    expect(await settingsRows()).toEqual({ w: 0, g: 0 });
    expect(await enabledFn(G.id)).toBe(true);
    const m = await send("5-8 Ocak opsiyon 48 saat");
    await runTask();
    expect((await opsOf(m.id))[0]).toMatchObject({ kind: "create", status: "applied" });
  });

  it("global açıkken oluşturulan YENİ işletme ve YENİ grup hemen işler (Super Admin ayarı yok)", async () => {
    const t = await tenant("o3n", "Villa Yeni");
    expect(await enabledFn(t.group.id)).toBe(true);
    const m = await send("5-8 Ocak opsiyon 48 saat", { jid: t.group.jid, pn: t.pn });
    await runTask();
    const [op] = await opsOf(m.id);
    expect(op).toMatchObject({ kind: "create", status: "applied" });
    expect(
      (
        await admin.query(
          "select workspace_id, property_id from reservation_options where id = $1",
          [op.result_option_id],
        )
      ).rows[0],
    ).toEqual({ workspace_id: t.ws, property_id: t.villa });
    // Aynı işletmeye eklenen ikinci grup da ayrıca açılmadan işler.
    const g2 = await group(t.villa, t.ws);
    const m2 = await send("12-15 Ocak opsiyon 24 saat", { jid: g2.jid, pn: t.pn });
    await runTask();
    expect((await opsOf(m2.id))[0]).toMatchObject({ kind: "create", status: "applied" });
    expect(await settingsRows()).toEqual({ w: 0, g: 0 });
  });
});

// ---------------------------------------------------------------------------------------------
describe("işletme izolasyonu ve işletmeye özel süre", () => {
  it("aynı tarihler iki işletmede birbirini etkilemez; varsayılan süre işletmeye özel", async () => {
    const t = await tenant("o3i", "Villa Ada");
    expect(await setWorkspace(false, 4320, t.ws)).toBe("changed"); // yalnız süre (3 gün)
    const viewA = await outside(mavi, "2027-02-01", "2027-02-28");
    const mA = await send("2-5 Şubat opsiyon"); // işletme A: varsayılan süre yok → onay
    const mB = await send("2-5 Şubat opsiyon", { jid: t.group.jid, pn: t.pn });
    await runTask();
    expect((await opsOf(mA.id))[0]).toMatchObject({ status: "pending", expires_in_minutes: null });
    expect((await opsOf(mA.id))[0].reasons).toContain("duration_missing");
    const [b] = await opsOf(mB.id);
    expect(b).toMatchObject({
      status: "applied",
      expiry_source: "workspace_default",
      expires_in_minutes: 4320,
    });
    expect(
      (
        await admin.query("select workspace_id from reservation_options where id = $1", [
          b.result_option_id,
        ])
      ).rows[0].workspace_id,
    ).toBe(t.ws);
    // İşletme A'nın opsiyonları ve dış görünümü B'den etkilenmez.
    expect(await outside(mavi, "2027-02-01", "2027-02-28")).toEqual(viewA);
  });

  it("bir grup başka işletmenin villa adını yazsa da o işletmeye ve villaya dokunulmaz", async () => {
    const t = await tenant("o3x", "Villa Kuzey");
    const before = await optionsOf(mavi);
    const m = await send("Villa Mavi 20-23 Mart opsiyon 24 saat", { jid: t.group.jid, pn: t.pn });
    await runTask();
    expect(await optionsOf(mavi)).toEqual(before);
    const ops = (
      await admin.query(
        "select workspace_id, property_id, status from option_operations where message_id = $1",
        [m.id],
      )
    ).rows;
    for (const o of ops) {
      expect(o.workspace_id).toBe(t.ws);
      expect(o.property_id === null || o.property_id === t.villa).toBe(true);
    }
  });

  it("başka işletmenin sahibi bu işletmenin grubunda opsiyon işlemi başlatamaz", async () => {
    const t = await tenant("o3y", "Villa Güney");
    const m = await send("1-4 Nisan opsiyon 24 saat", { pn: t.pn }); // G grubuna, yabancı telefon
    await runTask();
    expect(await opsOf(m.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("global kill switch önceliklidir", () => {
  it("kapatınca hiçbir işletmede mesaj okunmaz, onaylı işlem / kesinleştirme uygulanmaz; açılınca bekleyenler uygulanır, aradaki mesajlar işlenmez", async () => {
    const t = await tenant("o3k", "Villa Batı");
    const { op: conv } = await optionWithConvert("12-15 Nisan");
    const create = await pendingCreate("5-8 Nisan", G.jid);
    await approve(conv);
    await approveCreate(create);
    expect(await setGlobal(false)).toBe("changed");
    expect(await enabledFn(G.id)).toBe(false);
    expect(await enabledFn(t.group.id)).toBe(false);
    const before = await resCount();
    const m = await send("20-23 Nisan opsiyon 24 saat");
    const mt = await send("20-23 Nisan opsiyon 24 saat", { jid: t.group.jid, pn: t.pn });
    await runTask();
    expect(await scan(m.id)).toBeUndefined();
    expect(await scan(mt.id)).toBeUndefined();
    expect(await opRow(create)).toMatchObject({ status: "approved", attempts: 0 });
    expect(await opRow(conv)).toMatchObject({ status: "approved", attempts: 0 });
    expect(await resCount()).toBe(before);
    // Eski işletme / grup anahtarlarını açmak kill switch'i aşmaz.
    expect(await setWorkspace(true)).toBe("changed");
    expect(await setGroup(G.id, true)).toBe("changed");
    await runTask();
    expect(await scan(m.id)).toBeUndefined();
    expect((await opRow(conv)).status).toBe("approved");
    expect(await setGroup(G.id, false)).toBe("changed");
    expect(await setWorkspace(false)).toBe("changed");
    // Yeniden açılınca bekleyenler uygulanır; kapalıyken gelenler geriye dönük işlenmez.
    expect(await setGlobal(true)).toBe("changed");
    await runTask();
    expect((await opRow(create)).status).toBe("applied");
    expect((await opRow(conv)).status).toBe("applied");
    expect(await scan(m.id)).toBeUndefined();
    expect(await scan(mt.id)).toBeUndefined();
    const m2 = await send("26-28 Nisan opsiyon 24 saat", { jid: t.group.jid, pn: t.pn });
    await runTask();
    expect((await opsOf(m2.id))[0]).toMatchObject({ kind: "create", status: "applied" });
  });
});

// ---------------------------------------------------------------------------------------------
describe("grup bağlantısı ve villa değişikliği", () => {
  it("grup pasifleştirilirse otomasyon durur; onaylı işlem bekler", async () => {
    const P = await group(mavi);
    const create = await pendingCreate("3-6 Mayıs", P.jid);
    await approveCreate(create);
    await setAdminGroupActive(adminDb, adminId, P.id, false);
    expect(await enabledFn(P.id)).toBe(false);
    await runTask();
    expect(await opRow(create)).toMatchObject({ status: "approved", attempts: 0 });
  });

  it("grubun bağlantısı kaldırılırsa otomasyon durur; onaylı işlem uygulanmaz, silinmez", async () => {
    const P = await group(mavi);
    const create = await pendingCreate("10-13 Mayıs", P.jid);
    await approveCreate(create);
    await unlinkAdminGroup(adminDb, adminId, P.id);
    expect(await enabledFn(P.id)).toBe(false);
    await runTask();
    expect(await opRow(create)).toMatchObject({ status: "approved", attempts: 0 });
  });

  it("grubun villası değişirse eski villaya ait onaylı işlem uygulanmaz (stale / group_changed)", async () => {
    const P = await group(mavi);
    const create = await pendingCreate("17-20 Mayıs", P.jid);
    await approveCreate(create);
    await setAdminGroupProperty(adminDb, adminId, P.id, asya);
    const before = await optionsOf(mavi);
    await runTask();
    expect(await opRow(create)).toMatchObject({ status: "stale", failure_code: "group_changed" });
    expect(await optionsOf(mavi)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------------------------
describe("uçtan uca akış", () => {
  it("oluşturma → iptal; oluşturma → süre dolumu; oluşturma → onaylı kesinleştirme: dış görünüm yalnız kesin rezervasyonla değişir", async () => {
    const view0 = await outside(mavi, "2027-06-01", "2027-06-30");
    // Oluşturma + iptal (müşteri vazgeçti).
    const c1 = await send("2-5 Haziran opsiyon 48 saat");
    await runTask();
    const [o1] = await opsOf(c1.id);
    expect(o1).toMatchObject({ kind: "create", status: "applied" });
    expect(await outside(mavi, "2027-06-01", "2027-06-30")).toEqual(view0);
    const x1 = await send("2-5 Haziran opsiyon müşteri vazgeçti");
    await runTask();
    expect((await opsOf(x1.id))[0]).toMatchObject({
      kind: "cancel",
      status: "applied",
      end_reason: "customer_declined",
    });
    // Oluşturma + süre dolumu.
    const c2 = await send("8-11 Haziran opsiyon 24 saat");
    await runTask();
    const [o2] = await opsOf(c2.id);
    await admin.query("set session_replication_role = replica");
    await admin.query(
      "update reservation_options set expires_at = now() - interval '1 minute' where id = $1",
      [o2.result_option_id],
    );
    await admin.query("set session_replication_role = origin");
    await runTask();
    const st = async (id: string) =>
      (await admin.query("select status from reservation_options where id = $1", [id])).rows[0]
        .status;
    expect(await st(o1.result_option_id)).toBe("cancelled");
    expect(await st(o2.result_option_id)).toBe("expired");
    expect(await outside(mavi, "2027-06-01", "2027-06-30")).toEqual(view0);
    // Oluşturma + onaylı kesinleştirme: yalnız şimdi kesin rezervasyon oluşur.
    const { op } = await optionWithConvert("15-18 Haziran");
    expect(await outside(mavi, "2027-06-01", "2027-06-30")).toEqual(view0);
    await approve(op);
    await runTask();
    expect((await opRow(op)).status).toBe("applied");
    const view1 = await outside(mavi, "2027-06-01", "2027-06-30");
    expect(view1.reservations).not.toEqual(view0.reservations);
    expect(view1.panelConflicts).not.toEqual(view0.panelConflicts);
  });

  it("doğal Türkçe: süre v2, 'sil' iptali, ödeme kesinleştirmesi onaya, uzatma ASLA yeni opsiyon değil", async () => {
    const c = await send("3-6 Temmuz opsiyon 1,5 gün");
    await runTask();
    const [o] = await opsOf(c.id);
    expect(o).toMatchObject({ kind: "create", status: "applied", expires_in_minutes: 2160 });
    const x = await send("3-6 Temmuz opsiyonu sil");
    await runTask();
    expect((await opsOf(x.id))[0]).toMatchObject({
      kind: "cancel",
      status: "applied",
      end_reason: "owner_cancelled",
    });
    const c2 = await send("8-11 Temmuz opsiyon bir hafta");
    await runTask();
    expect((await opsOf(c2.id))[0]).toMatchObject({ status: "applied", expires_in_minutes: 10080 });
    const before = await optionsOf(mavi);
    const u = await send("8-11 Temmuz opsiyonu 1 gün uzat");
    const k = await send("8-11 Temmuz opsiyon kaparo yattı");
    const y = await send("8-11 Temmuz opsiyon yarına kadar");
    await runTask();
    expect((await opsOf(u.id))[0]).toMatchObject({ kind: "create", status: "pending" });
    expect((await opsOf(u.id))[0].reasons).toContain("intent_unclear");
    expect((await opsOf(k.id))[0]).toMatchObject({ kind: "convert", status: "pending" });
    expect((await opsOf(y.id))[0]).toMatchObject({ kind: "create", status: "pending" });
    expect((await opsOf(y.id))[0].reasons).toContain("duration_unclear");
    expect(await optionsOf(mavi)).toEqual(before); // yeni opsiyon yok
  });

  it("mevcut rezervasyon komutu ('kapat') otomasyon açıkken aynen çalışır; görev ona opsiyon işlemi yazmaz", async () => {
    const m = await send("22-24 Haziran kapat");
    const seen = await existingView(m.id);
    await runTask();
    expect(await existingView(m.id)).toEqual(seen);
    expect(await opsOf(m.id)).toEqual([]);
    const blocks = (
      await admin.query(
        "select kind, status from reservations where property_id = $1 and check_in = $2::date",
        [mavi, rangeOf("22-24 Haziran kapat")[0]],
      )
    ).rows;
    expect(blocks).toEqual([{ kind: "block", status: "confirmed" }]);
  });
});
