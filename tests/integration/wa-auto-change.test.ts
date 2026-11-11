import { createHash, randomBytes } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { DB_CASING } from "@/db/casing";
import * as schema from "@/db/schema";
import { type TenantContext, type Tx, withTenant } from "@/db/tenant";
import { createLogger } from "@/lib/logger";
import { istanbulToday } from "@/lib/reservation-meta";
import { createProperty } from "@/server/properties/service";
import { createReservation } from "@/server/reservations/service";
import { createAutoCloser } from "@/server/whatsapp/auto-close";
import { createAutoChanger, WA_AUTO_CHANGE_NOTE } from "@/server/whatsapp/auto-change";
import { createAutoOpener } from "@/server/whatsapp/auto-open";
import { runCalendarWorker, type WorkerDeps } from "@/server/whatsapp/calendar/worker";
import { addWorkspaceMember, createWorkspace } from "@/server/workspaces/service";

/**
 * WhatsApp Asistanı v6 — WhatsApp üzerinden rezervasyon / blok TARİH DEĞİŞTİRME
 * (src/server/whatsapp/auto-change.ts, drizzle/0049–0050). Gerçek PostgreSQL 17, app_user,
 * FORCE RLS; mesaj ağ geçidinin çağırdığı fonksiyonla kaydedilir, worker üretimdeki gibi
 * createAutoCloser + createAutoOpener + createAutoChanger ile çalışır.
 *
 * Kurallar: misafir adı kullanılmaz; grubun villasında ESKİ aralıkla birebir eşleşen TEK kayıt
 * (rezervasyon veya blok) yeni aralığa taşınır, aynı kayıt güncellenir ve diğer bilgileri korunur.
 * Kayıt yok / birden çok / kısmi eşleşme, Airbnb/Booking kaynaklı kayıt, yeni aralıkta çakışma
 * (kayıt veya iCal) → işlem yok, ⚠️. ✅ yalnız commit'ten sonra.
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 6 });
const app = drizzle(appPool, { schema, casing: DB_CASING });
const admin = new Client({ connectionString: db.adminUrl });
const tag = randomBytes(3).toString("hex");
const logLines: string[] = [];
const log = createLogger({ service: "wa-auto-change-test" }, (l) => logLines.push(l));
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

const PN_OWNER = "905321780001";
const PN_MANAGER = "905321780002";
const PN_STAFF = "905321780003";
const PN_STRANGER = "905321780009";

const TODAY = istanbulToday();
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
const planCode = `wa_change_${tag}`;

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
  O = await mkUser("wacoo");
  M = await mkUser("wacom");
  S = await mkUser("wacos");
  ws = (await createWorkspace(app, { userId: O.id, name: "Değiştirme", slug: `wac-${tag}` })).id;
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
      `wac-${tag}`,
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
const externalDigest = async () =>
  (
    await admin.query(
      `select md5(coalesce(string_agg(e::text, '|' order by e.id), '')) h
         from external_calendar_events e where e.workspace_id = $1`,
      [ws],
    )
  ).rows[0].h;
/** Bugünden `months` ay sonraki ayın `d`. günü (ISO). Testler birbirinin aylarını kullanmaz. */
function md(months: number, d: number): string {
  const y = Number(TODAY.slice(0, 4));
  const m0 = Number(TODAY.slice(5, 7)) - 1 + months;
  const yy = y + Math.floor(m0 / 12);
  const mm = (m0 % 12) + 1;
  return `${yy}-${String(mm).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
const tr2 = (a: string, b: string) => `${tr(a)}-${tr(b)}`;
const rowOf = async (id: string) =>
  (
    await admin.query(
      `select id, kind, status, source, to_char(check_in, 'YYYY-MM-DD') as check_in,
              to_char(check_out, 'YYYY-MM-DD') as check_out, guest_name, adults, children,
              total_amount_minor, deposit_amount_minor, currency, note, created_by,
              property_id, origin_proposal_id
         from reservations where id = $1`,
      [id],
    )
  ).rows[0];
const blockAt = (property: string, a: string, b: string) =>
  as(O, ws, (tx, ctx) =>
    createReservation(tx, ctx, {
      kind: "block",
      propertyId: property,
      checkIn: a,
      checkOut: b,
      note: "Elle eklendi",
    }),
  );
const reservationAt = (property: string, a: string, b: string, source = "phone") =>
  as(O, ws, (tx, ctx) =>
    createReservation(tx, ctx, {
      kind: "reservation",
      propertyId: property,
      checkIn: a,
      checkOut: b,
      status: "confirmed",
      source,
      guestName: "Misafir Test",
      adults: "4",
      children: "1",
      totalAmount: "45000",
      depositAmount: "10000",
      currency: "TRY",
      note: "Havalimanı transferi",
    }),
  );
async function externalAt(property: string, a: string, b: string) {
  const src = uuidv7();
  await admin.query(
    `insert into external_calendar_sources (id, workspace_id, property_id, name, url)
     values ($1, $2, $3, $4, 'https://www.airbnb.com/calendar/ical/test.ics')`,
    [src, ws, property, `Airbnb c${++extN}`],
  );
  await admin.query(
    "update external_calendar_sources set locked_until = now() + interval '1 day' where id = $1",
    [src],
  );
  const id = uuidv7();
  await admin.query(
    `insert into external_calendar_events (id, workspace_id, property_id, source_id, uid, start_date, end_date)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [id, ws, property, src, `uid-${id}`, a, b],
  );
  return id;
}
const activeCount = async () =>
  Number(
    (
      await admin.query(
        "select count(*)::int as n from reservations where workspace_id = $1 and status <> 'cancelled'",
        [ws],
      )
    ).rows[0].n,
  );
const failReason = async (proposalId: string) =>
  (
    await admin.query(
      "select metadata from audit_log where target_id = $1 and action = 'whatsapp.proposal_auto_failed'",
      [proposalId],
    )
  ).rows[0]?.metadata;

/** Başarısız değiştirme: takvim değişmez, öneri bekler, ⚠️ ve neden kodu. */
async function expectNoChange(body: string, reason: string, pn = PN_STRANGER) {
  const before = await calendarDigest();
  const ext = await externalDigest();
  const r = await send(body, { pn });
  expect(r.proposals).toHaveLength(1);
  expect(r.proposals[0]).toMatchObject({ action: "change", status: "pending" });
  expect(r.summary.autoChangeFailed).toBe(1);
  expect(await calendarDigest()).toEqual(before);
  expect(await externalDigest()).toBe(ext);
  expect(await reactionOf(r.message!.id)).toEqual([{ kind: "warning", emoji: "⚠️" }]);
  expect(await failReason(r.proposals[0].id)).toEqual({ reason });
  return r;
}

// ---------------------------------------------------------------------------------------------
// Senaryolar
// ---------------------------------------------------------------------------------------------

describe("v6: WhatsApp üzerinden tarih değiştirme", () => {
  it("20-25 → 20-26 (aynı ay): aynı rezervasyon güncellenir, diğer bilgiler korunur; ✅", async () => {
    const [a, b, nb] = [md(2, 20), md(2, 25), md(2, 26)];
    const id = await reservationAt(mavi, a, b);
    const before = await rowOf(id);
    const count = await activeCount();
    const r = await send(`${tr2(a, b)} rezervasyonu ${tr2(a, nb)} olarak değiştirilmiştir.`, {
      pn: PN_STRANGER,
    });
    expect(r.summary.autoChanged).toBe(1);
    const p = r.proposals[0];
    expect(p).toMatchObject({
      status: "applied",
      action: "change",
      decision_mode: "quick",
      decided_by: O.id,
      sender_role: "participant",
      sender_hash: phoneHash(PN_STRANGER),
      group_id: G.id,
      property_id: mavi,
      decision_note: WA_AUTO_CHANGE_NOTE,
    });
    expect(p.applied_reservation_ids).toEqual([id]);
    // Aynı kayıt: yalnız tarihler değişti; misafir, kişi, tutar, not, kaynak, durum korunur.
    const after = await rowOf(id);
    expect(after).toEqual({ ...before, check_out: nb });
    expect(await activeCount()).toBe(count);
    expect(await reactionOf(r.message!.id)).toEqual([{ kind: "done", emoji: "✅" }]);
    const audit = await admin.query(
      "select actor_user_id, metadata from audit_log where target_id = $1 and action = 'whatsapp.proposal_auto_changed'",
      [p.id],
    );
    expect(audit.rows).toEqual([
      {
        actor_user_id: O.id,
        metadata: {
          property: mavi,
          reservation: id,
          kind: "reservation",
          group: G.id,
          sender_role: "participant",
        },
      },
    ]);
    const upd = await admin.query(
      "select metadata from audit_log where target_id = $1 and action = 'reservation.updated'",
      [id],
    );
    expect(upd.rows).toEqual([{ metadata: { property: mavi, fields: ["dates"] } }]);
  });

  it("20-25 → 22-27: eski aralık boşalır, yeni aralık dolar (elle eklenmiş blok da taşınır)", async () => {
    const [a, b, na, nb] = [md(3, 20), md(3, 25), md(3, 22), md(3, 27)];
    const id = await blockAt(mavi, a, b);
    const r = await send(`${tr2(a, b)} yerine ${tr2(na, nb)} olacak.`, { pn: PN_STAFF });
    expect(r.proposals[0].status).toBe("applied");
    expect(await rowOf(id)).toMatchObject({
      kind: "block",
      status: "confirmed",
      check_in: na,
      check_out: nb,
      note: "Elle eklendi",
    });
    // Eski aralığın ilk iki gecesi artık boş: aynı günlere blok eklenebilir.
    const freed = await blockAt(mavi, a, na);
    expect(await statusOf(freed)).toBe("confirmed");
    expect(await reactionOf(r.message!.id)).toEqual([{ kind: "done", emoji: "✅" }]);
  });

  it("ay belirtilmemiş yeni aralık eski aralığın ayını alır (20-25 Temmuz → 20-26)", async () => {
    const [a, b, nb] = [md(4, 20), md(4, 25), md(4, 26)];
    const id = await reservationAt(mavi, a, b);
    const r = await send(`${tr2(a, b)} rezervasyonu 20-26 olarak değiştirilmiştir.`);
    expect(r.proposals[0]).toMatchObject({ status: "applied", action: "change" });
    expect(await rowOf(id)).toMatchObject({ check_in: a, check_out: nb });
  });

  it("farklı aylar arasında: 28 → 2 (sonraki ay) aralığı sonraki aya taşınır", async () => {
    const [a, b, na, nb] = [md(5, 26), md(6, 1), md(6, 5), md(6, 10)];
    const id = await reservationAt(mavi, a, b);
    const r = await send(`${tr(a)} - ${tr(b)} rezervasyonunu ${tr2(na, nb)}'a aldık.`);
    expect(r.proposals[0].status).toBe("applied");
    expect(await rowOf(id)).toMatchObject({ check_in: na, check_out: nb });
  });

  it("giriş/çıkış yazımı ve eski/yeni etiketi", async () => {
    const [a, b, na, nb] = [md(7, 3), md(7, 8), md(7, 10), md(7, 14)];
    const id = await reservationAt(mavi, a, b);
    const r = await send(
      `${tr(a)} giriş ${tr(b)} çıkış olan rezervasyon ${tr(na)} giriş ${tr(nb)} çıkış olarak değişti.`,
    );
    expect(r.proposals[0].status).toBe("applied");
    expect(await rowOf(id)).toMatchObject({ check_in: na, check_out: nb });
    const r2 = await send(
      `Yeni tarihler ${tr2(md(7, 20), md(7, 24))}, eski tarihler ${tr2(na, nb)}.`,
    );
    expect(r2.proposals[0].status).toBe("applied");
    expect(await rowOf(id)).toMatchObject({ check_in: md(7, 20), check_out: md(7, 24) });
  });

  it("yıl değişimi: Aralık sonu → Ocak başı", async () => {
    // Bugünden sonraki ilk Aralık (en az ~2 hafta ileride).
    const y = Number(TODAY.slice(0, 4)) + (TODAY > `${TODAY.slice(0, 4)}-12-10` ? 1 : 0);
    const [a, b, na, nb] = [`${y}-12-28`, `${y + 1}-01-02`, `${y + 1}-01-03`, `${y + 1}-01-08`];
    const id = await reservationAt(mavi, a, b);
    const r = await send(`${tr(a)}-${tr(b)} rezervasyonu ${tr2(na, nb)} olarak değişti`);
    expect(r.proposals[0]).toMatchObject({
      status: "applied",
      old_check_in: expect.anything(),
    });
    expect(await rowOf(id)).toMatchObject({ check_in: na, check_out: nb });
  });

  it("eski aralıkta kayıt yoksa işlem yok (⚠️ no_target)", async () => {
    await expectNoChange(
      `${tr2(md(8, 1), md(8, 5))} rezervasyonu ${tr2(md(8, 6), md(8, 9))} olarak değiştirildi.`,
      "no_target",
    );
  });

  it("eski aralıkta birden çok kayıt: otomatik seçim yok (⚠️ multiple)", async () => {
    const x = await blockAt(mavi, md(8, 10), md(8, 12));
    const y = await reservationAt(mavi, md(8, 12), md(8, 15));
    await expectNoChange(
      `${tr2(md(8, 10), md(8, 15))} rezervasyonu ${tr2(md(8, 20), md(8, 25))} olarak değiştirildi.`,
      "multiple",
    );
    expect([await statusOf(x), await statusOf(y)]).toEqual(["confirmed", "confirmed"]);
  });

  it("tek kayıt ama tarihleri birebir aynı değil: tahmin yok (⚠️ partial)", async () => {
    const id = await reservationAt(mavi, md(9, 2), md(9, 6));
    await expectNoChange(
      `${tr2(md(9, 1), md(9, 6))} rezervasyonu ${tr2(md(9, 10), md(9, 15))} olarak değiştirildi.`,
      "partial",
    );
    expect(await rowOf(id)).toMatchObject({ check_in: md(9, 2), check_out: md(9, 6) });
  });

  it("yeni tarihler başka bir kayıtla veya harici takvimle çakışıyorsa işlem yok (⚠️ occupied)", async () => {
    const id = await reservationAt(mavi, md(9, 20), md(9, 24));
    const other = await reservationAt(mavi, md(9, 26), md(9, 28));
    await expectNoChange(
      `${tr2(md(9, 20), md(9, 24))} rezervasyonu ${tr2(md(9, 22), md(9, 27))} olarak değiştirildi.`,
      "occupied",
    );
    await externalAt(mavi, md(10, 5), md(10, 8));
    await expectNoChange(
      `${tr2(md(9, 20), md(9, 24))} rezervasyonu ${tr2(md(10, 3), md(10, 7))} olarak değiştirildi.`,
      "occupied",
    );
    expect(await rowOf(id)).toMatchObject({ check_in: md(9, 20), check_out: md(9, 24) });
    expect(await statusOf(other)).toBe("confirmed");
  });

  it("Airbnb/Booking kaynaklı rezervasyon taşınmaz (⚠️ external); iCal olayı hedef olamaz", async () => {
    const air = await reservationAt(mavi, md(10, 12), md(10, 15), "airbnb");
    await expectNoChange(
      `${tr2(md(10, 12), md(10, 15))} rezervasyonu ${tr2(md(10, 16), md(10, 19))} olarak değiştirildi.`,
      "external",
    );
    expect(await rowOf(air)).toMatchObject({ check_in: md(10, 12), source: "airbnb" });
    const book = await reservationAt(mavi, md(10, 20), md(10, 23), "booking");
    await expectNoChange(
      `${tr2(md(10, 20), md(10, 23))} rezervasyonu ${tr2(md(10, 24), md(10, 27))} olarak değiştirildi.`,
      "external",
    );
    expect(await statusOf(book)).toBe("confirmed");
    // Yalnız harici (iCal) olay: kayıt yok sayılır; olay değişmez.
    await externalAt(mavi, md(11, 1), md(11, 4));
    await expectNoChange(
      `${tr2(md(11, 1), md(11, 4))} rezervasyonu ${tr2(md(11, 6), md(11, 9))} olarak değiştirildi.`,
      "no_target",
    );
  });

  it("başka villanın aynı tarihli kaydı etkilenmez (grubun villası esas)", async () => {
    const other = await reservationAt(asya, md(1, 12), md(1, 15));
    await expectNoChange(
      `Villa Asya ${tr2(md(1, 12), md(1, 15))} rezervasyonu ${tr2(md(1, 16), md(1, 19))} olarak değiştirildi.`,
      "no_target",
    );
    expect(await rowOf(other)).toMatchObject({ check_in: md(1, 12), check_out: md(1, 15) });
  });

  it("olumsuz tarih değiştirme mesajı: öneri, tepki ve değişiklik yok", async () => {
    const id = await reservationAt(mavi, md(4, 2), md(4, 6));
    const before = await calendarDigest();
    for (const body of [
      `${tr2(md(4, 2), md(4, 6))} rezervasyonunu ${tr2(md(4, 8), md(4, 12))} olarak değiştirmeyelim.`,
      `${tr2(md(4, 2), md(4, 6))} rezervasyonu ${tr2(md(4, 8), md(4, 12))}'ye değiştirilmedi.`,
    ]) {
      const r = await send(body, { pn: PN_STRANGER });
      expect(r.proposals).toHaveLength(0);
      expect(await reactionOf(r.message!.id)).toEqual([]);
    }
    expect(await calendarDigest()).toEqual(before);
    expect(await rowOf(id)).toMatchObject({ check_in: md(4, 2) });
  });

  it("aynı mesaj iki kez işlenmez; servis tekrar çağrılsa da ikinci değişiklik olmaz", async () => {
    const [a, b, na, nb] = [md(5, 2), md(5, 6), md(5, 8), md(5, 12)];
    const id = await reservationAt(mavi, a, b);
    const body = `${tr2(a, b)} tarihleri ${tr2(na, nb)} olarak değiştirildi.`;
    const r = await send(body);
    expect(r.proposals[0].status).toBe("applied");
    const after = await calendarDigest();
    // Ağ geçidi aynı mesajı yeniden iletirse: kayıt tekrarlanmaz, worker yeniden işlemez.
    await ingestRaw(G.jid, r.mid, body, PN_OWNER);
    const again = await runCalendarWorker(app, deps());
    expect(again.autoChanged).toBe(0);
    // Servis aynı istekle doğrudan çağrılsa da karar verilmiş öneri yeniden işlenmez.
    const res = await autoChange({
      workspaceId: ws,
      userId: O.id,
      messageId: r.message!.id,
      itemNo: 0,
      propertyId: mavi,
      oldCheckIn: a,
      oldCheckOut: b,
      checkIn: na,
      checkOut: nb,
    });
    expect(res).toMatchObject({ outcome: "failed", reason: "changed" });
    expect(await calendarDigest()).toEqual(after);
    expect(await rowOf(id)).toMatchObject({ check_in: na, check_out: nb });
    expect(await reactionOf(r.message!.id)).toEqual([{ kind: "done", emoji: "✅" }]);
  });

  it("işlem atomiktir: tarih yazımı başarısız olursa öneri de uygulanmış olmaz", async () => {
    const [a, b] = [md(6, 20), md(6, 24)];
    const id = await reservationAt(mavi, a, b);
    // Yeni aralığa servis çağrılmadan hemen önce çakışan bir kayıt eklenir (yarış durumu).
    const before = await calendarDigest();
    const r = await send(`${tr2(a, b)} rezervasyonu ${tr2(md(6, 25), md(6, 28))} olarak değişti.`, {
      over: {
        autoChange: async (req) => {
          await blockAt(mavi, md(6, 26), md(6, 27));
          return autoChange(req);
        },
      },
    });
    expect(r.proposals[0].status).toBe("pending");
    expect(await rowOf(id)).toMatchObject({ check_in: a, check_out: b });
    expect((await calendarDigest()).n).toBe(before.n + 1); // yalnız yarıştaki blok
    expect(await reactionOf(r.message!.id)).toEqual([{ kind: "warning", emoji: "⚠️" }]);
  });

  it("belirsiz tarihler: işlem yok (⚠️)", async () => {
    const id = await reservationAt(mavi, md(3, 2), md(3, 6));
    const before = await calendarDigest();
    for (const body of [
      `${tr2(md(3, 2), md(3, 6))} rezervasyonu 2 hafta sonraya alındı.`,
      `${tr2(md(3, 2), md(3, 6))} rezervasyonu ${tr2(md(3, 8), md(3, 12))} ve ${tr2(md(3, 14), md(3, 16))} olarak değişti.`,
    ]) {
      const r = await send(body);
      expect(r.summary.autoChanged).toBe(0);
      expect(await reactionOf(r.message!.id)).toEqual([{ kind: "warning", emoji: "⚠️" }]);
    }
    expect(await calendarDigest()).toEqual(before);
    expect(await rowOf(id)).toMatchObject({ check_in: md(3, 2) });
  });

  it("kapatma ve açma çalışmaya devam eder", async () => {
    const c = await send(`${tr2(md(1, 2), md(1, 5))} kapatalım.`, { pn: PN_STRANGER });
    expect(c.proposals[0]).toMatchObject({ status: "applied", action: "close" });
    const blockId = c.proposals[0].applied_reservation_ids[0] as string;
    const o = await send(`${tr2(md(1, 2), md(1, 5))} tekrar müsait.`, { pn: PN_STRANGER });
    expect(o.proposals[0]).toMatchObject({ status: "applied", action: "open" });
    expect(await statusOf(blockId)).toBe("cancelled");
  });

  it("veritabanı: eski aralık yalnız 'change' için; uygulanmış değiştirmede zorunlu", async () => {
    // Çakışan kapatma önerisi bekler (ilk testin rezervasyonu): bekleyen öneri güncellenebilir.
    const r = await send(`${tr2(md(2, 20), md(2, 22))} kapatalım.`);
    expect(r.proposals[0].status).toBe("pending");
    const id = r.proposals[0].id;
    // Kapatma önerisine eski aralık yazılamaz (kısıt); app_user'ın kolon yetkisi de yok.
    await expect(
      admin.query(
        "update wa_calendar_proposals set old_check_in = $2, old_check_out = $3 where id = $1",
        [id, md(2, 1), md(2, 3)],
      ),
    ).rejects.toThrow(/wa_calendar_proposals_old_dates/);
    await expect(
      appPool.query("update wa_calendar_proposals set old_check_in = null where id = $1", [id]),
    ).rejects.toThrow(/permission denied/);
    const def = await admin.query(
      "select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'wa_calendar_proposals_quick_only_close'",
    );
    expect(def.rows[0].d).toContain("'change'::text");
  });

  it("log'da mesaj metni, villa adı ve numara yok", () => {
    const all = logLines.join("\n");
    expect(all).not.toMatch(/rezervasyon|Mavi|Asya|905321/i);
    expect(all).toContain("wa_calendar_auto_change");
  });
});
