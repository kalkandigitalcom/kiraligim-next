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
 * Opsiyon Aşama 3d — WhatsApp mesajından opsiyon oluşturma / iptal (option-maintenance mesaj
 * işleyicisi, drizzle/0072). Gerçek PostgreSQL: mesaj ağ geçidi fonksiyonuyla kaydedilir, ÜRETİMDEKİ
 * worker'la (otomatik kapat / aç / değiştir bağlı) işlenir; görev üretimdeki gibi app_user ile tek
 * bağlantıda, gerçek işleyiciyle çalışır.
 *
 * Kanıtlananlar: anahtarlar varsayılan KAPALI ve üçü birlikte açılmadan hiçbir mesaj okunmaz;
 * geçerli oluşturma (mesajdaki süre / işletme varsayılanı); süre yoksa onay; açık opsiyonun iptali
 * (customer_declined / owner_cancelled); aynı tarihe ikinci opsiyon, çok aralık, villa uyuşmazlığı,
 * kesin kayıtla çakışma, tarihsiz iptal ve "süresi doldu" onaya; kesinleştirme işlem üretmez;
 * yalnız doğrulanmış sahip / yönetici; aynı mesaj iki kez işlem üretmez; eski mesaj ve otomasyon
 * açılmadan önceki mesaj okunmaz; kill switch; mevcut sistem (mesaj durumu, worker önerisi, ⚠️
 * tepkisi, takvim, müsaitlik, iCal, API, webhook) ve mevcut rezervasyon komutları DEĞİŞMEZ.
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 4 });
const app = drizzle(appPool, { schema, casing: DB_CASING });
const adminRolePool = new Pool({ connectionString: db.adminUrl, max: 2 });
adminRolePool.on("connect", (c) => void c.query("set role app_admin"));
const admin = new Client({ connectionString: db.adminUrl });
const tag = randomBytes(3).toString("hex");
const quiet = createLogger({ service: "option-whatsapp-test" }, () => {});
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
    application_name: "kiraligim-option-whatsapp-test",
  });
  try {
    return await runOptionMaintenance(s.db, {
      log: quiet,
      handleMessage: createOptionMessageHandler({ log: quiet }),
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
const PN_OWNER = num(71);
const PN_MANAGER = num(72);
const PN_STAFF = num(73);
const PN_STRANGER = num(74);
const TODAY = istanbulToday();

let O: U, M: U, S: U;
let ws: string;
let mavi: string, asya: string;
let conn: string;
let G: { id: string; jid: string };
let G2: { id: string; jid: string };
let adminId: string;
const planCode = `opt3d_${tag}`;
const icalToken = `o3d${tag}`.padEnd(43, "x");

let jidN = 0;
const jidBase = BigInt(`0x${randomBytes(4).toString("hex")}`) % 10_000_000n;
const newJid = () =>
  `120365${String(jidBase).padStart(7, "0")}${String(++jidN).padStart(5, "0")}@g.us`;

async function group(property: string) {
  const jid = newJid();
  await appPool.query("select public.app_wa_sync_group($1, $2, 'Ekip 3d', 4, false, false, true)", [
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
  const mid = `S${tag}${++msgN}`;
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

const scan = async (message: string) =>
  (
    await admin.query("select status, attempts from option_message_scans where message_id = $1", [
      message,
    ])
  ).rows[0];
const opsOf = async (message: string) =>
  (
    await admin.query(
      `select kind, mode, status, reasons, end_reason, expiry_source, expires_in_minutes,
              check_in::text, check_out::text, result_option_id, target_option_id
         from option_operations where message_id = $1 order by item_no`,
      [message],
    )
  ).rows;
const opt = async (id: string) =>
  (await admin.query("select * from reservation_options where id = $1", [id])).rows[0];
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
  O = await mkUser("o3d");
  M = await mkUser("o3dm");
  S = await mkUser("o3ds");
  ws = (await createWorkspace(app, { userId: O.id, name: "Opsiyon 3d", slug: `o3d-${tag}` })).id;
  const planId = uuidv7();
  await admin.query(
    "insert into plans (id, code, name, max_properties, trial_days, is_active, is_default) values ($1, $2, 'O3D', 20, 14, true, false)",
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
      `o3d-${tag}`,
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
  G2 = await group(asya);
  adminId = await createTestAdmin(admin, "opsiyon3d");
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
describe("anahtarlar ve kill switch", () => {
  it("varsayılan: üç anahtar KAPALI; opsiyon mesajı hiç okunmaz, işlem yazılmaz; worker davranışı aynı", async () => {
    expect(
      (await admin.query("select enabled from option_automation_global where id = 1")).rows[0]
        .enabled,
    ).toBe(false);
    const m = await send("10-14 Mart opsiyon 48 saat");
    const seen = await existingView(m.id);
    const r = await runTask();
    expect(r).toMatchObject({ locked: true, messages: { claimed: 0 }, failedSteps: [] });
    expect(await scan(m.id)).toBeUndefined();
    expect(await opsOf(m.id)).toEqual([]);
    expect(await existingView(m.id)).toEqual(seen);
  });

  it("yalnız global, yalnız global + işletme, yalnız grup: hiçbiri tek başına yetmez", async () => {
    expect(await setGlobal(true)).toBe("changed");
    const a = await send("10-14 Mart opsiyon 48 saat");
    await runTask();
    expect(await scan(a.id)).toBeUndefined();
    expect(await setWorkspace(true)).toBe("changed");
    const b = await send("10-14 Mart opsiyon 48 saat");
    await runTask();
    expect(await scan(b.id)).toBeUndefined();
    expect(await setGlobal(false)).toBe("changed");
    expect(await setGroup(G.id, true)).toBe("changed");
    const c = await send("10-14 Mart opsiyon 48 saat");
    await runTask();
    expect(await scan(c.id)).toBeUndefined(); // global kapalı (kill switch)
    expect(await setGlobal(true)).toBe("changed");
    // Anahtar açılmadan önce gelen mesajlar geriye dönük işlenmez.
    await runTask();
    for (const x of [a, b, c]) expect(await scan(x.id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
describe("oluşturma", () => {
  let created: string;

  it("geçerli opsiyon (süre mesajda): opsiyon + otomatik işlem; mesaj, öneri, ⚠️ ve dış görünüm aynı", async () => {
    const body = "10-14 Mart opsiyon 48 saat";
    const [ci, co] = rangeOf(body);
    const view = await outside(mavi, ci, co);
    const m = await send(body);
    const seen = await existingView(m.id);
    expect(seen.reactions.map((x) => x.emoji)).toEqual(["⚠️"]); // worker'ın mevcut davranışı
    const r = await runTask();
    expect(r).toMatchObject({ failedSteps: [] });
    expect(await scan(m.id)).toEqual({ status: "done", attempts: 1 });
    const ops = await opsOf(m.id);
    expect(ops).toEqual([
      expect.objectContaining({
        kind: "create",
        mode: "auto",
        status: "applied",
        expiry_source: "message",
        expires_in_minutes: 2880,
        check_in: ci,
        check_out: co,
      }),
    ]);
    created = ops[0].result_option_id;
    const o = await opt(created);
    expect(o).toMatchObject({
      status: "open",
      source: "whatsapp",
      group_id: G.id,
      property_id: mavi,
    });
    const sent = (
      await admin.query("select sent_at from wa_inbound_messages where id = $1", [m.id])
    ).rows[0].sent_at as Date;
    expect(new Date(o.expires_at).getTime() - sent.getTime()).toBe(2880 * 60_000);
    // Mevcut sistem: mesaj durumu, öneri ve ⚠️ tepkisi birebir aynı; opsiyon müsaitliği kapatmaz.
    expect(await existingView(m.id)).toEqual(seen);
    expect(await outside(mavi, ci, co)).toEqual(view);
  });

  it("aynı mesaj iki kez işlenmez; yeniden tarama ve işleyicinin yeniden çağrılması işlem yazmaz", async () => {
    const m = (
      await admin.query("select message_id from option_operations where result_option_id = $1", [
        created,
      ])
    ).rows[0].message_id as string;
    await runTask();
    await runTask();
    expect(await opsOf(m)).toHaveLength(1);
    // İmleç "done": işleyici doğrudan çağrılsa bile (claimed değil) öğe okunmaz, işlem yazılmaz.
    const s = createStandaloneDb(db.appUrl, { max: 1 });
    try {
      await createOptionMessageHandler()(s.db, {
        messageId: m,
        workspaceId: ws,
        groupId: G.id,
        propertyId: mavi,
        waMessageId: "x",
        body: "10-14 Mart opsiyon 48 saat",
        sentAt: new Date(),
        attempts: 1,
      });
    } finally {
      await s.end();
    }
    expect(await opsOf(m)).toHaveLength(1);
    expect(
      (await appPool.query("select * from public.app_option_message_items($1)", [m])).rows,
    ).toEqual([]);
  });

  it("aynı tarihe ikinci opsiyon otomatik oluşturulmaz → onay (option_overlap)", async () => {
    const m = await send("10-14 Mart opsiyon 24 saat");
    await runTask();
    expect(await opsOf(m.id)).toEqual([
      expect.objectContaining({
        kind: "create",
        mode: "needs_approval",
        status: "pending",
        result_option_id: null,
      }),
    ]);
    expect((await opsOf(m.id))[0].reasons).toContain("option_overlap");
  });

  it("birden fazla tarih aralığı → otomatik işlem yok, onay (multiple_ranges)", async () => {
    const m = await send("3-6 Nisan ve 9-12 Nisan opsiyon 24 saat");
    await runTask();
    const ops = await opsOf(m.id);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ status: "pending", check_in: null, check_out: null });
    expect(ops[0].reasons).toContain("multiple_ranges");
  });

  it("süre yok + varsayılan yok → onay (duration_missing); işletme varsayılanı varsa uygulanır (workspace_default)", async () => {
    const m = await send("15-18 Nisan opsiyon");
    await runTask();
    expect(await opsOf(m.id)).toEqual([
      expect.objectContaining({ status: "pending", expires_in_minutes: null }),
    ]);
    expect((await opsOf(m.id))[0].reasons).toContain("duration_missing");

    expect(await setWorkspace(true, 1440)).toBe("changed");
    const m2 = await send("20-23 Nisan opsiyon");
    await runTask();
    expect(await opsOf(m2.id)).toEqual([
      expect.objectContaining({
        status: "applied",
        mode: "auto",
        expiry_source: "workspace_default",
        expires_in_minutes: 1440,
      }),
    ]);
  });

  it("villa bilgisi eksik / uyuşmuyor → onay (villa_unclear); tarih eksik → onay", async () => {
    const m = await send("Villa Asya 1-4 Mayıs opsiyon 24 saat"); // grubun villası Mavi
    await runTask();
    expect((await opsOf(m.id))[0]).toMatchObject({ status: "pending" });
    expect((await opsOf(m.id))[0].reasons).toContain("villa_unclear");
    const m2 = await send("Opsiyon verelim 24 saat");
    await runTask();
    expect(await opsOf(m2.id)).toEqual([
      expect.objectContaining({ kind: "create", status: "pending", result_option_id: null }),
    ]);
    expect((await opsOf(m2.id))[0].reasons).toContain("date_missing");
    expect(await scan(m2.id)).toMatchObject({ status: "done" });
  });

  it("kesin rezervasyonla çakışma → onay (calendar_conflict); rezervasyon değişmez", async () => {
    const body = "7-10 Mayıs opsiyon 24 saat";
    const [ci, co] = rangeOf(body);
    const r = await as(O, ws, (tx, ctx) =>
      createReservation(tx, ctx, {
        kind: "reservation",
        propertyId: mavi,
        checkIn: ci,
        checkOut: co,
        status: "confirmed",
        source: "phone",
        guestName: "Misafir Test",
        adults: "2",
        children: "0",
      }),
    );
    const before = (await admin.query("select * from reservations where id = $1", [r])).rows[0];
    const m = await send(body);
    await runTask();
    expect((await opsOf(m.id))[0]).toMatchObject({ status: "pending", result_option_id: null });
    expect((await opsOf(m.id))[0].reasons).toContain("calendar_conflict");
    expect((await admin.query("select * from reservations where id = $1", [r])).rows[0]).toEqual(
      before,
    );
  });

  it("eski mesaj (7 günden eski) okunmaz", async () => {
    const m = await send("12-15 Mayıs opsiyon 24 saat", {
      sentAt: new Date(Date.now() - 8 * 86_400_000),
    });
    await runTask();
    expect(await scan(m.id)).toBeUndefined();
    expect(await opsOf(m.id)).toEqual([]);
  });

  it("kesinleştirme (ödeme alındı) 3e'ye kadar işlem üretmez; imleç kapanır", async () => {
    const m = await send("10-14 Mart opsiyon ödeme alındı");
    await runTask();
    expect(await scan(m.id)).toMatchObject({ status: "done" });
    expect(await opsOf(m.id)).toEqual([]);
    expect((await opt(created)).status).toBe("open");
  });
});

// ---------------------------------------------------------------------------------------------
describe("gönderen yetkisi", () => {
  it("yönetici (doğrulanmış) işlem oluşturabilir", async () => {
    const m = await send("1-3 Haziran opsiyon 24 saat", { pn: PN_MANAGER });
    await runTask();
    expect(await opsOf(m.id)).toEqual([expect.objectContaining({ status: "applied" })]);
  });

  it("personel ve doğrulanmamış katılımcı işlem oluşturamaz; worker davranışı (⚠️ dahil) aynı", async () => {
    for (const pn of [PN_STAFF, PN_STRANGER]) {
      const m = await send("5-8 Haziran opsiyon 24 saat", { pn });
      const seen = await existingView(m.id);
      await runTask();
      expect(await opsOf(m.id), pn).toEqual([]);
      expect(await existingView(m.id)).toEqual(seen);
      // Worker mesajı her zamanki gibi işledi (öneri + ⚠️); görev imleci kapattı, işlem yok.
      expect(seen.reactions.map((x) => x.emoji)).toEqual(["⚠️"]);
      expect(await scan(m.id)).toEqual({ status: "done", attempts: 1 });
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe("iptal", () => {
  it("açık opsiyonun iptali: 'müşteri vazgeçti' → customer_declined (yalnız hedef değişir)", async () => {
    const body = "1-3 Haziran opsiyon müşteri vazgeçti";
    const target = (
      await admin.query(
        "select id from reservation_options where workspace_id = $1 and status = 'open' and check_in = $2",
        [ws, rangeOf(body)[0]],
      )
    ).rows[0].id as string;
    const others = (
      await admin.query(
        "select id, status, version from reservation_options where workspace_id = $1 and id <> $2 order by id",
        [ws, target],
      )
    ).rows;
    const m = await send(body);
    await runTask();
    expect(await opsOf(m.id)).toEqual([
      expect.objectContaining({
        kind: "cancel",
        status: "applied",
        end_reason: "customer_declined",
      }),
    ]);
    expect(await opt(target)).toMatchObject({
      status: "cancelled",
      end_reason: "customer_declined",
      ended_by_message_id: m.id,
    });
    expect(
      (
        await admin.query(
          "select id, status, version from reservation_options where workspace_id = $1 and id <> $2 order by id",
          [ws, target],
        )
      ).rows,
    ).toEqual(others);
    const ev = (
      await admin.query(
        "select event, reason, actor_admin_id from reservation_option_events where option_id = $1 order by version",
        [target],
      )
    ).rows;
    expect(ev.at(-1)).toEqual({
      event: "cancelled",
      reason: "customer_declined",
      actor_admin_id: null,
    });
  });

  it("'iptal' → owner_cancelled", async () => {
    const body = "20-23 Nisan opsiyon iptal";
    const m = await send(body);
    await runTask();
    const [op] = await opsOf(m.id);
    expect(op).toMatchObject({ kind: "cancel", status: "applied", end_reason: "owner_cancelled" });
    expect(await opt(op.result_option_id)).toMatchObject({
      status: "cancelled",
      end_reason: "owner_cancelled",
    });
  });

  it("belirsiz iptaller otomatik uygulanmaz: tarihsiz, iki neden birden, 'süresi doldu'", async () => {
    const open = async () =>
      (
        await admin.query(
          "select id, status, version from reservation_options where workspace_id = $1 order by id",
          [ws],
        )
      ).rows;
    const before = await open();
    for (const [body, reason] of [
      ["Opsiyon iptal", "date_missing"],
      ["10-14 Mart opsiyon müşteri vazgeçti iptal edelim", "intent_unclear"],
      ["10-14 Mart opsiyonun süresi doldu", "intent_unclear"],
    ] as const) {
      const m = await send(body);
      await runTask();
      const ops = await opsOf(m.id);
      expect(ops, body).toHaveLength(1);
      expect(ops[0], body).toMatchObject({
        kind: "cancel",
        status: "pending",
        mode: "needs_approval",
      });
      expect(ops[0].reasons, body).toContain(reason);
    }
    expect(await open()).toEqual(before);
  });

  it("açık opsiyon yokken iptal → onay (no_open_option)", async () => {
    const m = await send("25-28 Haziran opsiyon iptal");
    await runTask();
    expect((await opsOf(m.id))[0]).toMatchObject({ status: "pending" });
    expect((await opsOf(m.id))[0].reasons).toContain("no_open_option");
  });
});

// ---------------------------------------------------------------------------------------------
describe("grup, kill switch ve mevcut sistem", () => {
  it("opsiyon otomasyonu kapalı (eşleşmeyen) grubun mesajı okunmaz", async () => {
    const m = await send("10-14 Mart opsiyon 48 saat", { jid: G2.jid });
    await runTask();
    expect(await scan(m.id)).toBeUndefined();
  });

  it("kill switch kapatılınca yeni mesaj okunmaz; açılınca o arada gelen mesaj geriye dönük işlenmez", async () => {
    expect(await setGlobal(false)).toBe("changed");
    const m = await send("10-13 Temmuz opsiyon 24 saat");
    await runTask();
    expect(await scan(m.id)).toBeUndefined();
    expect(await setGlobal(true)).toBe("changed");
    await runTask();
    expect(await scan(m.id)).toBeUndefined();
    expect(await opsOf(m.id)).toEqual([]);
  });

  it("mevcut rezervasyon komutları opsiyon otomasyonu açıkken aynen çalışır; görev bunlara işlem yazmaz", async () => {
    const body = "20-25 Ağustos kapat";
    const [ci, co] = rangeOf(body);
    const m = await send(body);
    const blocks = (
      await admin.query(
        "select kind, status, check_in::text, check_out::text from reservations where workspace_id = $1 and property_id = $2 and check_in = $3",
        [ws, mavi, ci],
      )
    ).rows;
    expect(blocks).toEqual([{ kind: "block", status: "confirmed", check_in: ci, check_out: co }]);
    const seen = await existingView(m.id);
    await runTask();
    expect(await opsOf(m.id)).toEqual([]);
    expect(await existingView(m.id)).toEqual(seen);
  });

  it("görev bittiğinde anahtar ayarlarına dokunmaz; tepki tablosuna yazmaz", async () => {
    const reactions = (await admin.query("select count(*)::int n from wa_message_reactions"))
      .rows[0].n;
    const settings = (
      await admin.query(
        "select (select updated_at from option_automation_global) g, (select updated_at from workspace_option_settings where workspace_id = $1) w",
        [ws],
      )
    ).rows[0];
    await runTask();
    expect((await admin.query("select count(*)::int n from wa_message_reactions")).rows[0].n).toBe(
      reactions,
    );
    expect(
      (
        await admin.query(
          "select (select updated_at from option_automation_global) g, (select updated_at from workspace_option_settings where workspace_id = $1) w",
          [ws],
        )
      ).rows[0],
    ).toEqual(settings);
  });
});
