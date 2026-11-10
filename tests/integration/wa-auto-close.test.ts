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

/**
 * WhatsApp Asistanı A2e — işletme sahibinin açık kapatma talimatı takvime OTOMATİK blok olarak
 * işlenir (drizzle/0038 + src/server/whatsapp/auto-close.ts). Gerçek PostgreSQL 17, app_user,
 * FORCE RLS; mesaj ağ geçidinin çağırdığı fonksiyonla kaydedilir, worker gerçek kodla ve üretimdeki
 * gibi createAutoCloser ile çalışır.
 *
 * Güvenlik: yalnız sahip + grubun villası + iki net tarih + açık kapatma + çakışma yok → blok.
 * Diğer her durumda (eşleştirilmemiş grup, villasız grup, yönetici/personel/yabancı gönderen,
 * belirsiz tarih, soru, çakışma, rezervasyon, açma) blok OLUŞMAZ; öneri panelde bekler veya mesaj
 * yok sayılır. Aynı mesaj ikinci blok üretmez. Başarısızlıkta takvim değişmez.
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
    expect(audit.rows[0].metadata).toEqual({ property: mavi, reservation: firstBlock });
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

  it("4b. bağlı ama villası seçilmemiş grup: öneri panelde bekler, blok yok", async () => {
    const before = await calendarDigest();
    const noVilla = await group("linked", null);
    const r = await send(`Villa Mavi ${tr(day(60))}–${tr(day(62))} kapatalım.`, {
      jid: noVilla.jid,
    });
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0].status).toBe("pending");
    expect(r.summary.autoClosed).toBe(0);
    expect(await calendarDigest()).toEqual(before);
  });

  it("5. yetkisiz gönderen: yönetici ve personel → panel onayı; kayıtsız numara → yok sayılır", async () => {
    const before = await calendarDigest();
    const mgr = await send(`Villa Mavi ${tr(day(64))}–${tr(day(66))} kapatalım.`, {
      pn: PN_MANAGER,
    });
    expect(mgr.proposals).toHaveLength(1);
    expect(mgr.proposals[0]).toMatchObject({ status: "pending", sender_role: "manager" });
    const staff = await send(`Villa Mavi ${tr(day(67))}–${tr(day(69))} kapatalım.`, {
      pn: PN_STAFF,
    });
    expect(staff.proposals[0]).toMatchObject({ status: "pending", sender_role: "staff" });
    expect(staff.proposals[0].review_reasons).toContain("staff_review_required");
    const stranger = await send(`Villa Mavi ${tr(day(70))}–${tr(day(72))} kapatalım.`, {
      pn: PN_STRANGER,
    });
    expect(stranger.message).toMatchObject({
      status: "ignored",
      last_error: "sender_not_authorized",
    });
    expect(stranger.proposals).toHaveLength(0);
    expect(await calendarDigest()).toEqual(before);
  });

  it("5b. sahip başka bir villayı yazarsa (grubun villası değil) blok yok", async () => {
    const before = await calendarDigest();
    const r = await send(`Villa Asya ${tr(day(74))}–${tr(day(76))} kapatalım.`);
    expect(r.proposals[0]).toMatchObject({ status: "pending", property_id: asya });
    expect(r.proposals[0].review_reasons).toContain("villa_needs_review");
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
    // İptal de otomatik değildir.
    const c = await send(`Villa Mavi ${tr(day(30))}–${tr(day(35))} iptal`);
    expect(c.proposals[0]).toMatchObject({ status: "pending", action: "cancel" });
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
