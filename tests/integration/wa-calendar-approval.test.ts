import { createHash, randomBytes } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { DB_CASING } from "@/db/casing";
import * as schema from "@/db/schema";
import { type TenantContext, type Tx, withTenant } from "@/db/tenant";
import { isAppError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { addDays, istanbulToday } from "@/lib/reservation-meta";
import { createProperty } from "@/server/properties/service";
import { runCalendarWorker } from "@/server/whatsapp/calendar/worker";
import {
  approvalDefaults,
  approveProposal,
  countPendingProposals,
  getProposal,
  listProposals,
  proposalConflicts,
  rejectProposal,
} from "@/server/whatsapp/proposals";
import { addWorkspaceMember, createWorkspace } from "@/server/workspaces/service";

/**
 * WhatsApp Asistanı — uçtan uca zincir (A2d): gruba yazılan mesaj → ağ geçidi kaydı
 * (app_wa_ingest_message, ağ geçidinin çağırdığı fonksiyon) → worker (gerçek runCalendarWorker)
 * → öneri → panel servisi (listele / onayla / reddet). Gerçek PostgreSQL 17, app_user, FORCE RLS.
 *
 * Doğrulananlar: rezervasyon YALNIZ onayla oluşur (kaynak whatsapp, origin_proposal_id); aynı
 * mesajın yeniden teslimi ikinci öneri üretmez; çakışmada hiçbir şey yazılmaz ve öneri bekler;
 * eski sürüm, personel ve başka işletme reddedilir; kapatma → blok; açma panelden uygulanmaz;
 * ret takvimi değiştirmez; karar verilmiş öneri yeniden karara bağlanamaz.
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 6 });
const app = drizzle(appPool, { schema, casing: DB_CASING });
const admin = new Client({ connectionString: db.adminUrl });
const tag = randomBytes(3).toString("hex");
const log = createLogger({ service: "wa-approval-test" }, () => {});

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

const PN_OWNER = "905321440001";
const PN_MANAGER = "905321440002";
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

let O: U, M: U, S: U, X: U;
let ws: string, wsX: string;
let mavi: string, asya: string;
let conn: string;
let G: { id: string; jid: string };
const planCode = `wa_apr_${tag}`;

let msgN = 0;
async function ingestRaw(jid: string, mid: string, body: string, pn: string) {
  const out = await appPool.query<{ s: string }>(
    "select public.app_wa_ingest_message($1, $2, $3, '1@lid', $4, null, $5, now(), 'live') as s",
    [conn, jid, mid, pn, body],
  );
  return out.rows[0]!.s;
}
/** Mesajı ağ geçidi gibi kaydeder, worker'ı çalıştırır ve mesajın önerilerini döndürür. */
async function send(body: string, pn = PN_OWNER) {
  const mid = `A${tag}${++msgN}`;
  expect(await ingestRaw(G.jid, mid, body, pn)).toBe("stored");
  await runCalendarWorker(app, { log });
  const m = await admin.query<{ id: string; status: string }>(
    "select id, status from wa_inbound_messages where wa_message_id = $1",
    [mid],
  );
  expect(m.rows[0]!.status).toBe("processed");
  const props = await admin.query<{ id: string }>(
    "select id from wa_calendar_proposals where message_id = $1 order by item_no",
    [m.rows[0]!.id],
  );
  return { mid, messageId: m.rows[0]!.id, proposalIds: props.rows.map((r) => r.id) };
}

const reservationCount = async () =>
  (await admin.query("select count(*)::int n from reservations where workspace_id = $1", [ws]))
    .rows[0].n as number;
const proposalRow = async (id: string) =>
  (await admin.query("select * from wa_calendar_proposals where id = $1", [id])).rows[0];

async function expectCode(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `beklenen hata: ${code}`).not.toBeNull();
  expect(isAppError(err) ? err.code : String(err)).toBe(code);
  return err;
}

async function villa(name: string, maxGuests = "6") {
  return as(O, ws, (tx, ctx) =>
    createProperty(tx, ctx, {
      name,
      propertyType: "villa",
      maxGuests,
      bedrooms: "3",
      bathrooms: "2",
      province: "Antalya",
      district: "Kaş",
    }),
  );
}

beforeAll(async () => {
  await admin.connect();
  O = await mkUser("waao");
  M = await mkUser("waam");
  S = await mkUser("waas");
  X = await mkUser("waax");
  ws = (await createWorkspace(app, { userId: O.id, name: "Onay", slug: `waa-${tag}` })).id;
  wsX = (await createWorkspace(app, { userId: X.id, name: "Diğer", slug: `waax-${tag}` })).id;
  const planId = uuidv7();
  await admin.query(
    "insert into plans (id, code, name, max_properties, trial_days, is_active, is_default) values ($1, $2, 'WA apr', 20, 14, true, false)",
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
      `waa-${tag}`,
    ])
  ).rows[0]!.id;
  for (const [u, pn] of [
    [O, PN_OWNER],
    [M, PN_MANAGER],
  ] as const) {
    await admin.query(
      "insert into wa_verified_phones (user_id, phone_hash, phone_masked) values ($1, $2, '+90 532 *** ** 01')",
      [u.id, phoneHash(pn)],
    );
  }
  const jid = `120365${randomBytes(4).readUInt32BE() % 10_000_000}${String(Date.now()).slice(-5)}@g.us`;
  await appPool.query("select public.app_wa_sync_group($1, $2, 'Ekip', 4, false, false, true)", [
    conn,
    jid,
  ]);
  const gid = (await admin.query("select id from wa_groups where jid = $1", [jid])).rows[0].id;
  await admin.query(
    "update wa_groups set status = 'linked', workspace_id = $2, property_id = $3, linked_at = now() where id = $1",
    [gid, ws, mavi],
  );
  G = { id: gid, jid };
  // Worker'ın ilk aktivasyonu (aktivasyon öncesi mesajlar işlenmez); bu dosyanın mesajları sonra.
  await runCalendarWorker(app, { log });
});

afterAll(async () => {
  // Diğer test dosyaları kuyruğu boş varsayar: bu dosyanın mesajları silinir.
  await admin.query("delete from wa_inbound_messages where workspace_id = $1", [ws]);
  await admin.query(
    "update workspace_subscriptions set plan_id = (select id from plans where is_default) where workspace_id = $1",
    [ws],
  );
  await admin.query("delete from plans where code = $1", [planCode]);
  await admin.end();
  await appPool.end();
});

describe("uçtan uca: WhatsApp mesajı → öneri → yönetici onayı → rezervasyon", () => {
  let proposalId: string;
  let reservationId: string;

  it("mesaj kaydedilir, ayrıştırılır, grubun villasıyla eşleşir ve onaya sunulur; takvim değişmez", async () => {
    const before = await reservationCount();
    const body = `Villa ${tr(day(20))} giriş, ${tr(day(23))} çıkış, 4 kişi.`;
    const { proposalIds } = await send(body);
    expect(proposalIds).toHaveLength(1);
    proposalId = proposalIds[0]!;
    expect(await reservationCount()).toBe(before);

    const list = await as(O, ws, (tx, ctx) => listProposals(tx, ctx, "pending"));
    const p = list.find((x) => x.id === proposalId)!;
    expect(p).toBeDefined();
    expect(p).toMatchObject({
      status: "pending",
      action: "reserve",
      propertyId: mavi,
      propertyName: "Villa Mavi",
      villaResolution: "single",
      checkIn: day(20),
      checkOut: day(23),
      senderRole: "owner",
      groupSubject: "Ekip",
    });
    expect(p.guests.total).toBe(4);
    expect(p.reviewReasons).toContain("action_requires_review");
    expect(approvalDefaults(p)).toMatchObject({
      propertyId: mavi,
      checkIn: day(20),
      checkOut: day(23),
      adults: 4,
      children: 0,
      status: "confirmed",
    });
    expect(await as(M, ws, (tx, ctx) => countPendingProposals(tx, ctx))).toBeGreaterThanOrEqual(1);
    const c = await as(O, ws, (tx) => proposalConflicts(tx, mavi, day(20), day(23)));
    expect(c).toEqual({ internal: [], external: [] });
  });

  it("aynı mesajın yeniden teslimi ikinci öneri üretmez", async () => {
    const mid = `A${tag}${msgN}`; // son gönderilen mesaj
    expect(await ingestRaw(G.jid, mid, "tekrar", PN_OWNER)).toBe("duplicate");
    await runCalendarWorker(app, { log });
    const n = await admin.query(
      "select count(*)::int n from wa_calendar_proposals where workspace_id = $1 and check_in = $2",
      [ws, day(20)],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it("personel ve başka işletme öneriyi göremez ve karar veremez", async () => {
    await expectCode(
      as(S, ws, (tx, ctx) => listProposals(tx, ctx)),
      "FORBIDDEN",
    );
    await expectCode(
      as(S, ws, (tx, ctx) =>
        approveProposal(tx, ctx, proposalId, {
          version: 1,
          propertyId: mavi,
          checkIn: day(20),
          checkOut: day(23),
          guestName: "Ayşe Deneme",
          adults: "4",
        }),
      ),
      "FORBIDDEN",
    );
    expect(await as(S, ws, (tx, ctx) => countPendingProposals(tx, ctx))).toBe(0);
    await expectCode(
      as(X, wsX, (tx, ctx) => getProposal(tx, ctx, proposalId)),
      "NOT_FOUND",
    );
    await expectCode(
      as(X, wsX, (tx, ctx) => rejectProposal(tx, ctx, proposalId, { version: 1 })),
      "NOT_FOUND",
    );
    expect((await proposalRow(proposalId)).status).toBe("pending");
  });

  it("eski sürümle onay reddedilir; hiçbir şey yazılmaz", async () => {
    const before = await reservationCount();
    const v = Number((await proposalRow(proposalId)).version);
    await expectCode(
      as(M, ws, (tx, ctx) =>
        approveProposal(tx, ctx, proposalId, {
          version: v + 5,
          propertyId: mavi,
          checkIn: day(20),
          checkOut: day(23),
          guestName: "Ayşe Deneme",
          adults: "4",
        }),
      ),
      "CONFLICT",
    );
    expect(await reservationCount()).toBe(before);
    expect((await proposalRow(proposalId)).status).toBe("pending");
  });

  it("eksik misafir adı alan hatası verir; hiçbir şey yazılmaz", async () => {
    const before = await reservationCount();
    const v = Number((await proposalRow(proposalId)).version);
    const err = await expectCode(
      as(M, ws, (tx, ctx) =>
        approveProposal(tx, ctx, proposalId, {
          version: v,
          propertyId: mavi,
          checkIn: day(20),
          checkOut: day(23),
          guestName: "",
          adults: "4",
        }),
      ),
      "VALIDATION",
    );
    expect(err).toHaveProperty("fieldErrors.guestName");
    expect(await reservationCount()).toBe(before);
    expect((await proposalRow(proposalId)).status).toBe("pending");
  });

  it("yönetici onaylar: rezervasyon oluşur (whatsapp, origin_proposal_id), öneri 'applied'", async () => {
    const before = await reservationCount();
    const p = await as(M, ws, (tx, ctx) => getProposal(tx, ctx, proposalId));
    const r = await as(M, ws, (tx, ctx) =>
      approveProposal(tx, ctx, proposalId, {
        version: p.version,
        propertyId: mavi,
        checkIn: day(20),
        checkOut: day(23),
        guestName: "Ayşe Deneme",
        adults: "3",
        children: "1",
        status: "confirmed",
      }),
    );
    reservationId = r.reservationId;
    expect(await reservationCount()).toBe(before + 1);
    const res = (await admin.query("select * from reservations where id = $1", [reservationId]))
      .rows[0];
    expect(res).toMatchObject({
      kind: "reservation",
      status: "confirmed",
      source: "whatsapp",
      property_id: mavi,
      origin_proposal_id: proposalId,
      guest_name: "Ayşe Deneme",
      adults: 3,
      children: 1,
    });
    const row = await proposalRow(proposalId);
    expect(row).toMatchObject({
      status: "applied",
      decided_by: M.id,
      decision_mode: "reviewed",
      edited: false,
    });
    expect(row.applied_reservation_ids).toEqual([reservationId]);
    expect(row.decision_reasons).toContain("action_requires_review");
    const audit = await admin.query(
      "select action, metadata from audit_log where target_id = $1 and action = 'whatsapp.proposal_applied'",
      [proposalId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata).toEqual({
      property: mavi,
      action: "reserve",
      reservation: reservationId,
      edited: false,
    });
  });

  it("karar verilmiş öneri yeniden onaylanamaz veya reddedilemez", async () => {
    const v = Number((await proposalRow(proposalId)).version);
    await expectCode(
      as(O, ws, (tx, ctx) =>
        approveProposal(tx, ctx, proposalId, {
          version: v,
          propertyId: mavi,
          checkIn: day(20),
          checkOut: day(23),
          guestName: "Ayşe Deneme",
          adults: "4",
        }),
      ),
      "CONFLICT",
    );
    await expectCode(
      as(O, ws, (tx, ctx) => rejectProposal(tx, ctx, proposalId, { version: v })),
      "CONFLICT",
    );
    const decided = await as(O, ws, (tx, ctx) => listProposals(tx, ctx, "decided"));
    expect(decided.find((x) => x.id === proposalId)?.appliedReservationIds).toEqual([
      reservationId,
    ]);
  });

  it("çakışan öneri: panel çakışmayı gösterir; onay reddedilir, hiçbir şey yazılmaz, öneri bekler", async () => {
    const { proposalIds } = await send(
      `Villa ${tr(day(21))} giriş ${tr(day(25))} çıkış rezervasyon 2 kişi`,
      PN_MANAGER,
    );
    expect(proposalIds).toHaveLength(1);
    const id = proposalIds[0]!;
    const p = await as(O, ws, (tx, ctx) => getProposal(tx, ctx, id));
    expect(p.reviewReasons).toContain("conflict");
    expect(p.senderRole).toBe("manager");
    const c = await as(O, ws, (tx) => proposalConflicts(tx, mavi, day(21), day(25)));
    expect(c.internal.map((x) => x.id)).toEqual([reservationId]);

    const before = await reservationCount();
    await expectCode(
      as(O, ws, (tx, ctx) =>
        approveProposal(tx, ctx, id, {
          version: p.version,
          propertyId: mavi,
          checkIn: day(21),
          checkOut: day(25),
          guestName: "Mehmet Deneme",
          adults: "2",
        }),
      ),
      "CONFLICT",
    );
    expect(await reservationCount()).toBe(before);
    const row = await proposalRow(id);
    expect(row.status).toBe("pending");
    expect(Number(row.version)).toBe(p.version);

    // Yönetici villayı düzeltir: başka villada boş → onaylanır, "edited" işaretlenir.
    const r = await as(O, ws, (tx, ctx) =>
      approveProposal(tx, ctx, id, {
        version: p.version,
        propertyId: asya,
        checkIn: day(21),
        checkOut: day(25),
        guestName: "Mehmet Deneme",
        adults: "2",
      }),
    );
    const after = await proposalRow(id);
    expect(after).toMatchObject({ status: "applied", edited: true, property_id: asya });
    expect(after.applied_reservation_ids).toEqual([r.reservationId]);
  });

  it("kapatma önerisi onaylanınca blok oluşur", async () => {
    const { proposalIds } = await send(`Villa Mavi ${tr(day(40))} - ${tr(day(44))} kapalı`);
    expect(proposalIds).toHaveLength(1);
    const p = await as(O, ws, (tx, ctx) => getProposal(tx, ctx, proposalIds[0]!));
    expect(p.action).toBe("close");
    const d = approvalDefaults(p);
    const r = await as(O, ws, (tx, ctx) =>
      approveProposal(tx, ctx, p.id, { version: p.version, ...d }),
    );
    const res = (await admin.query("select * from reservations where id = $1", [r.reservationId]))
      .rows[0];
    expect(res).toMatchObject({
      kind: "block",
      source: null,
      guest_name: null,
      property_id: mavi,
      origin_proposal_id: p.id,
    });
    expect((await proposalRow(p.id)).reservation_status).toBeNull();
  });

  it("açma önerisi panelden uygulanmaz; reddedilir ve takvim değişmez", async () => {
    const { proposalIds } = await send(`Villa Mavi ${tr(day(50))} - ${tr(day(52))} açıldı`);
    expect(proposalIds).toHaveLength(1);
    const p = await as(O, ws, (tx, ctx) => getProposal(tx, ctx, proposalIds[0]!));
    expect(p.action).toBe("open");
    const before = await reservationCount();
    await expectCode(
      as(O, ws, (tx, ctx) =>
        approveProposal(tx, ctx, p.id, {
          version: p.version,
          propertyId: mavi,
          checkIn: day(50),
          checkOut: day(52),
        }),
      ),
      "CONFLICT",
    );
    await as(O, ws, (tx, ctx) =>
      rejectProposal(tx, ctx, p.id, { version: p.version, note: "Takvimde elle açıldı." }),
    );
    expect(await reservationCount()).toBe(before);
    const row = await proposalRow(p.id);
    expect(row).toMatchObject({
      status: "rejected",
      decided_by: O.id,
      decision_mode: null,
      decision_note: "Takvimde elle açıldı.",
    });
    expect(row.applied_reservation_ids).toEqual([]);
  });

  it("onaylanmamış hiçbir öneri rezervasyona dönüşmez", async () => {
    const orphan = await admin.query(
      `select count(*)::int n from reservations r
         where r.workspace_id = $1 and r.origin_proposal_id is not null
           and not exists (select 1 from wa_calendar_proposals p
                            where p.id = r.origin_proposal_id and p.status = 'applied'
                              and r.id = any(p.applied_reservation_ids))`,
      [ws],
    );
    expect(orphan.rows[0].n).toBe(0);
  });
});
