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
import { createReservation, listCalendarEntries } from "@/server/reservations/service";
import { createAutoCloser, WA_AUTO_CLOSE_NOTE } from "@/server/whatsapp/auto-close";
import { runCalendarWorker, type WorkerDeps } from "@/server/whatsapp/calendar/worker";
import { getProposal, listProposals } from "@/server/whatsapp/proposals";
import { addWorkspaceMember, createWorkspace } from "@/server/workspaces/service";

import { adminBlockSender, adminSetActive, adminUnblockSender, createTestAdmin } from "./wa-admin";

/**
 * WhatsApp Asistanı A2e — işletme sahibinin açık kapatma talimatı takvime OTOMATİK blok olarak
 * işlenir (drizzle/0038 + src/server/whatsapp/auto-close.ts). Gerçek PostgreSQL 17, app_user,
 * FORCE RLS; mesaj ağ geçidinin çağırdığı fonksiyonla kaydedilir, worker gerçek kodla ve üretimdeki
 * gibi createAutoCloser ile çalışır.
 *
 * B aşaması: bağlı ve aktif grubun Super Admin tarafından engellenmemiş HER katılımcısı (sahip,
 * yönetici, personel, numarası hiç doğrulanmamış kişi) kapatma talimatı verebilir; blok işletme
 * SAHİBİ adına oluşur, gerçek gönderen önerinin sender_hash / sender_role alanlarında kalır.
 *
 * Güvenlik: yetkili katılımcı + grubun villası + iki net tarih + açık kapatma + çakışma yok → blok.
 * Diğer her durumda (eşleştirilmemiş / pasif / villasız grup, engelli veya numarası belirlenemeyen
 * gönderen, belirsiz tarih, soru, çakışma, rezervasyon, açma) blok OLUŞMAZ. Aynı mesaj ikinci blok
 * üretmez. Başarısızlıkta takvim değişmez.
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 6 });
const app = drizzle(appPool, { schema, casing: DB_CASING });
const admin = new Client({ connectionString: db.adminUrl });
const tag = randomBytes(3).toString("hex");
const logLines: string[] = [];
const log = createLogger({ service: "wa-auto-close-test" }, (l) => logLines.push(l));
const autoClose = createAutoCloser(app);
const deps = (over: WorkerDeps = {}): WorkerDeps => ({ log, autoClose, ...over });

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

const PN_OWNER = "905321550001";
const PN_MANAGER = "905321550002";
const PN_STAFF = "905321550003";
const PN_STRANGER = "905321550009";
const PN_STRANGER2 = "905321550010";
const PN_BLOCKED = "905321550008";

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
const planCode = `wa_auto_${tag}`;

let jidN = 0;
const jidBase = BigInt(`0x${randomBytes(4).toString("hex")}`) % 10_000_000n;
const newJid = () =>
  `120366${String(jidBase).padStart(7, "0")}${String(++jidN).padStart(5, "0")}@g.us`;

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

const blocks = async () =>
  (
    await admin.query(
      "select * from reservations where workspace_id = $1 and kind = 'block' order by check_in",
      [ws],
    )
  ).rows;
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
  O = await mkUser("waco");
  M = await mkUser("wacm");
  S = await mkUser("wacs");
  ws = (await createWorkspace(app, { userId: O.id, name: "Oto", slug: `wac-${tag}` })).id;
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

describe("otomatik kapatma: yetkili sahibin açık talimatı", () => {
  let firstMid: string;
  let firstBlock: string;

  it("1. sahibin net tarihli kapatma mesajı doğrudan blok oluşturur (panel onayı yok)", async () => {
    const r = await send(`Villa Mavi ${tr(day(30))}–${tr(day(35))} kapatalım.`);
    firstMid = r.mid;
    expect(r.ingest).toBe("stored");
    expect(r.message!.status).toBe("processed");
    expect(r.summary.autoClosed).toBe(1);
    expect(r.proposals).toHaveLength(1);
    const p = r.proposals[0];
    expect(p).toMatchObject({
      status: "applied",
      action: "close",
      decision_mode: "quick",
      decided_by: O.id,
      property_id: mavi,
      sender_role: "owner",
      decision_note: WA_AUTO_CLOSE_NOTE,
    });
    expect(p.review_reasons).toEqual([]);
    const b = (await blocks()).filter((x) => x.origin_proposal_id === p.id);
    expect(b).toHaveLength(1);
    firstBlock = b[0].id;
    expect(p.applied_reservation_ids).toEqual([firstBlock]);
    expect(b[0]).toMatchObject({
      kind: "block",
      status: "confirmed",
      property_id: mavi,
      source: null,
      guest_name: null,
      created_by: O.id,
      note: WA_AUTO_CLOSE_NOTE,
    });
    const audit = await admin.query(
      "select action, actor_user_id, metadata from audit_log where target_id = $1 order by id",
      [p.id],
    );
    expect(audit.rows.map((a) => a.action)).toEqual(["whatsapp.proposal_auto_applied"]);
    expect(audit.rows[0].actor_user_id).toBe(O.id);
    expect(audit.rows[0].metadata).toEqual({
      property: mavi,
      reservation: firstBlock,
      group: G.id,
      sender_role: "owner",
    });
  });

  it("2. blok takvimde görünür; panelde 'otomatik uygulandı' olarak listelenir", async () => {
    const entries = await as(O, ws, (tx) => listCalendarEntries(tx, mavi, day(28), day(40)));
    const e = entries.find((x) => x.id === firstBlock);
    expect(e).toMatchObject({ kind: "block", checkIn: day(30), checkOut: day(35) });
    const decided = await as(O, ws, (tx, ctx) => listProposals(tx, ctx, "decided"));
    const p = decided.find((x) => x.appliedReservationIds[0] === firstBlock);
    expect(p).toMatchObject({ decisionMode: "quick", status: "applied", autoFailure: null });
    const pending = await as(O, ws, (tx, ctx) => listProposals(tx, ctx, "pending"));
    expect(pending.find((x) => x.id === p!.id)).toBeUndefined();
  });

  it("3. aynı mesaj tekrar gelirse ikinci blok oluşmaz (idempotent)", async () => {
    const before = await calendarDigest();
    expect(await ingestRaw(G.jid, firstMid, "tekrar", PN_OWNER)).toBe("duplicate");
    await runCalendarWorker(app, deps());
    expect(await calendarDigest()).toEqual(before);
    // Otomatik kapatma servisi aynı öğe için yeniden çağrılsa bile (ör. yarıda kalan çalıştırma)
    // karar verilmiş öneri yeniden işlenmez.
    const msgId = (
      await admin.query("select id from wa_inbound_messages where wa_message_id = $1", [firstMid])
    ).rows[0].id;
    const again = await autoClose({
      workspaceId: ws,
      userId: O.id,
      messageId: msgId,
      itemNo: 0,
      propertyId: mavi,
      checkIn: day(30),
      checkOut: day(35),
    });
    expect(again).toMatchObject({ outcome: "failed", reason: "changed" });
    expect(await calendarDigest()).toEqual(before);
  });

  it("'… giriş, … çıkış tarihine kadar villayı kapat' (villa adı yok: grubun villası) blok oluşturur", async () => {
    const r = await send(
      `${tr(day(50))} giriş, ${tr(day(53))} çıkış tarihine kadar villayı kapat.`,
    );
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0]).toMatchObject({
      status: "applied",
      action: "close",
      villa_resolution: "single",
      decision_mode: "quick",
    });
    const b = (await blocks()).filter((x) => x.origin_proposal_id === r.proposals[0].id);
    expect(b).toHaveLength(1);
  });
});

describe("grup eşleştirmesi kesin kaynak: mesajdaki villa adı önemsiz", () => {
  const asyaEntries = () =>
    admin.query(
      "select count(*)::int n from reservations where workspace_id = $1 and property_id = $2",
      [ws, asya],
    );

  it("mesajdaki ad farklı (ör. grubun adı 'Villa Testo'): grubun villası bloklanır; panelde gerçek villa", async () => {
    const asyaBefore = (await asyaEntries()).rows[0].n;
    const r = await send(`Villa Testo ${tr(day(160))}–${tr(day(163))} kapatalım.`);
    const p = r.proposals[0];
    expect(p).toMatchObject({
      status: "applied",
      decision_mode: "quick",
      property_id: mavi,
      villa_resolution: "single",
      villa_name_raw: "Testo",
    });
    expect(p.flags).toContain("villa_name_mismatch");
    expect(p.review_reasons).toEqual([]);
    const b = (await blocks()).filter((x) => x.origin_proposal_id === p.id);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ property_id: mavi, kind: "block" });
    expect((await asyaEntries()).rows[0].n).toBe(asyaBefore);
    const view = await as(O, ws, (tx, ctx) => getProposal(tx, ctx, p.id));
    expect([view.propertyId, view.propertyName]).toEqual([mavi, "Villa Mavi"]);
  });

  it("başka bir villanın adı yazılsa bile grubun villası bloklanır; o villa değişmez", async () => {
    const asyaBefore = (await asyaEntries()).rows[0].n;
    const r = await send(`Villa Asya ${tr(day(170))}–${tr(day(172))} kapatalım.`);
    const p = r.proposals[0];
    expect(p).toMatchObject({ status: "applied", property_id: mavi, villa_resolution: "single" });
    expect(p.flags).toContain("villa_name_mismatch");
    expect((await blocks()).filter((x) => x.origin_proposal_id === p.id)).toHaveLength(1);
    expect((await asyaEntries()).rows[0].n).toBe(asyaBefore);
  });

  it("farklı adlı mesajı sahip olmayan katılımcı (yönetici) yazsa da grubun villası bloklanır", async () => {
    const r = await send(`Villa Testo ${tr(day(175))}–${tr(day(177))} kapatalım.`, {
      pn: PN_MANAGER,
    });
    expect(r.proposals[0]).toMatchObject({
      status: "applied",
      property_id: mavi,
      sender_role: "manager",
      decided_by: O.id,
    });
  });

  it("rezervasyon mesajı farklı adla da yönetici onayına düşer (villa = grubun villası)", async () => {
    const before = await calendarDigest();
    const r = await send(
      `Villa Testo ${tr(day(180))} giriş, ${tr(day(184))} çıkış, 4 kişi rezervasyon.`,
    );
    expect(r.proposals[0]).toMatchObject({
      status: "pending",
      action: "reserve",
      property_id: mavi,
    });
    expect(r.proposals[0].review_reasons).toContain("action_requires_review");
    expect(await calendarDigest()).toEqual(before);
  });
});

describe("otomatik kapatma yapılmayan durumlar (takvim değişmez)", () => {
  it("4. eşleştirilmemiş grup: mesaj kaydedilmez, blok yok", async () => {
    const before = await calendarDigest();
    const unlinked = await group("discovered", null);
    const r = await send(`Villa Mavi ${tr(day(60))}–${tr(day(62))} kapatalım.`, {
      jid: unlinked.jid,
    });
    expect(r.ingest).toBe("ignored");
    expect(r.proposals).toHaveLength(0);
    expect(await calendarDigest()).toEqual(before);
  });

  it("4b. bağlı ama villası seçilmemiş grup: mesaj işlenmez (group_without_villa), blok yok", async () => {
    const before = await calendarDigest();
    const noVilla = await group("linked", null);
    const r = await send(`Villa Mavi ${tr(day(60))}–${tr(day(62))} kapatalım.`, {
      jid: noVilla.jid,
    });
    expect(r.message).toMatchObject({ status: "ignored", last_error: "group_without_villa" });
    expect(r.proposals).toHaveLength(0);
    expect(r.summary.autoClosed).toBe(0);
    expect(await calendarDigest()).toEqual(before);
  });

  it("5. engelli gönderen ve numarası belirlenemeyen gönderen → yok sayılır, blok yok", async () => {
    const before = await calendarDigest();
    const adminId = await createTestAdmin(admin, `ac5${tag}`);
    expect(await adminBlockSender(admin, adminId, PN_BLOCKED, null)).toBe("blocked");
    const blocked = await send(`Villa Mavi ${tr(day(64))}–${tr(day(66))} kapatalım.`, {
      pn: PN_BLOCKED,
    });
    expect(blocked.message).toMatchObject({ status: "ignored", last_error: "sender_blocked" });
    expect(blocked.proposals).toHaveLength(0);
    expect(await calendarDigest()).toEqual(before);
  });

  it("6. eksik / belirsiz tarih ve soru cümlesi blok oluşturmaz", async () => {
    const before = await calendarDigest();
    for (const body of [
      `Villa Mavi ${tr(day(80))} kapatalım`,
      `Villa Mavi kapatalım`,
      `Villa Mavi ${tr(day(80))}–${tr(day(82))} kapatalım mı?`,
      `Villa Mavi ${tr(day(80))}–${tr(day(82))} kapatalım, ${tr(day(90))}–${tr(day(92))} kapalı`,
    ]) {
      const r = await send(body);
      // Bekler (pending) veya işlem yok (noop: soru); asla uygulanmaz.
      for (const p of r.proposals) expect([body, p.status === "applied"]).toEqual([body, false]);
      expect(r.summary.autoClosed).toBe(0);
    }
    expect(await calendarDigest()).toEqual(before);
  });

  it("7. mevcut rezervasyonla çakışma varsa blok oluşmaz; öneri çakışma nedeniyle bekler", async () => {
    const resId = await as(O, ws, (tx, ctx) =>
      createReservation(tx, ctx, {
        kind: "reservation",
        propertyId: mavi,
        checkIn: day(100),
        checkOut: day(104),
        status: "confirmed",
        source: "phone",
        guestName: "Mevcut Misafir",
        adults: "2",
        children: "0",
      }),
    );
    const before = await calendarDigest();
    const r = await send(`Villa Mavi ${tr(day(102))}–${tr(day(106))} kapatalım.`);
    expect(r.proposals[0].status).toBe("pending");
    expect(r.proposals[0].review_reasons).toContain("conflict");
    expect(r.proposals[0].conflicts.map((c: { record_id: string }) => c.record_id)).toEqual([
      resId,
    ]);
    expect(await calendarDigest()).toEqual(before);
  });

  it("7b. öneri ile yazım arasında çakışma oluşursa (yarış) blok yok; panelde 'uygulanamadı' görünür", async () => {
    let raceRes = "";
    const before = await calendarDigest();
    const r = await send(`Villa Mavi ${tr(day(110))}–${tr(day(114))} kapatalım.`, {
      over: {
        // Öneri kaydından hemen önce başka biri aynı tarihlere rezervasyon girer.
        beforeStore: async () => {
          raceRes = await as(M, ws, (tx, ctx) =>
            createReservation(tx, ctx, {
              kind: "reservation",
              propertyId: mavi,
              checkIn: day(111),
              checkOut: day(113),
              status: "pending",
              source: "phone",
              guestName: "Yarış Misafir",
              adults: "2",
              children: "0",
            }),
          );
        },
      },
    });
    expect(r.summary.autoCloseFailed).toBe(1);
    const p = r.proposals[0];
    expect(p.status).toBe("pending");
    // Takvimde yalnız yarışan rezervasyon var; blok yok.
    const after = await admin.query(
      "select id from reservations where workspace_id = $1 and origin_proposal_id = $2",
      [ws, p.id],
    );
    expect(after.rows).toHaveLength(0);
    expect((await calendarDigest()).n).toBe(before.n + 1);
    const view = await as(O, ws, (tx, ctx) => getProposal(tx, ctx, p.id));
    expect(view.autoFailure).toBe("conflict");
    const audit = await admin.query("select action, metadata from audit_log where target_id = $1", [
      p.id,
    ]);
    expect(audit.rows).toEqual([
      { action: "whatsapp.proposal_auto_failed", metadata: { reason: "conflict" } },
    ]);
    expect(raceRes).not.toBe("");
  });

  it("8. rezervasyon mesajı hâlâ yönetici onayına düşer; gerçek rezervasyon oluşmaz", async () => {
    const before = await calendarDigest();
    const r = await send(
      `Villa Mavi ${tr(day(120))} giriş, ${tr(day(125))} çıkış, 4 kişi rezervasyon.`,
    );
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0]).toMatchObject({ status: "pending", action: "reserve" });
    expect(r.proposals[0].review_reasons).toContain("action_requires_review");
    expect(await calendarDigest()).toEqual(before);
  });

  it("9. açma mesajı otomatik işlem yapmaz", async () => {
    const before = await calendarDigest();
    const r = await send(`Villa Mavi ${tr(day(30))}–${tr(day(35))} açıldı`);
    expect(r.proposals[0]).toMatchObject({ status: "pending", action: "open" });
    // v5: iptal bir açma önerisidir; kaldırılacak blok yoksa takvim değişmez.
    const c = await send(`Villa Mavi ${tr(day(36))}–${tr(day(38))} iptal`);
    expect(c.proposals[0]).toMatchObject({ status: "pending", action: "open" });
    expect(await calendarDigest()).toEqual(before);
  });

  it("10. başarısız işlemlerde takvim değişmez: sahiplik düşmüşse (manager) yazılmaz", async () => {
    // Doğrudan servis: gönderen kullanıcı artık owner değil → hiçbir şey yazılmaz.
    const r = await send(`Villa Mavi ${tr(day(140))}–${tr(day(142))} kapatalım.`, {
      over: { autoClose: async () => ({ outcome: "failed", proposalId: null, reason: "error" }) },
    });
    const p = r.proposals[0];
    expect(p.status).toBe("pending");
    const before = await calendarDigest();
    const res = await autoClose({
      workspaceId: ws,
      userId: M.id,
      messageId: r.message!.id,
      itemNo: 0,
      propertyId: mavi,
      checkIn: day(140),
      checkOut: day(142),
    });
    expect(res).toMatchObject({ outcome: "failed", reason: "not_owner" });
    // Değerler öneriyle uyuşmuyorsa (ör. başka tarih) yazılmaz.
    const res2 = await autoClose({
      workspaceId: ws,
      userId: O.id,
      messageId: r.message!.id,
      itemNo: 0,
      propertyId: mavi,
      checkIn: day(140),
      checkOut: day(150),
    });
    expect(res2).toMatchObject({ outcome: "failed", reason: "changed" });
    expect(await calendarDigest()).toEqual(before);
    expect(
      (await admin.query("select status from wa_calendar_proposals where id = $1", [p.id])).rows[0]
        .status,
    ).toBe("pending");
  });

  it("log'da mesaj metni, villa adı ve numara yok", () => {
    const all = logLines.join("\n");
    for (const f of [PN_OWNER, PN_MANAGER, "Villa Mavi", "Mavi", "kapatalım", "Mevcut Misafir"])
      expect([f, all.includes(f)]).toEqual([f, false]);
    expect(all).toContain("wa_calendar_auto_close");
  });
});

describe("B aşaması: bağlı grubun katılımcıları operasyonel komut verebilir", () => {
  const blocksOf = async (proposalId: string) =>
    (await blocks()).filter((x) => x.origin_proposal_id === proposalId);
  let adminId: string;
  beforeAll(async () => {
    adminId = await createTestAdmin(admin, `b${tag}`);
  });

  it("S1. işletme sahibinin kapatma komutu çalışır", async () => {
    const r = await send(`Villa Mavi ${tr(day(200))}–${tr(day(202))} kapatalım.`);
    expect(r.proposals[0]).toMatchObject({ status: "applied", sender_role: "owner" });
    expect(await blocksOf(r.proposals[0].id)).toHaveLength(1);
  });

  it.each([
    ["yönetici", PN_MANAGER, "manager", 204],
    ["personel", PN_STAFF, "staff", 208],
  ] as const)(
    "S2. aynı gruptaki başka bir katılımcının (%s) kapatma komutu çalışır",
    async (_l, pn, role, d0) => {
      const r = await send(`Villa Mavi ${tr(day(d0))}–${tr(day(d0 + 2))} kapatalım.`, {
        pn,
      });
      expect(r.summary.autoClosed).toBe(1);
      expect(r.proposals[0]).toMatchObject({
        status: "applied",
        decision_mode: "quick",
        sender_role: role,
        decided_by: O.id,
      });
      expect(r.proposals[0].review_reasons).toEqual([]);
      const b = await blocksOf(r.proposals[0].id);
      expect(b).toHaveLength(1);
      expect(b[0]).toMatchObject({ kind: "block", property_id: mavi, created_by: O.id });
    },
  );

  it("S3. daha önce doğrulanmamış katılımcının komutu çalışır; gerçek gönderen ve grup kaydedilir", async () => {
    const r = await send(`Villa Mavi ${tr(day(212))}–${tr(day(215))} kapatalım.`, {
      pn: PN_STRANGER,
    });
    expect(r.message!.status).toBe("processed");
    expect(r.summary.autoClosed).toBe(1);
    const p = r.proposals[0];
    expect(p).toMatchObject({
      status: "applied",
      sender_role: "participant",
      sender_verified: false,
      // Gerçek gönderenin WhatsApp kimliği (numara özeti) ve grup; işlem sahibin adına.
      sender_hash: phoneHash(PN_STRANGER),
      group_id: G.id,
      decided_by: O.id,
    });
    const b = await blocksOf(p.id);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ kind: "block", property_id: mavi, created_by: O.id });
    const dates = await admin.query(
      "select check_in::text ci, check_out::text co from reservations where id = $1",
      [b[0].id],
    );
    expect(dates.rows[0]).toEqual({ ci: day(212), co: day(215) });
    const audit = await admin.query(
      "select actor_user_id, metadata from audit_log where target_id = $1 and action = 'whatsapp.proposal_auto_applied'",
      [p.id],
    );
    expect(audit.rows).toEqual([
      {
        actor_user_id: O.id,
        metadata: {
          property: mavi,
          reservation: b[0].id,
          group: G.id,
          sender_role: "participant",
        },
      },
    ]);
    // Katılımcı için ayrı doğrulama/allowlist kaydı oluşmaz.
    const vp = await admin.query("select 1 from wa_verified_phones where phone_hash = $1", [
      phoneHash(PN_STRANGER),
    ]);
    expect(vp.rowCount).toBe(0);
  });

  it("S4. Super Admin'in engellediği katılımcının komutu çalışmaz (grup kapsamı); engel kalkınca çalışır", async () => {
    const before = await calendarDigest();
    expect(await adminBlockSender(admin, adminId, PN_STRANGER2, G.id)).toBe("blocked");
    expect(await adminBlockSender(admin, adminId, PN_STRANGER2, G.id)).toBe("exists");
    const r = await send(`Villa Mavi ${tr(day(220))}–${tr(day(222))} kapatalım.`, {
      pn: PN_STRANGER2,
    });
    expect(r.message).toMatchObject({ status: "ignored", last_error: "sender_blocked" });
    expect(r.proposals).toHaveLength(0);
    expect(r.summary.autoClosed).toBe(0);
    expect(await calendarDigest()).toEqual(before);
    // Engel yalnız bu grupta: başka bağlı gruptaki komutu çalışır.
    const other = await group("linked", asya);
    const o = await send(`Villa Asya ${tr(day(220))}–${tr(day(222))} kapatalım.`, {
      pn: PN_STRANGER2,
      jid: other.jid,
    });
    expect(o.proposals[0]).toMatchObject({ status: "applied", property_id: asya });
    // Engel kalkınca aynı grupta çalışır.
    const id = (
      await admin.query(
        "select id from wa_blocked_senders where phone_hash = $1 and group_id = $2",
        [phoneHash(PN_STRANGER2), G.id],
      )
    ).rows[0].id;
    expect(await adminUnblockSender(admin, adminId, id)).toBe("unblocked");
    const again = await send(`Villa Mavi ${tr(day(224))}–${tr(day(226))} kapatalım.`, {
      pn: PN_STRANGER2,
    });
    expect(again.proposals[0]).toMatchObject({ status: "applied", sender_role: "participant" });
  });

  it("S4b. engel, iş alındıktan sonra eklenirse yazım anında da uygulanır", async () => {
    const before = await calendarDigest();
    const pn = "905321550011";
    const r = await send(`Villa Mavi ${tr(day(228))}–${tr(day(230))} kapatalım.`, {
      pn,
      over: {
        beforeStore: async () => {
          expect(await adminBlockSender(admin, adminId, pn, null)).toBe("blocked");
        },
      },
    });
    expect(r.message).toMatchObject({ status: "ignored", last_error: "sender_blocked" });
    expect(r.proposals).toHaveLength(0);
    expect(await calendarDigest()).toEqual(before);
  });

  it("S5. eşleştirilmemiş grubun komutu çalışmaz", async () => {
    const before = await calendarDigest();
    const unlinked = await group("discovered", null);
    const r = await send(`Villa Mavi ${tr(day(232))}–${tr(day(234))} kapatalım.`, {
      jid: unlinked.jid,
      pn: PN_STRANGER,
    });
    expect(r.ingest).toBe("ignored");
    expect(r.message).toBeUndefined();
    expect(await calendarDigest()).toEqual(before);
  });

  it("S6. pasif gruptan gelen komut çalışmaz (kayıt edilmez; kuyruktakiler de işlenmez)", async () => {
    const before = await calendarDigest();
    const pg = await group("linked", mavi);
    // Kuyruğa girmiş ama henüz işlenmemiş mesaj, grup pasife alınınca işlenmez.
    const mid = `X${tag}susp`;
    expect(
      await ingestRaw(
        pg.jid,
        mid,
        `Villa Mavi ${tr(day(236))}–${tr(day(238))} kapatalım.`,
        PN_STRANGER,
      ),
    ).toBe("stored");
    expect(await adminSetActive(admin, adminId, pg.id, false)).toBe("changed");
    await runCalendarWorker(app, deps());
    const m = (
      await admin.query(
        "select status, last_error from wa_inbound_messages where wa_message_id = $1",
        [mid],
      )
    ).rows[0];
    expect(m).toEqual({ status: "ignored", last_error: "group_not_linked" });
    // Pasif grubun yeni mesajı hiç kaydedilmez.
    const r = await send(`Villa Mavi ${tr(day(236))}–${tr(day(238))} kapatalım.`, {
      jid: pg.jid,
      pn: PN_OWNER,
    });
    expect(r.ingest).toBe("ignored");
    expect(await calendarDigest()).toEqual(before);
  });

  it("S7. aynı mesaj tekrar gelirse (katılımcı) ikinci kez işlem yapılmaz", async () => {
    const r = await send(`Villa Mavi ${tr(day(240))}–${tr(day(242))} kapatalım.`, {
      pn: PN_STRANGER,
    });
    expect(r.proposals[0].status).toBe("applied");
    const before = await calendarDigest();
    expect(await ingestRaw(G.jid, r.mid, "tekrar", PN_STRANGER)).toBe("duplicate");
    await runCalendarWorker(app, deps());
    expect(await calendarDigest()).toEqual(before);
    const n = await admin.query(
      "select count(*)::int n from wa_calendar_proposals where message_id = $1",
      [r.message!.id],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it("S8/S9. başarılı işlemde ✅; ilgisiz mesajda tepki yok", async () => {
    const ok = await send(`Villa Mavi ${tr(day(244))}–${tr(day(246))} kapatalım.`, {
      pn: PN_STRANGER,
    });
    const rx = (
      await admin.query("select kind, emoji from wa_message_reactions where message_id = $1", [
        ok.message!.id,
      ])
    ).rows;
    expect(rx).toEqual([{ kind: "done", emoji: "✅" }]);
    const chat = await send("Günaydın, havuzcu yarın 10'da gelecek", { pn: PN_STRANGER });
    expect(chat.proposals).toHaveLength(0);
    const none = await admin.query("select 1 from wa_message_reactions where message_id = $1", [
      chat.message!.id,
    ]);
    expect(none.rowCount).toBe(0);
  });

  it("anlaşılan ama uygulanamayan (çakışma) talimatta ⚠️; ☑️ hiç kullanılmaz", async () => {
    const r = await send(`Villa Mavi ${tr(day(244))}–${tr(day(246))} kapatalım.`, {
      pn: PN_STRANGER,
    });
    expect(r.proposals[0].status).toBe("pending");
    const rx = (
      await admin.query("select kind, emoji from wa_message_reactions where message_id = $1", [
        r.message!.id,
      ])
    ).rows;
    expect(rx).toEqual([{ kind: "warning", emoji: "⚠️" }]);
    const submitted = await admin.query(
      "select 1 from wa_message_reactions where workspace_id = $1 and kind = 'submitted'",
      [ws],
    );
    expect(submitted.rowCount).toBe(0);
  });

  it("Super Admin engel listesi: numara saklanmaz; yalnız özet ve son 4 hane; geçersiz numara reddedilir", async () => {
    const rows = (
      await admin.query(
        "select phone_hash, phone_hint from wa_blocked_senders where phone_hash = $1",
        [phoneHash(PN_BLOCKED)],
      )
    ).rows;
    expect(rows).toEqual([{ phone_hash: phoneHash(PN_BLOCKED), phone_hint: "0008" }]);
    const all = JSON.stringify((await admin.query("select * from wa_blocked_senders")).rows);
    expect(all).not.toContain(PN_BLOCKED);
    await expect(adminBlockSender(admin, adminId, "05321550008", null)).rejects.toThrow();
    // Pasif yönetici engel ekleyemez; işletme rolü (app_user) fonksiyonu hiç çağıramaz.
    const off = await createTestAdmin(admin, `off${tag}`);
    await admin.query("update admin_users set status = 'disabled' where id = $1", [off]);
    await expect(adminBlockSender(admin, off, "905321550077", null)).rejects.toMatchObject({
      code: "42501",
    });
    const viaApp = await appPool
      .query("select public.app_wa_admin_block_sender($1, '905321550077', null)", [adminId])
      .then(
        () => "ok",
        (e: { code?: string }) => e.code,
      );
    expect(viaApp).toBe("42501");
    // app_user tabloyu okuyamaz.
    const res = await appPool.query("select * from wa_blocked_senders").then(
      () => "ok",
      (e: { code?: string }) => e.code,
    );
    expect(res).toBe("42501");
  });
});
