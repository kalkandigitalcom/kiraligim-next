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

/**
 * Opsiyon Aşama 2 — reservation_options altyapısı ve gölge mod (drizzle/0064–0065). Gerçek
 * PostgreSQL, app_user, FORCE RLS; mesajlar ağ geçidinin fonksiyonuyla kaydedilir, worker üretimdeki
 * gibi (otomatik kapatma / açma / değiştirme bağlı) çalışır.
 *
 * DEĞİŞMEZLER (kanıtlanan): opsiyon kaydı reservations / external_calendar_events tablolarına
 * yazılmaz; merkezi doluluk, çakışma kontrolü, villa sayfası, API doluluğu, iCal export ve API
 * değişiklik / webhook kayıtları opsiyonlardan etkilenmez; opsiyonla çakışan kesin kayıt değişmez
 * ve kesin kayıt opsiyon yüzünden engellenmez. Gölge mod yalnız wa_option_shadow_decisions'a
 * yazar, kapalıyken worker birebir aynı çalışır.
 *
 * Aşama 2'de opsiyon yazan uygulama kodu YOKTUR; opsiyon satırları testte süper kullanıcıyla
 * eklenir (gelecekteki yazma fonksiyonlarının yerine).
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 6 });
const app = drizzle(appPool, { schema, casing: DB_CASING });
const admin = new Client({ connectionString: db.adminUrl });
const tag = randomBytes(3).toString("hex");
const logLines: string[] = [];
const log = createLogger({ service: "options-test" }, (l) => void logLines.push(l));
const autoClose = createAutoCloser(app);
const autoOpen = createAutoOpener(app);
const autoChange = createAutoChanger(app);
const deps = (over: WorkerDeps = {}): WorkerDeps => ({
  log,
  autoClose,
  autoOpen,
  autoChange,
  ...over,
});
const ON: WorkerDeps = { optionShadow: true };

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

const PN_OWNER = "905321990001";
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
const tr2 = (a: string, b: string) => `${tr(a)}–${tr(b)}`;

let O: U, M: U, S: U, X: U;
let ws: string, wsX: string;
let mavi: string, asya: string, villaX: string;
let conn: string;
let G: { id: string; jid: string }; // Villa Mavi
let G2: { id: string; jid: string }; // Villa Asya
const icalToken = `opt${tag}`.padEnd(43, "x");
const planCode = `opt_${tag}`;

let jidN = 0;
const jidBase = BigInt(`0x${randomBytes(4).toString("hex")}`) % 10_000_000n;
const newJid = () =>
  `120369${String(jidBase).padStart(7, "0")}${String(++jidN).padStart(5, "0")}@g.us`;

async function group(property: string): Promise<{ id: string; jid: string }> {
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
const ingestRaw = async (jid: string, mid: string, body: string) =>
  (
    await appPool.query<{ s: string }>(
      "select public.app_wa_ingest_message($1, $2, $3, '1@lid', $4, null, $5, now(), 'live') as s",
      [conn, jid, mid, PN_OWNER, body],
    )
  ).rows[0]!.s;

async function send(body: string, opts: { jid?: string; over?: WorkerDeps } = {}) {
  const mid = `O${tag}${++msgN}`;
  const ingest = await ingestRaw(opts.jid ?? G.jid, mid, body);
  const summary = await runCalendarWorker(app, deps(opts.over));
  const m = (
    await admin.query<{ id: string; status: string }>(
      "select id, status from wa_inbound_messages where wa_message_id = $1",
      [mid],
    )
  ).rows[0]!;
  const q = async (t: string) =>
    (await admin.query(`select * from ${t} where message_id = $1 order by 1`, [m.id])).rows;
  return {
    mid,
    ingest,
    message: m,
    summary,
    proposals: await q("wa_calendar_proposals"),
    reactions: await q("wa_message_reactions"),
    shadow: (
      await admin.query(
        "select * from wa_option_shadow_decisions where message_id = $1 order by item_no",
        [m.id],
      )
    ).rows,
  };
}

/** Opsiyon ekler (Aşama 2'de yazan kod yok: gelecekteki yazma fonksiyonunun yerine süper kullanıcı). */
async function option(o: {
  property?: string;
  workspace?: string;
  checkIn: string;
  checkOut: string;
  expiresAt?: Date | null;
  group?: { id: string } | null;
  createdBy?: string;
}): Promise<string> {
  const id = uuidv7();
  const g = o.group ?? null;
  await admin.query(
    `insert into reservation_options (id, workspace_id, property_id, source, group_id,
       origin_wa_message_id, check_in, check_out, expires_at, expiry_source, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      o.workspace ?? ws,
      o.property ?? mavi,
      g ? "whatsapp" : "panel",
      g?.id ?? null,
      g ? `W${id}` : null,
      o.checkIn,
      o.checkOut,
      o.expiresAt ?? null,
      o.expiresAt ? "message" : null,
      o.createdBy ?? O.id,
    ],
  );
  return id;
}

const optionRow = async (id: string) =>
  (await admin.query("select * from reservation_options where id = $1", [id])).rows[0];

async function reservationAt(property: string, a: string, b: string) {
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

/** Opsiyondan etkilenmemesi gereken HER dış görünüm (aynı aralık için). */
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

async function villa(name: string, owner = O, workspace = () => ws) {
  return as(owner, workspace(), (tx, ctx) =>
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

async function errCode(p: Promise<unknown>) {
  return p.then(
    () => "ok",
    (e: unknown) => {
      const i = pgErrorInfo(e);
      return i.message && /^[a-z_]+$/.test(i.message) ? i.message : (i.code ?? "error");
    },
  );
}

beforeAll(async () => {
  await admin.connect();
  O = await mkUser("opto");
  M = await mkUser("optm");
  S = await mkUser("opts");
  X = await mkUser("optx");
  ws = (await createWorkspace(app, { userId: O.id, name: "Opsiyon", slug: `opt-${tag}` })).id;
  wsX = (await createWorkspace(app, { userId: X.id, name: "Başka", slug: `optx-${tag}` })).id;
  const planId = uuidv7();
  await admin.query(
    "insert into plans (id, code, name, max_properties, trial_days, is_active, is_default) values ($1, $2, 'Opt', 20, 14, true, false)",
    [planId, planCode],
  );
  await admin.query(
    "update workspace_subscriptions set plan_id = $1 where workspace_id in ($2, $3)",
    [planId, ws, wsX],
  );
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: M.id, role: "manager" }));
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: S.id, role: "staff" }));
  mavi = await villa("Villa Mavi");
  asya = await villa("Villa Asya");
  villaX = await villa("Villa Başka", X, () => wsX);
  conn = (
    await appPool.query<{ id: string }>("select public.app_wa_heartbeat($1, 'open', null) as id", [
      `opt-${tag}`,
    ])
  ).rows[0]!.id;
  await admin.query(
    "insert into wa_verified_phones (user_id, phone_hash, phone_masked) values ($1, $2, '+90 532 *** ** 01')",
    [O.id, phoneHash(PN_OWNER)],
  );
  await admin.query(
    "insert into property_ical_exports (property_id, workspace_id, token, created_by) values ($1, $2, $3, $4)",
    [mavi, ws, icalToken, O.id],
  );
  G = await group(mavi);
  G2 = await group(asya);
  await runCalendarWorker(app, deps()); // ilk aktivasyon
});

afterAll(async () => {
  await admin.query("delete from wa_inbound_messages where workspace_id = $1", [ws]);
  await admin.query(
    "update workspace_subscriptions set plan_id = (select id from plans where is_default) where workspace_id in ($1, $2)",
    [ws, wsX],
  );
  await admin.query("delete from plans where code = $1", [planCode]);
  await admin.end();
  await appPool.end();
});

// ---------------------------------------------------------------------------------------------
describe("takvim değişmezliği: opsiyon hiçbir dış görünümü etkilemez", () => {
  it("3–6. açık / iptal / süresi dolmuş / kesinleşmiş opsiyon: panel takvimi, çakışma, villa sayfası, API, iCal, değişiklik ve webhook kayıtları aynı", async () => {
    const a = day(40);
    const b = day(44);
    const kesin = await reservationAt(mavi, day(46), day(48));
    const before = await outside(mavi, day(30), day(60));
    expect(before.ical.length).toBeGreaterThan(0); // iCal akışı gerçekten okunuyor

    const open = await option({ checkIn: a, checkOut: b });
    const cancelled = await option({ checkIn: day(50), checkOut: day(52) });
    const expiring = await option({
      checkIn: day(54),
      checkOut: day(56),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    // Kesinleşmiş opsiyon: kesin kayıt (yukarıdaki) zaten vardı; opsiyon yalnız ona bağlanır.
    const converted = await option({ checkIn: day(46), checkOut: day(48) });
    expect(await outside(mavi, day(30), day(60))).toEqual(before);

    await admin.query(
      "update reservation_options set status = 'cancelled', end_reason = 'customer_withdrew' where id = $1",
      [cancelled],
    );
    await admin.query(
      "update reservation_options set status = 'expired', end_reason = 'expired' where id = $1",
      [expiring],
    );
    await admin.query(
      "update reservation_options set status = 'converted', end_reason = 'payment_received', converted_reservation_id = $2 where id = $1",
      [converted, kesin],
    );
    await admin.query("update reservation_options set note = 'not' where id = $1", [open]);
    expect(await outside(mavi, day(30), day(60))).toEqual(before);
  });

  it("2. opsiyonla çakışan kesin rezervasyon değişmez; opsiyon kesin kaydı engellemez ve kendisi de değişmez", async () => {
    const opt = await option({ checkIn: day(70), checkOut: day(74) });
    const optBefore = await optionRow(opt);
    // Opsiyonun üstüne (kısmen) kesin rezervasyon girilebilir: çakışma kısıtına dahil değil.
    const r = await reservationAt(mavi, day(72), day(76));
    const resBefore = (await admin.query("select * from reservations where id = $1", [r])).rows[0];
    // Opsiyon otomatik iptal edilmez / silinmez.
    expect(await optionRow(opt)).toEqual(optBefore);
    // Aynı aralığa ikinci opsiyon da veritabanında engellenmez (karar katmanında "ask").
    const opt2 = await option({ checkIn: day(72), checkOut: day(76) });
    expect((await optionRow(opt2)).status).toBe("open");
    expect((await admin.query("select * from reservations where id = $1", [r])).rows[0]).toEqual(
      resBefore,
    );
  });

  it("yapısal: hiçbir doluluk / iCal / API / webhook fonksiyonu reservation_options'ı okumaz; tabloda dış tetikleyici yok", async () => {
    const refs = (
      await admin.query<{ proname: string }>(
        `select p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace
            and p.prosrc ~* 'reservation_option' order by 1`,
      )
    ).rows.map((r) => r.proname);
    expect(refs).toEqual(["app_reservation_options_history", "app_wa_store_option_shadow"]);
    const trg = (
      await admin.query<{ t: string }>(
        `select c.relname || '.' || t.tgname t from pg_trigger t join pg_class c on c.oid = t.tgrelid
          where not t.tgisinternal and c.relname in ('reservation_options', 'reservation_option_events',
                'wa_option_shadow_decisions') order by 1`,
      )
    ).rows.map((r) => r.t);
    expect(trg).toEqual([
      "reservation_option_events.reservation_option_events_guard",
      "reservation_options.reservation_options_guard",
      "reservation_options.reservation_options_history",
    ]);
    // Çakışma kısıtları (EXCLUDE) yalnız reservations'ta; opsiyon tablosunda yok.
    const excl = (
      await admin.query(
        "select conrelid::regclass::text t from pg_constraint where contype = 'x' order by 1",
      )
    ).rows.map((r) => r.t);
    expect(excl).not.toContain("reservation_options");
    // app_migrator'ın doluluk / iCal / API / herkese açık okuma bayraklarıyla opsiyon politikası yok.
    const pol = (
      await admin.query(
        "select policyname, roles::text r, qual from pg_policies where tablename = 'reservation_options' order by 1",
      )
    ).rows;
    expect(pol.map((p) => p.policyname)).toEqual([
      "reservation_options_select",
      "reservation_options_wa_calendar_read",
    ]);
    for (const p of pol) expect(String(p.qual)).not.toMatch(/ical|api|public_read/);
  });
});

// ---------------------------------------------------------------------------------------------
describe("gölge mod", () => {
  it("1. opsiyon mesajı gölge kaydı üretir; takvim, öneri ve tepki değişmez; opsiyon oluşmaz", async () => {
    const before = await outside(mavi, day(80), day(90));
    const optsBefore = (await admin.query("select count(*)::int n from reservation_options"))
      .rows[0].n;
    const r = await send(`${tr2(day(80), day(83))} opsiyon`, { over: ON });
    expect(r.shadow).toHaveLength(1);
    expect(r.shadow[0]).toMatchObject({
      intent: "create",
      decision: "apply",
      reasons: [],
      property_id: mavi,
      group_id: G.id,
      parser_version: 8,
      target_option_id: null,
    });
    expect(r.summary.shadowDecisions).toBe(1);
    // Mevcut davranış: eylemsiz öneri + ⚠️ (Aşama 1).
    expect(r.proposals.map((p) => [p.action, p.status])).toEqual([[null, "pending"]]);
    expect(r.reactions.map((x) => x.kind)).toEqual(["warning"]);
    expect(await outside(mavi, day(80), day(90))).toEqual(before);
    expect((await admin.query("select count(*)::int n from reservation_options")).rows[0].n).toBe(
      optsBefore,
    );
  });

  it("10. gölge mod kapalıyken: kayıt yok, özet alanı yok; öneri ve tepki açık moddakiyle aynı", async () => {
    const body = (d: number) => `${tr2(day(d), day(d + 2))} opsiyon`;
    const off = await send(body(92));
    const offDefault = await send(body(95), { over: { optionShadow: false } });
    const on = await send(body(98), { over: ON });
    expect(off.shadow).toEqual([]);
    expect(offDefault.shadow).toEqual([]);
    expect(off.summary).not.toHaveProperty("shadowDecisions");
    expect(offDefault.summary).not.toHaveProperty("shadowDecisions");
    expect(on.shadow).toHaveLength(1);
    const view = (x: typeof off) => ({
      status: x.message.status,
      proposals: x.proposals.map((p) => [p.action, p.status, p.flags, p.review_reasons]),
      reactions: x.reactions.map((y) => [y.kind, y.emoji]),
      summary: { ...x.summary, shadowDecisions: undefined },
    });
    expect(view(off)).toEqual(view(on));
    expect(view(offDefault)).toEqual(view(on));
    // Kesin komutlar gölge moddan etkilenmez.
    const close = await send(`${tr2(day(101), day(103))} kapatalım.`, { over: ON });
    expect(close.proposals[0]).toMatchObject({ action: "close", status: "applied" });
    expect(close.shadow).toEqual([]);
  });

  it("7. aynı mesaj iki kez: ikinci teslim kaydedilmez, fonksiyon yeniden çağrılsa da mükerrer kayıt yok", async () => {
    const r = await send(`${tr2(day(105), day(107))} opsiyon`, { over: ON });
    expect(r.shadow).toHaveLength(1);
    expect(await ingestRaw(G.jid, r.mid, "tekrar")).toBe("duplicate");
    await runCalendarWorker(app, deps(ON));
    const items = JSON.stringify([
      {
        item_no: 0,
        parser_version: 8,
        intent: "create",
        decision: "apply",
        reasons: [],
        check_in: day(105),
        check_out: day(107),
        expires_in_minutes: null,
      },
    ]);
    const again = await appPool.query<{ n: number }>(
      "select public.app_wa_store_option_shadow($1, $2::jsonb) n",
      [r.message.id, items],
    );
    expect(again.rows[0]!.n).toBe(0);
    const n = await admin.query(
      "select count(*)::int n from wa_option_shadow_decisions where message_id = $1",
      [r.message.id],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it("8–9. gruplar ve villalar karışmaz: villa = grubun villası; bir villanın opsiyonu diğerini etkilemez", async () => {
    await option({ checkIn: day(110), checkOut: day(114), group: G });
    const mav = await send(`${tr2(day(110), day(114))} opsiyon`, { over: ON });
    const asy = await send(`${tr2(day(110), day(114))} opsiyon`, { jid: G2.jid, over: ON });
    expect(mav.shadow[0]).toMatchObject({
      property_id: mavi,
      group_id: G.id,
      decision: "ask",
      reasons: ["option_overlap"],
      open_option_count: 1,
    });
    expect(asy.shadow[0]).toMatchObject({
      property_id: asya,
      group_id: G2.id,
      decision: "apply",
      reasons: [],
      open_option_count: 0,
    });
    // Tarihsiz ödeme: yalnız AYNI gruptan açılmış açık opsiyon aranır.
    const payAsya = await send("Ödeme alındı.", { jid: G2.jid, over: ON });
    expect(payAsya.shadow[0]).toMatchObject({
      intent: "convert",
      decision: "ask",
      property_id: asya,
      target_option_id: null,
    });
    expect(payAsya.shadow[0].reasons).toContain("no_open_option");
  });

  it("çakışma: kesin rezervasyonlu tarihe opsiyon adayı 'ask' (calendar_conflict); kesin kayıt değişmez", async () => {
    const r0 = await reservationAt(mavi, day(120), day(124));
    const row0 = (await admin.query("select * from reservations where id = $1", [r0])).rows[0];
    const r = await send(`${tr2(day(121), day(123))} opsiyon`, { over: ON });
    expect(r.shadow[0]).toMatchObject({ decision: "ask", conflict_count: 1 });
    expect(r.shadow[0].reasons).toContain("calendar_conflict");
    expect((await admin.query("select * from reservations where id = $1", [r0])).rows[0]).toEqual(
      row0,
    );
  });

  it("kesinleştirme / iptal: birebir açık opsiyon → apply adayı (hiçbir şey uygulanmaz)", async () => {
    const opt = await option({ checkIn: day(130), checkOut: day(133), group: G });
    const before = await optionRow(opt);
    const cal = await outside(mavi, day(125), day(140));
    const pay = await send(`${tr2(day(130), day(133))} kapora geldi`, { over: ON });
    expect(pay.shadow[0]).toMatchObject({
      intent: "convert",
      decision: "apply",
      target_option_id: opt,
    });
    const cancel = await send(`${tr2(day(130), day(133))} opsiyon iptal`, { over: ON });
    expect(cancel.shadow[0]).toMatchObject({
      intent: "cancel",
      decision: "apply",
      target_option_id: opt,
    });
    expect(await optionRow(opt)).toEqual(before);
    expect(await outside(mavi, day(125), day(140))).toEqual(cal);
    // Tarihsiz: tek açık opsiyon bulunsa da kural karara bağlanana kadar "ask".
    const dateless = await send("Opsiyon iptal.", { over: ON });
    expect(dateless.shadow[0]).toMatchObject({ intent: "cancel", decision: "ask" });
  });

  it("12. süresi dolmuş opsiyon adayı onaylanmaz: süresi geçmiş açık / kapanmış opsiyon için kesinleştirme 'ask'", async () => {
    const past = await option({
      checkIn: day(140),
      checkOut: day(143),
      group: G,
      expiresAt: new Date(Date.now() + 1_000),
    });
    await new Promise((r) => setTimeout(r, 1_200));
    const before = await outside(mavi, day(135), day(150));
    const pay = await send(`${tr2(day(140), day(143))} ödeme alındı`, { over: ON });
    expect(pay.shadow[0]).toMatchObject({
      intent: "convert",
      decision: "ask",
      target_option_id: past,
    });
    expect(pay.shadow[0].reasons).toContain("option_expired");
    expect((await optionRow(past)).status).toBe("open"); // gölge mod hiçbir şeyi kapatmaz
    expect(await outside(mavi, day(135), day(150))).toEqual(before);

    const closed = await option({
      checkIn: day(145),
      checkOut: day(147),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await admin.query(
      "update reservation_options set status = 'expired', end_reason = 'expired' where id = $1",
      [closed],
    );
    const late = await send(`${tr2(day(145), day(147))} kapora geldi`, { over: ON });
    expect(late.shadow[0]).toMatchObject({ decision: "ask", target_option_id: closed });
    expect(late.shadow[0].reasons).toContain("option_not_open");
    expect((await optionRow(closed)).status).toBe("expired");
  });

  it("soru ve olumsuz ifade 'ignore'; birden fazla aralık 'ask' (multiple_ranges)", async () => {
    const q = await send(`${tr2(day(150), day(152))} opsiyon verelim mi?`, { over: ON });
    expect(q.shadow[0]).toMatchObject({ decision: "ignore", reasons: ["question"] });
    const multi = await send(`${tr2(day(154), day(156))} ve ${tr2(day(158), day(160))} opsiyon`, {
      over: ON,
    });
    expect(multi.shadow).toHaveLength(1);
    // v8 ayrıştırıcı iki aralıklı opsiyonu tarihsiz tek öğe (date_ambiguous) olarak verir:
    // tarih yazılmaz, karar "ask" (analizcinin multiple_ranges dalı birim testinde).
    expect(multi.shadow[0]).toMatchObject({ decision: "ask", check_in: null, check_out: null });
    expect(
      multi.shadow[0].reasons.some((r: string) => r === "multiple_ranges" || r === "date_unclear"),
    ).toBe(true);
  });

  it("veritabanı savunması: işlenmemiş / eski / başka durumdaki mesaj için yazılmaz; geçersiz öğe reddedilir", async () => {
    const mid = `O${tag}raw${++msgN}`;
    await ingestRaw(G.jid, mid, `${tr2(day(162), day(164))} opsiyon`);
    const m = (
      await admin.query("select id from wa_inbound_messages where wa_message_id = $1", [mid])
    ).rows[0].id as string;
    const item = (o: object = {}) =>
      JSON.stringify([
        {
          item_no: 0,
          parser_version: 8,
          intent: "create",
          decision: "apply",
          reasons: [],
          check_in: day(162),
          check_out: day(164),
          expires_in_minutes: null,
          ...o,
        },
      ]);
    const call = (items: string, id = m) =>
      appPool.query<{ n: number }>("select public.app_wa_store_option_shadow($1, $2::jsonb) n", [
        id,
        items,
      ]);
    expect((await call(item())).rows[0]!.n).toBe(0); // henüz işlenmedi (received)
    await runCalendarWorker(app, deps()); // gölge kapalı işlenir
    await admin.query(
      "update wa_inbound_messages set processed_at = now() - interval '31 minutes' where id = $1",
      [m],
    );
    expect((await call(item())).rows[0]!.n).toBe(0); // 30 dakikadan eski
    await admin.query("update wa_inbound_messages set processed_at = now() where id = $1", [m]);
    for (const bad of [
      item({ intent: "x" }),
      item({ decision: "maybe" }),
      item({ reasons: ["calendar_conflict"] }), // veritabanı nedeni dışarıdan verilemez
      item({ reasons: ["drop table"] }),
      item({ check_out: day(161) }),
      item({ item_no: 99 }),
      item({ expires_in_minutes: 0 }),
    ]) {
      expect(await errCode(call(bad))).toBe("wa_shadow_invalid");
    }
    expect((await call(item())).rows[0]!.n).toBe(1);
    expect(
      (
        await admin.query(
          "select count(*)::int n from wa_option_shadow_decisions where message_id = $1",
          [m],
        )
      ).rows[0].n,
    ).toBe(1);
  });
});

describe("gölge mod hata sayacı", () => {
  it("yukarıdaki hiçbir gölge yazımı sessizce başarısız olmadı (wa_option_shadow_failed yok)", () => {
    expect(logLines.filter((l) => l.includes("wa_option_shadow_failed"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("durum geçişleri ve geçmiş", () => {
  it("yalnız 'open' eklenir; son durum ve tarihler değişmez; silinemez; sürüm ve sona eriş zamanı veritabanında", async () => {
    expect(
      await errCode(
        admin.query(
          `insert into reservation_options (id, workspace_id, property_id, source, check_in, check_out, status, ended_at, end_reason)
           values ($1, $2, $3, 'panel', $4, $5, 'cancelled', now(), 'cancelled_in_panel')`,
          [uuidv7(), ws, mavi, day(170), day(172)],
        ),
      ),
    ).toBe("option_insert_not_open");
    const id = await option({ checkIn: day(170), checkOut: day(172) });
    const r0 = await optionRow(id);
    expect([r0.status, r0.version, r0.ended_at]).toEqual(["open", 1, null]);
    expect(
      await errCode(
        admin.query("update reservation_options set check_out = $2 where id = $1", [id, day(173)]),
      ),
    ).toBe("option_dates_immutable");
    expect(
      await errCode(
        admin.query("update reservation_options set property_id = $2 where id = $1", [id, asya]),
      ),
    ).toBe("option_immutable_field");
    // Kesinleşme kesin kayıt olmadan olmaz (tutarlılık kısıtı).
    expect(
      await errCode(
        admin.query(
          "update reservation_options set status = 'converted', end_reason = 'payment_received' where id = $1",
          [id],
        ),
      ),
    ).toBe("23514");
    // Durum ↔ neden uyumu.
    expect(
      await errCode(
        admin.query(
          "update reservation_options set status = 'cancelled', end_reason = 'expired' where id = $1",
          [id],
        ),
      ),
    ).toBe("23514");
    await admin.query(
      "update reservation_options set status = 'cancelled', end_reason = 'cancelled_by_owner', ended_by_user_id = $2 where id = $1",
      [id, O.id],
    );
    const r1 = await optionRow(id);
    expect([r1.status, r1.version, r1.end_reason]).toEqual(["cancelled", 2, "cancelled_by_owner"]);
    expect(r1.ended_at).toBeInstanceOf(Date);
    // 8. İptal edilmiş opsiyon tekrar açılamaz / kesinleşemez.
    expect(
      await errCode(
        admin.query(
          "update reservation_options set status = 'open', end_reason = null, ended_at = null, ended_by_user_id = null where id = $1",
          [id],
        ),
      ),
    ).toBe("option_final_immutable");
    expect(
      await errCode(admin.query("update reservation_options set note = 'x' where id = $1", [id])),
    ).toBe("option_final_immutable");
    expect(await errCode(admin.query("delete from reservation_options where id = $1", [id]))).toBe(
      "option_delete_forbidden",
    );
    const ev = (
      await admin.query(
        "select event, from_status, to_status, reason, actor_user_id, version from reservation_option_events where option_id = $1 order by version",
        [id],
      )
    ).rows;
    expect(ev).toEqual([
      {
        event: "created",
        from_status: null,
        to_status: "open",
        reason: null,
        actor_user_id: O.id,
        version: 1,
      },
      {
        event: "cancelled",
        from_status: "open",
        to_status: "cancelled",
        reason: "cancelled_by_owner",
        actor_user_id: O.id,
        version: 2,
      },
    ]);
    // Geçmiş değiştirilemez ve silinemez.
    expect(
      await errCode(
        admin.query("update reservation_option_events set reason = null where option_id = $1", [
          id,
        ]),
      ),
    ).toBe("option_history_immutable");
    expect(
      await errCode(
        admin.query("delete from reservation_option_events where option_id = $1", [id]),
      ),
    ).toBe("option_history_immutable");
  });

  it("kesinleşme yalnız kesin kayda bağlanır ve tekildir; kesinleşmiş opsiyon iptal edilemez", async () => {
    const r = await reservationAt(mavi, day(176), day(178));
    const a = await option({ checkIn: day(176), checkOut: day(178) });
    const b = await option({ checkIn: day(176), checkOut: day(178) });
    await admin.query(
      "update reservation_options set status = 'converted', end_reason = 'payment_received', converted_reservation_id = $2 where id = $1",
      [a, r],
    );
    expect(
      await errCode(
        admin.query(
          "update reservation_options set status = 'converted', end_reason = 'payment_received', converted_reservation_id = $2 where id = $1",
          [b, r],
        ),
      ),
    ).toBe("23505");
    // 7. Kesinleşmiş opsiyon sonradan iptal edilemez.
    expect(
      await errCode(
        admin.query(
          "update reservation_options set status = 'cancelled', end_reason = 'customer_withdrew', converted_reservation_id = null where id = $1",
          [a],
        ),
      ),
    ).toBe("option_final_immutable");
    expect((await optionRow(a)).status).toBe("converted");
  });

  it("mesaj temizliği (90 gün) son durumdaki opsiyonu bozmaz: referans NULL'a iner, geçmiş korunur", async () => {
    const r = await send(`${tr2(day(180), day(182))} opsiyon`, { over: ON });
    const id = uuidv7();
    await admin.query(
      `insert into reservation_options (id, workspace_id, property_id, source, group_id, origin_message_id,
         origin_wa_message_id, check_in, check_out, created_by)
       values ($1, $2, $3, 'whatsapp', $4, $5, $6, $7, $8, $9)`,
      [id, ws, mavi, G.id, r.message.id, r.mid, day(180), day(182), O.id],
    );
    await admin.query(
      "update reservation_options set status = 'cancelled', end_reason = 'customer_withdrew', ended_by_message_id = $2 where id = $1",
      [id, r.message.id],
    );
    await admin.query("delete from wa_inbound_messages where id = $1", [r.message.id]);
    const row = await optionRow(id);
    expect([row.status, row.origin_message_id, row.ended_by_message_id, row.version]).toEqual([
      "cancelled",
      null,
      null,
      2,
    ]);
    expect(row.origin_wa_message_id).toBe(r.mid);
    const ev = await admin.query(
      "select count(*)::int n, count(message_id)::int m from reservation_option_events where option_id = $1",
      [id],
    );
    expect(ev.rows[0]).toEqual({ n: 2, m: 0 });
    // Gölge kayıtları mesajla birlikte silinir.
    expect(
      (
        await admin.query(
          "select count(*)::int n from wa_option_shadow_decisions where message_id = $1",
          [r.message.id],
        )
      ).rows[0].n,
    ).toBe(0);
    // Aynı WhatsApp mesajı ikinci opsiyonu açamaz (mesaj silinse de kimlik kalıcı).
    expect(
      await errCode(
        admin.query(
          `insert into reservation_options (id, workspace_id, property_id, source, group_id,
             origin_wa_message_id, check_in, check_out) values ($1, $2, $3, 'whatsapp', $4, $5, $6, $7)`,
          [uuidv7(), ws, mavi, G.id, r.mid, day(184), day(186)],
        ),
      ),
    ).toBe("23505");
  });
});

// ---------------------------------------------------------------------------------------------
describe("11. RLS ve yetkiler", () => {
  let mine: string;
  let foreign: string;
  beforeAll(async () => {
    mine = await option({ checkIn: day(190), checkOut: day(192) });
    foreign = await option({
      workspace: wsX,
      property: villaX,
      checkIn: day(190),
      checkOut: day(192),
      createdBy: X.id,
    });
  });

  it("işletme üyeleri yalnız kendi opsiyonlarını ve geçmişini görür; gölge kararlarını yalnız owner / manager", async () => {
    const see = (u: U, w: string, t: string) =>
      as(u, w, async (tx) => (await tx.execute(sql.raw(`select id from ${t}`))).rows.length);
    const ids = async (u: U, w: string) =>
      as(u, w, async (tx) =>
        (await tx.execute<{ id: string }>(sql.raw("select id from reservation_options"))).rows.map(
          (r) => r.id,
        ),
      );
    expect(await ids(O, ws)).toContain(mine);
    expect(await ids(O, ws)).not.toContain(foreign);
    expect(await ids(S, ws)).toContain(mine);
    expect(await ids(X, wsX)).toEqual([foreign]);
    expect(await see(O, ws, "reservation_option_events")).toBeGreaterThan(0);
    expect(await see(X, wsX, "reservation_option_events")).toBe(1);
    expect(await see(O, ws, "wa_option_shadow_decisions")).toBeGreaterThan(0);
    expect(await see(M, ws, "wa_option_shadow_decisions")).toBeGreaterThan(0);
    expect(await see(S, ws, "wa_option_shadow_decisions")).toBe(0);
    expect(await see(X, wsX, "wa_option_shadow_decisions")).toBe(0);
  });

  it("app_user hiçbir opsiyon / geçmiş / gölge tablosuna yazamaz (Aşama 2'de yazma yolu yok)", async () => {
    const tryAs = (u: U, w: string, q: string) => errCode(as(u, w, (tx) => tx.execute(sql.raw(q))));
    for (const q of [
      `insert into reservation_options (id, workspace_id, property_id, source, check_in, check_out)
         values (gen_random_uuid(), '${ws}', '${mavi}', 'panel', '${day(194)}', '${day(196)}')`,
      `update reservation_options set note = 'x' where id = '${mine}'`,
      `delete from reservation_options where id = '${mine}'`,
      `insert into reservation_option_events (id, option_id, workspace_id, event, to_status, version)
         values (gen_random_uuid(), '${mine}', '${ws}', 'created', 'open', 1)`,
      `delete from wa_option_shadow_decisions`,
      `update wa_option_shadow_decisions set decision = 'apply'`,
    ]) {
      expect([q.slice(0, 40), await tryAs(O, ws, q)]).toEqual([q.slice(0, 40), "42501"]);
    }
  });

  it("tablolar FORCE RLS; app_worker / app_admin / PUBLIC yetkisi yok; gölge fonksiyonu yalnız app_user", async () => {
    const t = (
      await admin.query(
        `select c.relname, c.relrowsecurity rls, c.relforcerowsecurity force,
                has_table_privilege('app_user', c.oid, 'INSERT') ins,
                has_table_privilege('app_user', c.oid, 'UPDATE') upd,
                has_table_privilege('app_user', c.oid, 'DELETE') del,
                has_table_privilege('app_worker', c.oid, 'SELECT') worker,
                has_table_privilege('app_admin', c.oid, 'SELECT') adm
           from pg_class c where c.relname in ('reservation_options', 'reservation_option_events',
                'wa_option_shadow_decisions') order by 1`,
      )
    ).rows;
    expect(t).toEqual(
      ["reservation_option_events", "reservation_options", "wa_option_shadow_decisions"].map(
        (relname) => ({
          relname,
          rls: true,
          force: true,
          ins: false,
          upd: false,
          del: false,
          worker: false,
          adm: false,
        }),
      ),
    );
    const f = (
      await admin.query(
        `select has_function_privilege('app_user', 'public.app_wa_store_option_shadow(uuid, jsonb)', 'EXECUTE') u,
                has_function_privilege('app_admin', 'public.app_wa_store_option_shadow(uuid, jsonb)', 'EXECUTE') a,
                has_function_privilege('app_worker', 'public.app_wa_store_option_shadow(uuid, jsonb)', 'EXECUTE') w`,
      )
    ).rows[0];
    expect(f).toEqual({ u: true, a: false, w: false });
  });
});
