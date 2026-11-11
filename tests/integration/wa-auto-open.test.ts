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
import { createReservation } from "@/server/reservations/service";
import { createAutoCloser } from "@/server/whatsapp/auto-close";
import { createAutoOpener, WA_AUTO_OPEN_NOTE } from "@/server/whatsapp/auto-open";
import { runCalendarWorker, type WorkerDeps } from "@/server/whatsapp/calendar/worker";
import { addWorkspaceMember, createWorkspace } from "@/server/workspaces/service";

import { adminBlockSender, adminSetActive, createTestAdmin } from "./wa-admin";

/**
 * WhatsApp Asistanı Aşama 2 — WhatsApp üzerinden takvim AÇMA (src/server/whatsapp/auto-open.ts,
 * drizzle/0048). Gerçek PostgreSQL 17, app_user, FORCE RLS; mesaj ağ geçidinin çağırdığı
 * fonksiyonla kaydedilir, worker üretimdeki gibi createAutoCloser + createAutoOpener ile çalışır.
 *
 * Kurallar: bağlı ve aktif grubun engellenmemiş her katılımcısı; yalnız grubun villasındaki,
 * istenen aralıkta TAMAMEN kalan takvim BLOKLARI (elle veya WhatsApp'tan) kaldırılır. Rezervasyon,
 * Airbnb/Booking kaynaklı kayıt ve harici (iCal) olay hiç değişmez; başka villaya dokunulmaz.
 * Kısmi çakışma veya kaldırılacak blok yoksa işlem yapılmaz (⚠️). ✅ yalnız commit'ten sonra.
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 6 });
const app = drizzle(appPool, { schema, casing: DB_CASING });
const admin = new Client({ connectionString: db.adminUrl });
const tag = randomBytes(3).toString("hex");
const logLines: string[] = [];
const log = createLogger({ service: "wa-auto-open-test" }, (l) => logLines.push(l));
const autoClose = createAutoCloser(app);
const autoOpen = createAutoOpener(app);
const deps = (over: WorkerDeps = {}): WorkerDeps => ({ log, autoClose, autoOpen, ...over });

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

const PN_OWNER = "905321770001";
const PN_MANAGER = "905321770002";
const PN_STAFF = "905321770003";
const PN_STRANGER = "905321770009";
const PN_BLOCKED = "905321770008";

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

let O: U, M: U, S: U;
let ws: string;
let mavi: string, asya: string;
let conn: string;
let G: { id: string; jid: string }; // Villa Mavi'ye bağlı grup
const planCode = `wa_open_${tag}`;

let jidN = 0;
const jidBase = BigInt(`0x${randomBytes(4).toString("hex")}`) % 10_000_000n;
const newJid = () =>
  `120368${String(jidBase).padStart(7, "0")}${String(++jidN).padStart(5, "0")}@g.us`;

async function group(
  status: "linked" | "discovered",
  property: string | null,
): Promise<{ id: string; jid: string }> {
  const jid = newJid();
  await appPool.query("select public.app_wa_sync_group($1, $2, 'Ekip', 4, false, false, true)", [
    conn,
    jid,
  ]);
  const id = (await admin.query("select id from wa_groups where jid = $1", [jid])).rows[0].id;
  if (status === "linked") {
    await admin.query(
      "update wa_groups set status = 'linked', workspace_id = $2, property_id = $3, linked_at = now() where id = $1",
      [id, ws, property],
    );
  }
  return { id, jid };
}

let msgN = 0;
const ingestRaw = async (jid: string, mid: string, body: string, pn: string) =>
  (
    await appPool.query<{ s: string }>(
      "select public.app_wa_ingest_message($1, $2, $3, '1@lid', $4, null, $5, now(), 'live') as s",
      [conn, jid, mid, pn, body],
    )
  ).rows[0]!.s;

/** Ağ geçidi gibi kaydeder ve worker'ı çalıştırır. */
async function send(body: string, opts: { pn?: string; jid?: string; over?: WorkerDeps } = {}) {
  const mid = `X${tag}${++msgN}`;
  const s = await ingestRaw(opts.jid ?? G.jid, mid, body, opts.pn ?? PN_OWNER);
  const summary = await runCalendarWorker(app, deps(opts.over));
  const m = (
    await admin.query<{ id: string; status: string; last_error: string | null }>(
      "select id, status, last_error from wa_inbound_messages where wa_message_id = $1",
      [mid],
    )
  ).rows[0];
  const proposals = m
    ? (
        await admin.query(
          "select * from wa_calendar_proposals where message_id = $1 order by item_no",
          [m.id],
        )
      ).rows
    : [];
  return { mid, ingest: s, message: m, proposals, summary };
}

async function calendarDigest() {
  const r = await admin.query(
    `select count(*)::int as n,
            md5(coalesce(string_agg(t::text, '|' order by t.id), '')) as h
       from reservations t where t.workspace_id = $1`,
    [ws],
  );
  return r.rows[0];
}

async function villa(name: string) {
  return as(O, ws, (tx, ctx) =>
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
  O = await mkUser("waoo");
  M = await mkUser("waom");
  S = await mkUser("waos");
  ws = (await createWorkspace(app, { userId: O.id, name: "Açma", slug: `wao-${tag}` })).id;
  const planId = uuidv7();
  await admin.query(
    "insert into plans (id, code, name, max_properties, trial_days, is_active, is_default) values ($1, $2, 'WA auto', 20, 14, true, false)",
    [planId, planCode],
  );
  await admin.query("update workspace_subscriptions set plan_id = $1 where workspace_id = $2", [
    planId,
    ws,
  ]);
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: M.id, role: "manager" }));
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: S.id, role: "staff" }));
  mavi = await villa("Villa Mavi");
  asya = await villa("Villa Asya");
  conn = (
    await appPool.query<{ id: string }>("select public.app_wa_heartbeat($1, 'open', null) as id", [
      `wao-${tag}`,
    ])
  ).rows[0]!.id;
  for (const [u, pn] of [
    [O, PN_OWNER],
    [M, PN_MANAGER],
    [S, PN_STAFF],
  ] as const) {
    await admin.query(
      "insert into wa_verified_phones (user_id, phone_hash, phone_masked) values ($1, $2, '+90 532 *** ** 01')",
      [u.id, phoneHash(pn)],
    );
  }
  G = await group("linked", mavi);
  // Worker'ın ilk aktivasyonu (aktivasyon öncesi mesajlar işlenmez).
  await runCalendarWorker(app, deps());
});

afterAll(async () => {
  await admin.query("delete from wa_inbound_messages where workspace_id = $1", [ws]);
  await admin.query(
    "update workspace_subscriptions set plan_id = (select id from plans where is_default) where workspace_id = $1",
    [ws],
  );
  await admin.query("delete from plans where code = $1", [planCode]);
  await admin.end();
  await appPool.end();
});

// ---------------------------------------------------------------------------------------------
// Yardımcılar
// ---------------------------------------------------------------------------------------------

const range = (a: number, b: number) => `${tr(day(a))}–${tr(day(b))}`;
const manualBlock = (property: string, a: number, b: number) =>
  as(O, ws, (tx, ctx) =>
    createReservation(tx, ctx, {
      kind: "block",
      propertyId: property,
      checkIn: day(a),
      checkOut: day(b),
      note: "Elle eklendi",
    }),
  );
const guestReservation = (property: string, a: number, b: number, source: string) =>
  as(O, ws, (tx, ctx) =>
    createReservation(tx, ctx, {
      kind: "reservation",
      propertyId: property,
      checkIn: day(a),
      checkOut: day(b),
      status: "confirmed",
      source,
      guestName: "Misafir Test",
      adults: "2",
      children: "0",
    }),
  );
const statusOf = async (id: string) =>
  (await admin.query<{ status: string }>("select status from reservations where id = $1", [id]))
    .rows[0]!.status;
const reactionOf = async (messageId: string) =>
  (
    await admin.query<{ kind: string; emoji: string }>(
      "select kind, emoji from wa_message_reactions where message_id = $1",
      [messageId],
    )
  ).rows;
let extN = 0;
async function externalEvent(property: string, a: number, b: number) {
  const src = uuidv7();
  await admin.query(
    `insert into external_calendar_sources (id, workspace_id, property_id, name, url)
     values ($1, $2, $3, $4, 'https://www.airbnb.com/calendar/ical/test.ics')`,
    [src, ws, property, `Airbnb ${++extN}`],
  );
  // Kaynak kilitlenir (ekleme tetikleyicisi kilidi sıfırladığı için ayrı güncelleme): diğer
  // testlerin senkron işi (runDueSync) bu kaynağı almaz.
  await admin.query(
    "update external_calendar_sources set locked_until = now() + interval '1 day' where id = $1",
    [src],
  );
  const id = uuidv7();
  await admin.query(
    `insert into external_calendar_events (id, workspace_id, property_id, source_id, uid, start_date, end_date)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [id, ws, property, src, `uid-${id}`, day(a), day(b)],
  );
  return id;
}
const externalDigest = async () =>
  (
    await admin.query(
      `select md5(coalesce(string_agg(e::text, '|' order by e.id), '')) h
         from external_calendar_events e where e.workspace_id = $1`,
      [ws],
    )
  ).rows[0].h;
/** Açma servisi çağrılmadan önerinin bekleyen kalması için (eşzamanlılık testi). */
const noOpen: WorkerDeps = {
  autoOpen: async () => ({ outcome: "failed", proposalId: null, reason: "error" }),
};

// ---------------------------------------------------------------------------------------------
// Senaryolar
// ---------------------------------------------------------------------------------------------

describe("Aşama 2: WhatsApp üzerinden takvim açma", () => {
  it("1/10/12. elle oluşturulmuş blok, sahip olmayan katılımcının komutuyla açılır; ✅ işlemden sonra", async () => {
    const block = await manualBlock(mavi, 30, 35);
    let reactionAtCall: unknown[] | null = null;
    const r = await send(`${range(30, 35)} tarihlerini açalım.`, {
      pn: PN_STRANGER,
      over: {
        autoOpen: async (req) => {
          // Tepki yalnız servis döndükten (transaction commit edildikten) SONRA yazılır.
          reactionAtCall = await reactionOf(req.messageId);
          return autoOpen(req);
        },
      },
    });
    expect(reactionAtCall).toEqual([]);
    expect(r.summary.autoOpened).toBe(1);
    expect(await statusOf(block)).toBe("cancelled");
    const p = r.proposals[0];
    expect(p).toMatchObject({
      status: "applied",
      action: "open",
      decision_mode: "quick",
      decided_by: O.id,
      sender_role: "participant",
      sender_hash: phoneHash(PN_STRANGER),
      group_id: G.id,
      property_id: mavi,
      decision_note: WA_AUTO_OPEN_NOTE,
    });
    expect(p.applied_reservation_ids).toEqual([block]);
    expect(await reactionOf(r.message!.id)).toEqual([{ kind: "done", emoji: "✅" }]);
    const cancelled = (
      await admin.query("select cancel_reason, cancelled_by from reservations where id = $1", [
        block,
      ])
    ).rows[0];
    expect(cancelled).toEqual({ cancel_reason: WA_AUTO_OPEN_NOTE, cancelled_by: O.id });
    const audit = await admin.query(
      "select actor_user_id, metadata from audit_log where target_id = $1 and action = 'whatsapp.proposal_auto_opened'",
      [p.id],
    );
    expect(audit.rows).toEqual([
      {
        actor_user_id: O.id,
        metadata: {
          property: mavi,
          reservations: [block],
          group: G.id,
          sender_role: "participant",
        },
      },
    ]);
  });

  it("2. WhatsApp'tan oluşturulmuş blok açılır (sahip kapatır, yönetici açar)", async () => {
    const close = await send(`${range(40, 43)} kapatalım.`);
    expect(close.proposals[0].status).toBe("applied");
    const blockId = close.proposals[0].applied_reservation_ids[0] as string;
    expect(await statusOf(blockId)).toBe("confirmed");
    const open = await send(
      `Daha önce kapattığımız ${range(40, 43)} tarihlerini serbest bırakalım.`,
      {
        pn: PN_MANAGER,
      },
    );
    expect(open.proposals[0]).toMatchObject({ status: "applied", action: "open" });
    expect(await statusOf(blockId)).toBe("cancelled");
    expect(await reactionOf(open.message!.id)).toEqual([{ kind: "done", emoji: "✅" }]);
  });

  it("3. aralıkta tamamen kalan birden fazla blok birlikte açılır", async () => {
    const a = await manualBlock(mavi, 50, 52);
    const b = await manualBlock(mavi, 53, 55);
    const r = await send(`Villa artık ${range(50, 56)} arasında müsait.`, { pn: PN_STAFF });
    expect(r.proposals[0].status).toBe("applied");
    expect([await statusOf(a), await statusOf(b)]).toEqual(["cancelled", "cancelled"]);
    expect([...r.proposals[0].applied_reservation_ids].sort()).toEqual([a, b].sort());
  });

  it("4. bloğun yalnız bir kısmı istenirse hiçbir değişiklik yapılmaz; ⚠️", async () => {
    const block = await manualBlock(mavi, 60, 66);
    const other = await manualBlock(mavi, 67, 69);
    for (const [a, b] of [
      [62, 64], // bloğun içi
      [58, 63], // baştan taşan
      [64, 70], // sondan taşan + tam kapsanan ikinci blok
    ] as const) {
      const before = await calendarDigest();
      const r = await send(`${range(a, b)} tarihlerini açalım.`, { pn: PN_STRANGER });
      expect(r.summary.autoOpenFailed).toBe(1);
      expect(r.proposals[0].status).toBe("pending");
      expect(await calendarDigest()).toEqual(before);
      expect(await reactionOf(r.message!.id)).toEqual([{ kind: "warning", emoji: "⚠️" }]);
      const fail = await admin.query(
        "select metadata from audit_log where target_id = $1 and action = 'whatsapp.proposal_auto_failed'",
        [r.proposals[0].id],
      );
      expect(fail.rows[0].metadata).toEqual({ reason: "partial" });
    }
    expect([await statusOf(block), await statusOf(other)]).toEqual(["confirmed", "confirmed"]);
  });

  it("5. gerçek rezervasyon hiçbir koşulda iptal edilmez; aralıkta rezervasyon varsa blok da açılmaz (⚠️)", async () => {
    const res = await guestReservation(mavi, 72, 74, "phone");
    const block = await manualBlock(mavi, 75, 77);
    const before = await calendarDigest();
    const r = await send(`${range(72, 78)} tarihlerini açalım.`, { pn: PN_STRANGER });
    // Tarihler tamamen müsait olamaz: hiçbir şey değişmez, yanıltıcı ✅ yerine ⚠️.
    expect(r.summary.autoOpenFailed).toBe(1);
    expect(r.proposals[0].status).toBe("pending");
    expect(await statusOf(res)).toBe("confirmed");
    expect(await statusOf(block)).toBe("confirmed");
    expect(await calendarDigest()).toEqual(before);
    expect(await reactionOf(r.message!.id)).toEqual([{ kind: "warning", emoji: "⚠️" }]);
    const fail = await admin.query(
      "select metadata from audit_log where target_id = $1 and action = 'whatsapp.proposal_auto_failed'",
      [r.proposals[0].id],
    );
    expect(fail.rows[0].metadata).toEqual({ reason: "occupied" });
    // Rezervasyonun dışında kalan aralık istenirse blok açılır; rezervasyon yine değişmez.
    const ok = await send(`${range(75, 77)} tarihlerini açalım.`, { pn: PN_STRANGER });
    expect(ok.proposals[0].status).toBe("applied");
    expect(await statusOf(block)).toBe("cancelled");
    expect(await statusOf(res)).toBe("confirmed");
    expect(await reactionOf(ok.message!.id)).toEqual([{ kind: "done", emoji: "✅" }]);
    // Aralıkta yalnız rezervasyon varsa: işlem yok, ⚠️ (açılabilecek blok yok).
    const only = await guestReservation(mavi, 80, 84, "direct");
    const before2 = await calendarDigest();
    const r2 = await send(`${range(80, 84)} müsait yapalım.`, { pn: PN_STRANGER });
    expect(r2.proposals[0].status).toBe("pending");
    expect(await statusOf(only)).toBe("confirmed");
    expect(await calendarDigest()).toEqual(before2);
    expect(await reactionOf(r2.message!.id)).toEqual([{ kind: "warning", emoji: "⚠️" }]);
  });

  it("6. Airbnb/Booking kaynaklı rezervasyon ve harici takvim (iCal) olayı etkilenmez", async () => {
    const airbnb = await guestReservation(mavi, 86, 88, "airbnb");
    const booking = await guestReservation(mavi, 88, 90, "booking");
    await externalEvent(mavi, 90, 93);
    const before = await calendarDigest();
    const ext = await externalDigest();
    const r = await send(`${range(86, 94)} tarihlerini açalım.`, { pn: PN_STRANGER });
    expect(r.proposals[0].status).toBe("pending");
    expect([await statusOf(airbnb), await statusOf(booking)]).toEqual(["confirmed", "confirmed"]);
    expect(await calendarDigest()).toEqual(before);
    expect(await externalDigest()).toBe(ext);
    expect(await reactionOf(r.message!.id)).toEqual([{ kind: "warning", emoji: "⚠️" }]);
    // Harici takvim doluluğuyla aynı aralıktaki blok da açılmaz (⚠️, "occupied").
    const block = await manualBlock(mavi, 94, 96);
    await externalEvent(mavi, 96, 98);
    const before2 = await calendarDigest();
    const r2 = await send(`${range(94, 98)} tarihlerini açalım.`, { pn: PN_STRANGER });
    expect(r2.proposals[0].status).toBe("pending");
    expect(await statusOf(block)).toBe("confirmed");
    expect(await calendarDigest()).toEqual(before2);
    expect(await reactionOf(r2.message!.id)).toEqual([{ kind: "warning", emoji: "⚠️" }]);
    const fail = await admin.query(
      "select metadata from audit_log where target_id = $1 and action = 'whatsapp.proposal_auto_failed'",
      [r2.proposals[0].id],
    );
    expect(fail.rows[0].metadata).toEqual({ reason: "occupied" });
  });

  it("7. başka villanın blokları etkilenmez (mesajda başka villa adı yazsa da grubun villası)", async () => {
    const asyaBlock = await manualBlock(asya, 100, 104);
    const maviBlock = await manualBlock(mavi, 100, 104);
    const r = await send(`Villa Asya ${range(100, 104)} açalım.`, { pn: PN_STRANGER });
    expect(r.proposals[0]).toMatchObject({ status: "applied", property_id: mavi });
    expect(await statusOf(maviBlock)).toBe("cancelled");
    expect(await statusOf(asyaBlock)).toBe("confirmed");
  });

  it("8. açılacak blok yoksa işlem yapılmaz; ⚠️", async () => {
    const before = await calendarDigest();
    const r = await send(`${range(106, 108)} tarihlerini açalım.`, { pn: PN_STRANGER });
    expect(r.proposals[0].status).toBe("pending");
    expect(await calendarDigest()).toEqual(before);
    expect(await reactionOf(r.message!.id)).toEqual([{ kind: "warning", emoji: "⚠️" }]);
    const fail = await admin.query(
      "select metadata from audit_log where target_id = $1 and action = 'whatsapp.proposal_auto_failed'",
      [r.proposals[0].id],
    );
    expect(fail.rows[0].metadata).toEqual({ reason: "no_target" });
  });

  it("belirsiz tarih (tek tarih) ve soru: tahmin yok, işlem yok", async () => {
    const block = await manualBlock(mavi, 110, 112);
    const single = await send(`${tr(day(110))} açalım`, { pn: PN_STRANGER });
    expect(single.summary.autoOpened + single.summary.autoOpenFailed).toBe(0);
    expect(await reactionOf(single.message!.id)).toEqual([{ kind: "warning", emoji: "⚠️" }]);
    const q = await send(`${range(110, 112)} müsait mi?`, { pn: PN_STRANGER });
    expect(await reactionOf(q.message!.id)).toEqual([]);
    expect(await statusOf(block)).toBe("confirmed");
  });

  it("9. Super Admin'in engellediği gönderici işlem yapamaz", async () => {
    const adminId = await createTestAdmin(admin, `wo${tag}`);
    expect(await adminBlockSender(admin, adminId, PN_BLOCKED, G.id)).toBe("blocked");
    const block = await manualBlock(mavi, 114, 116);
    const r = await send(`${range(114, 116)} tarihlerini açalım.`, { pn: PN_BLOCKED });
    expect(r.message).toMatchObject({ status: "ignored", last_error: "sender_blocked" });
    expect(r.proposals).toHaveLength(0);
    expect(await statusOf(block)).toBe("confirmed");
    expect(await reactionOf(r.message!.id)).toEqual([]);
  });

  it("pasif grupta işlem yapılmaz (kuyruktaki mesaj da)", async () => {
    const adminId = await createTestAdmin(admin, `wp${tag}`);
    const g2 = await group("linked", mavi);
    const block = await manualBlock(mavi, 118, 120);
    const mid = `X${tag}susp`;
    expect(await ingestRaw(g2.jid, mid, `${range(118, 120)} açalım.`, PN_STRANGER)).toBe("stored");
    expect(await adminSetActive(admin, adminId, g2.id, false)).toBe("changed");
    await runCalendarWorker(app, deps());
    const m = (
      await admin.query(
        "select status, last_error from wa_inbound_messages where wa_message_id = $1",
        [mid],
      )
    ).rows[0];
    expect(m).toEqual({ status: "ignored", last_error: "group_not_linked" });
    expect(await statusOf(block)).toBe("confirmed");
  });

  it("11. aynı mesaj tekrar gelirse ikinci kez işlem yapılmaz", async () => {
    const block = await manualBlock(mavi, 122, 124);
    const r = await send(`${range(122, 124)} tarihlerini açalım.`, { pn: PN_STRANGER });
    expect(await statusOf(block)).toBe("cancelled");
    const auditCount = async () =>
      (
        await admin.query<{ n: number }>(
          "select count(*)::int n from audit_log where action = 'reservation.status_changed' and target_id = $1",
          [block],
        )
      ).rows[0]!.n;
    expect(await auditCount()).toBe(1);
    const before = await calendarDigest();
    expect(await ingestRaw(G.jid, r.mid, "tekrar", PN_STRANGER)).toBe("duplicate");
    await runCalendarWorker(app, deps());
    // Servis aynı öğe için yeniden çağrılsa bile karar verilmiş öneri yeniden işlenmez.
    const again = await autoOpen({
      workspaceId: ws,
      userId: O.id,
      messageId: r.message!.id,
      itemNo: 0,
      propertyId: mavi,
      checkIn: day(122),
      checkOut: day(124),
    });
    expect(again).toMatchObject({ outcome: "failed", reason: "changed" });
    expect(await calendarDigest()).toEqual(before);
    expect(await auditCount()).toBe(1);
    expect(await reactionOf(r.message!.id)).toEqual([{ kind: "done", emoji: "✅" }]);
  });

  it("eşzamanlı iki açma komutu aynı bloğu yalnız bir kez açar (kilit)", async () => {
    const block = await manualBlock(mavi, 130, 133);
    const a = await send(`${range(130, 133)} tarihlerini açalım.`, {
      pn: PN_STRANGER,
      over: noOpen,
    });
    const b = await send(`${range(129, 134)} tarihlerini açalım.`, { pn: PN_STAFF, over: noOpen });
    expect([a.proposals[0].status, b.proposals[0].status]).toEqual(["pending", "pending"]);
    const call = (r: typeof a, ci: number, co: number) =>
      autoOpen({
        workspaceId: ws,
        userId: O.id,
        messageId: r.message!.id,
        itemNo: 0,
        propertyId: mavi,
        checkIn: day(ci),
        checkOut: day(co),
      });
    const results = await Promise.all([call(a, 130, 133), call(b, 129, 134)]);
    expect(results.map((x) => x.outcome).sort()).toEqual(["applied", "failed"]);
    expect(await statusOf(block)).toBe("cancelled");
    const n = await admin.query<{ n: number }>(
      "select count(*)::int n from audit_log where action = 'reservation.status_changed' and target_id = $1",
      [block],
    );
    expect(n.rows[0]!.n).toBe(1);
  });

  it("veritabanı: başarılı açma olmadan ✅ yazılamaz; 'quick' yalnız kapatma/açma", async () => {
    const r = await send(`${range(136, 138)} tarihlerini açalım.`, {
      pn: PN_STRANGER,
      over: noOpen,
    });
    await admin.query("delete from wa_message_reactions where message_id = $1", [r.message!.id]);
    const q = await appPool.query<{ r: string }>(
      "select public.app_wa_queue_reaction($1, 'done') as r",
      [r.message!.id],
    );
    expect(q.rows[0]!.r).toBe("rejected");
    const def = await admin.query(
      "select pg_get_constraintdef(oid) d from pg_constraint where conname = 'wa_calendar_proposals_quick_only_close'",
    );
    expect(def.rows[0].d).toContain("'close'::text, 'open'::text");
    expect(def.rows[0].d).not.toContain("reserve");
  });

  it("13. kapatma çalışmaya devam eder (açma ile birlikte)", async () => {
    const r = await send(`${range(140, 142)} kapatalım.`, { pn: PN_STRANGER });
    expect(r.summary.autoClosed).toBe(1);
    expect(r.proposals[0]).toMatchObject({ status: "applied", action: "close" });
    expect(await reactionOf(r.message!.id)).toEqual([{ kind: "done", emoji: "✅" }]);
  });

  it("log'da mesaj metni, villa adı ve numara yok", () => {
    const all = logLines.join("\n");
    expect(all).toContain("wa_calendar_auto_open");
    for (const s of ["açalım", "müsait", "Villa Asya", "Mavi", PN_STRANGER, PN_OWNER, "serbest"]) {
      expect(all, s).not.toContain(s);
    }
  });
});
