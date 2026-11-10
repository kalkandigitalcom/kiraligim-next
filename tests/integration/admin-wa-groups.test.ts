import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

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
import {
  archiveAdminGroup,
  getAdminGroup,
  groupTab,
  linkAdminGroup,
  listAdminConnections,
  listAdminGroupHistory,
  listAdminGroups,
  listAdminProperties,
  searchAdminWorkspaces,
  setAdminGroupActive,
  setAdminGroupProperty,
  unlinkAdminGroup,
} from "@/server/admin/whatsapp";
import { createProperty } from "@/server/properties/service";
import { createAutoCloser } from "@/server/whatsapp/auto-close";
import { runCalendarWorker, type WorkerDeps } from "@/server/whatsapp/calendar/worker";
import { listGroups, listRecentMessages } from "@/server/whatsapp/service";
import { addWorkspaceMember, createWorkspace } from "@/server/workspaces/service";

import { adminSetActive, adminSetProperty, adminUnlink, createTestAdmin } from "./wa-admin";

/**
 * Aşama 2 — merkezi WhatsApp grup yönetimi (drizzle/0043, 0044; src/server/admin/whatsapp.ts).
 * Gerçek PostgreSQL 17: Super Admin servisi GERÇEK app_admin rolüyle (süper kullanıcı bağlantısında
 * SET ROLE app_admin), işletme paneli app_user + FORCE RLS ile, ağ geçidi bağlamsız app_user ile,
 * worker ve otomatik kapatma üretimdeki kodla çalışır.
 *
 * Doğrulananlar: eşleştirme yalnız Super Admin'de; villa yalnız seçilen işletmenin AKTİF villası;
 * mükerrer JID bağlanamaz, arşivlenir; işletme kendi gruplarını salt okunur görür, başkasınınkini
 * hiç görmez; pasif / villası değişen / bağlantısı kaldırılan grupta otomatik takvim işlemi
 * yapılmaz; bağlantı kaldırılınca mesaj içerikleri silinir, öneri ve denetim kayıtları kalır;
 * mevcut eşleştirmeler korunur; pasif yönetici hiçbir işlem yapamaz.
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 6 });
const app = drizzle(appPool, { schema, casing: DB_CASING });
const adminRolePool = new Pool({ connectionString: db.adminUrl, max: 3 });
adminRolePool.on("connect", (c) => void c.query("set role app_admin"));
const adminDb = drizzle(adminRolePool, { schema, casing: DB_CASING });
const admin = new Client({ connectionString: db.adminUrl });
const tag = randomBytes(3).toString("hex");
const log = createLogger({ service: "admin-wa-groups-test" }, () => {});
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

const PN_OWNER = `9053266${String(parseInt(tag, 16) % 100_000).padStart(5, "0")}`;
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

let O: U, M: U, X: U;
let ws: string, wsX: string, wsPassive: string;
let mavi: string, asya: string, pasifVilla: string, villaX: string;
let conn: string, conn2: string;
let adminId: string, disabledAdmin: string;
const planCode = `wa_admin_${tag}`;

let jidN = 0;
const jidBase = BigInt(`0x${randomBytes(4).toString("hex")}`) % 10_000_000n;
const newJid = () =>
  `120367${String(jidBase).padStart(7, "0")}${String(++jidN).padStart(5, "0")}@g.us`;

const sync = async (jid: string, connection = conn, subject = "Ekip", present = true) =>
  (
    await appPool.query<{ out: string }>(
      "select public.app_wa_sync_group($1, $2, $3, 4, false, false, $4) as out",
      [connection, jid, subject, present],
    )
  ).rows[0]!.out;
const idOf = async (jid: string, connection = conn) =>
  (
    await admin.query("select id from wa_groups where jid = $1 and connection_id = $2", [
      jid,
      connection,
    ])
  ).rows[0].id as string;
const row = async (id: string) =>
  (
    await admin.query(
      "select status, workspace_id, property_id, linked_by, linked_by_admin, archived_at, archived_by_admin from wa_groups where id = $1",
      [id],
    )
  ).rows[0];

let msgN = 0;
const ingest = async (jid: string, body = "Merhaba", pn = PN_OWNER) => {
  const mid = `AW${tag}${++msgN}`;
  const out = (
    await appPool.query<{ s: string }>(
      "select public.app_wa_ingest_message($1, $2, $3, '1@lid', $4, null, $5, now(), 'live') as s",
      [conn, jid, mid, pn, body],
    )
  ).rows[0]!.s;
  return { mid, out };
};

/** Ağ geçidi gibi kaydeder, worker'ı (otomatik kapatma dahil) çalıştırır; mesajın önerilerini döner. */
async function send(jid: string, body: string, over: WorkerDeps = {}) {
  const { mid, out } = await ingest(jid, body);
  await runCalendarWorker(app, deps(over));
  const proposals = (
    await admin.query(
      `select p.* from wa_calendar_proposals p join wa_inbound_messages m on m.id = p.message_id
        where m.wa_message_id = $1 order by p.item_no`,
      [mid],
    )
  ).rows;
  return { mid, out, proposals };
}
const blocksOf = async (property: string) =>
  (
    await admin.query(
      "select id from reservations where property_id = $1 and kind = 'block' order by check_in",
      [property],
    )
  ).rows.map((r) => r.id as string);
const autoFailReason = async (proposalId: string) =>
  (
    await admin.query(
      "select metadata from audit_log where action = 'whatsapp.proposal_auto_failed' and target_id = $1",
      [proposalId],
    )
  ).rows.map((r) => r.metadata.reason);

async function villa(u: U, w: string, name: string) {
  return as(u, w, (tx, ctx) =>
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

/** Super Admin servisiyle eşleştirir (app_admin rolü). */
const link = (groupId: string, workspaceId = ws, propertyId = mavi) =>
  linkAdminGroup(adminDb, adminId, { groupId, workspaceId, propertyId });

beforeAll(async () => {
  await admin.connect();
  O = await mkUser("awo");
  M = await mkUser("awm");
  X = await mkUser("awx");
  const P = await mkUser("awp");
  ws = (await createWorkspace(app, { userId: O.id, name: "Merkez Test", slug: `aw-${tag}` })).id;
  wsX = (await createWorkspace(app, { userId: X.id, name: "Başka Test", slug: `awx-${tag}` })).id;
  wsPassive = (await createWorkspace(app, { userId: P.id, name: "Pasif Test", slug: `awp-${tag}` }))
    .id;
  const planId = uuidv7();
  await admin.query(
    "insert into plans (id, code, name, max_properties, trial_days, is_active, is_default) values ($1, $2, 'WA admin', 20, 14, true, false)",
    [planId, planCode],
  );
  await admin.query(
    "update workspace_subscriptions set plan_id = $1 where workspace_id = any($2)",
    [planId, [ws, wsX, wsPassive]],
  );
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: M.id, role: "manager" }));
  mavi = await villa(O, ws, "Villa Mavi");
  asya = await villa(O, ws, "Villa Asya");
  pasifVilla = await villa(O, ws, "Villa Kapalı");
  await admin.query("update properties set status = 'passive' where id = $1", [pasifVilla]);
  villaX = await villa(X, wsX, "Başka Villa");
  await villa(P, wsPassive, "Pasif İşletme Villası");
  await admin.query("update workspaces set status = 'suspended' where id = $1", [wsPassive]);
  conn = (
    await appPool.query<{ id: string }>("select public.app_wa_heartbeat($1, 'open', null) as id", [
      `aw-${tag}`,
    ])
  ).rows[0]!.id;
  conn2 = (
    await appPool.query<{ id: string }>("select public.app_wa_heartbeat($1, 'open', null) as id", [
      `aw2-${tag}`,
    ])
  ).rows[0]!.id;
  await admin.query(
    "insert into wa_verified_phones (user_id, phone_hash, phone_masked) values ($1, $2, '+90 532 *** ** 01')",
    [O.id, phoneHash(PN_OWNER)],
  );
  adminId = await createTestAdmin(admin, "merkez");
  disabledAdmin = await createTestAdmin(admin, "pasif");
  await admin.query("update admin_users set status = 'disabled' where id = $1", [disabledAdmin]);
  // Worker'ın ilk aktivasyonu (aktivasyon öncesi mesajlar işlenmez).
  await runCalendarWorker(app, deps());
});

afterAll(async () => {
  await admin.query("delete from wa_inbound_messages where workspace_id = any($1)", [[ws, wsX]]);
  await admin.query(
    "update workspace_subscriptions set plan_id = (select id from plans where is_default) where workspace_id = any($1)",
    [[ws, wsX, wsPassive]],
  );
  await admin.query("delete from plans where code = $1", [planCode]);
  await admin.end();
  await adminRolePool.end();
  await appPool.end();
});

describe("eşleştirme (yalnız Super Admin)", () => {
  it("keşfedilen grup 'bekleyen' sekmesinde; işletmeler görmez", async () => {
    const jid = newJid();
    expect(await sync(jid, conn, "Mavi Operasyon")).toBe("discovered");
    const id = await idOf(jid);
    const g = await getAdminGroup(adminDb, adminId, id);
    expect(g).toMatchObject({
      status: "discovered",
      workspaceId: null,
      propertyId: null,
      subject: "Mavi Operasyon",
      sameJidCount: 1,
      connectionLabel: `aw-${tag}`,
    });
    expect(groupTab(g)).toBe("bekleyen");
    expect(await as(O, ws, (tx, ctx) => listGroups(tx, ctx))).toEqual([]);
    expect(await ingest(jid).then((r) => r.out)).toBe("ignored");
  });

  it("işletme ve villa seçenekleri: arama, aktif/pasif bilgisi; yalnız seçilen işletmenin villaları", async () => {
    const found = await searchAdminWorkspaces(adminDb, adminId, "Test");
    expect(found.filter((w) => [ws, wsX, wsPassive].includes(w.id))).toHaveLength(3);
    expect(found.find((w) => w.id === wsPassive)?.active).toBe(false);
    const props = await listAdminProperties(adminDb, adminId, ws);
    expect(props.map((p) => [p.name, p.active]).sort()).toEqual([
      ["Villa Asya", true],
      ["Villa Kapalı", false],
      ["Villa Mavi", true],
    ]);
    expect(await listAdminProperties(adminDb, adminId, "kötü")).toEqual([]);
    const conns = await listAdminConnections(adminDb, adminId);
    expect(conns.map((c) => c.label)).toEqual(expect.arrayContaining([`aw-${tag}`, `aw2-${tag}`]));
  });

  it("başka işletmenin villası, pasif villa ve pasif işletme reddedilir; grup değişmez", async () => {
    const jid = newJid();
    await sync(jid);
    const id = await idOf(jid);
    await expect(link(id, ws, villaX)).rejects.toMatchObject({ reason: "property_invalid" });
    await expect(link(id, wsX, mavi)).rejects.toMatchObject({ reason: "property_invalid" });
    await expect(link(id, ws, pasifVilla)).rejects.toMatchObject({ reason: "property_invalid" });
    const pv = (await admin.query("select id from properties where workspace_id = $1", [wsPassive]))
      .rows[0].id;
    await expect(link(id, wsPassive, pv)).rejects.toMatchObject({ reason: "workspace_invalid" });
    await expect(link(id, ws, "x")).rejects.toMatchObject({ reason: "property_invalid" });
    await expect(link(uuidv7(), ws, mavi)).rejects.toMatchObject({ reason: "not_found" });
    expect(await row(id)).toMatchObject({ status: "discovered", workspace_id: null });
  });

  it("eşleştirme: grup aktif, işletme salt okunur görür, mesaj kaydedilir; iki denetim kaydı", async () => {
    const jid = newJid();
    await sync(jid, conn, "Mavi Ekip");
    const id = await idOf(jid);
    await link(id);
    expect(await row(id)).toMatchObject({
      status: "linked",
      workspace_id: ws,
      property_id: mavi,
      linked_by: null,
      linked_by_admin: adminId,
    });
    expect(groupTab(await getAdminGroup(adminDb, adminId, id))).toBe("aktif");
    // Bir grup aynı anda tek işletmeye: ikinci eşleştirme reddedilir.
    await expect(link(id, wsX, villaX)).rejects.toMatchObject({ reason: "not_available" });
    const mine = await as(O, ws, (tx, ctx) => listGroups(tx, ctx));
    expect(mine.find((g) => g.id === id)).toMatchObject({
      status: "linked",
      propertyId: mavi,
      propertyName: "Villa Mavi",
    });
    // Tenant izolasyonu: başka işletme grubu ve mesajlarını göremez.
    expect((await as(X, wsX, (tx, ctx) => listGroups(tx, ctx))).map((g) => g.id)).not.toContain(id);
    expect(await ingest(jid).then((r) => r.out)).toBe("stored");
    expect(await as(X, wsX, (tx, ctx) => listRecentMessages(tx, ctx, id))).toEqual([]);
    expect(await as(O, ws, (tx, ctx) => listRecentMessages(tx, ctx, id))).toHaveLength(1);
    const tenantAudit = await admin.query(
      "select workspace_id, actor_user_id, metadata from audit_log where action = 'whatsapp.group_linked' and target_id = $1",
      [id],
    );
    expect(tenantAudit.rows).toEqual([
      { workspace_id: ws, actor_user_id: null, metadata: { method: "platform", property: mavi } },
    ]);
    const history = await listAdminGroupHistory(adminDb, id);
    expect(history.map((h) => [h.action, h.adminName])).toEqual([
      ["whatsapp.group_linked", "Admin merkez"],
    ]);
    expect(history[0]!.metadata).toEqual({ workspace: ws, property: mavi });
  });

  it("işletme rolü (sahip dahil) grubu değiştiremez; Super Admin fonksiyonlarını çağıramaz", async () => {
    const jid = newJid();
    await sync(jid);
    const id = await idOf(jid);
    const codeOf = (p: Promise<unknown>) => p.then(() => "ok").catch((e) => pgErrorInfo(e).code);
    for (const q of [
      sql`select * from public.app_wa_admin_groups(${adminId}::uuid)`,
      sql`select public.app_wa_admin_link_group(${adminId}::uuid, ${id}::uuid, ${ws}::uuid, ${mavi}::uuid)`,
      sql`select public.app_wa_admin_set_active(${adminId}::uuid, ${id}::uuid, true)`,
      sql`select public.app_wa_admin_unlink_group(${adminId}::uuid, ${id}::uuid)`,
      sql`select public.app_wa_claim_group(${id}::uuid, ${mavi}::uuid)`,
      sql`update wa_groups set property_id = ${asya}`,
      sql`update wa_groups set status = 'suspended'`,
    ]) {
      expect(await codeOf(as(O, ws, (tx) => tx.execute(q)))).toBe("42501");
    }
    // Ağ geçidi (bağlamsız app_user) de çağıramaz.
    expect(
      await codeOf(
        appPool.query("select public.app_wa_admin_link_group($1, $2, $3, $4)", [
          adminId,
          id,
          ws,
          mavi,
        ]),
      ),
    ).toBe("42501");
    expect(await row(id)).toMatchObject({ status: "discovered", workspace_id: null });
  });

  it("pasif veya bilinmeyen yönetici hiçbir işlem yapamaz", async () => {
    const jid = newJid();
    await sync(jid);
    const id = await idOf(jid);
    const codeOf = (p: Promise<unknown>) => p.then(() => "ok").catch((e) => pgErrorInfo(e).code);
    for (const who of [disabledAdmin, uuidv7()]) {
      expect(await codeOf(listAdminGroups(adminDb, who))).toBe("42501");
      expect(
        await codeOf(
          linkAdminGroup(adminDb, who, { groupId: id, workspaceId: ws, propertyId: mavi }),
        ),
      ).toBe("42501");
    }
    expect(await row(id)).toMatchObject({ status: "discovered", workspace_id: null });
  });
});

describe("mükerrer keşif ve arşiv", () => {
  it("aynı JID ikinci bağlantıdan keşfedilir; bağlıysa ikinci kayıt bağlanamaz, arşivlenir", async () => {
    const jid = newJid();
    await sync(jid, conn, "Ortak Grup");
    const first = await idOf(jid, conn);
    await link(first);
    await sync(jid, conn2, "Ortak Grup");
    const dup = await idOf(jid, conn2);
    const g = await getAdminGroup(adminDb, adminId, dup);
    expect(g.sameJidCount).toBe(2);
    await expect(link(dup)).rejects.toMatchObject({ reason: "duplicate" });
    expect(await archiveAdminGroup(adminDb, adminId, dup, true)).toEqual({ changed: true });
    expect(await archiveAdminGroup(adminDb, adminId, dup, true)).toEqual({ changed: false });
    expect(await row(dup)).toMatchObject({ workspace_id: null, archived_by_admin: adminId });
    expect(groupTab(await getAdminGroup(adminDb, adminId, dup))).toBe("arsiv");
    await expect(link(dup)).rejects.toMatchObject({ reason: "archived" });
    // Bağlı grup arşivlenemez (önce bağlantı kaldırılmalı).
    await expect(archiveAdminGroup(adminDb, adminId, first, true)).rejects.toMatchObject({
      reason: "not_available",
    });
    // Arşivden çıkarılan mükerrer kayıt hâlâ bağlanamaz.
    expect(await archiveAdminGroup(adminDb, adminId, dup, false)).toEqual({ changed: true });
    await expect(link(dup)).rejects.toMatchObject({ reason: "duplicate" });
    expect(await row(first)).toMatchObject({ status: "linked", workspace_id: ws });
  });

  it("arşivdeki grup veritabanı kısıtıyla da bir işletmeye bağlanamaz", async () => {
    const jid = newJid();
    await sync(jid);
    const id = await idOf(jid);
    await archiveAdminGroup(adminDb, adminId, id, true);
    await expect(
      admin.query("update wa_groups set workspace_id = $2 where id = $1", [id, ws]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("pasife alma, villa değişikliği ve otomatik kapatma", () => {
  let jid: string;
  let id: string;

  beforeAll(async () => {
    jid = newJid();
    await sync(jid, conn, "Oto Kapatma");
    id = await idOf(jid);
    await link(id);
  });

  it("aktif grupta sahibin kapatma talimatı otomatik işlenir (mevcut davranış korunur)", async () => {
    const before = (await blocksOf(mavi)).length;
    const r = await send(jid, `${tr(day(40))}–${tr(day(43))} kapatalım.`);
    expect(r.out).toBe("stored");
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0]).toMatchObject({ status: "applied", property_id: mavi });
    expect((await blocksOf(mavi)).length).toBe(before + 1);
  });

  it("pasif grubun yeni mesajı kaydedilmez; otomatik işlem yapılmaz; tekrar aktif edilince devam", async () => {
    expect(await setAdminGroupActive(adminDb, adminId, id, false)).toEqual({ changed: true });
    expect(await setAdminGroupActive(adminDb, adminId, id, false)).toEqual({ changed: false });
    expect(groupTab(await getAdminGroup(adminDb, adminId, id))).toBe("pasif");
    const before = (await blocksOf(mavi)).length;
    const r = await send(jid, `${tr(day(50))}–${tr(day(52))} kapatalım.`);
    expect(r.out).toBe("ignored");
    expect(r.proposals).toEqual([]);
    expect((await blocksOf(mavi)).length).toBe(before);
    // İşletme pasif grubunu salt okunur görür.
    expect(
      (await as(O, ws, (tx, ctx) => listGroups(tx, ctx))).find((g) => g.id === id),
    ).toMatchObject({ status: "suspended" });
    expect(await setAdminGroupActive(adminDb, adminId, id, true)).toEqual({ changed: true });
  });

  it("öneri kaydı ile otomatik işlem ARASINDA grup pasife alınırsa takvim değişmez", async () => {
    const before = (await blocksOf(mavi)).length;
    const r = await send(jid, `${tr(day(60))}–${tr(day(62))} kapatalım.`, {
      autoClose: async (req) => {
        expect(await adminSetActive(admin, adminId, id, false)).toBe("changed");
        return autoClose(req);
      },
    });
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0]).toMatchObject({ status: "pending" });
    expect(await autoFailReason(r.proposals[0].id)).toEqual(["changed"]);
    expect((await blocksOf(mavi)).length).toBe(before);
    expect(await adminSetActive(admin, adminId, id, true)).toBe("changed");
  });

  it("öneri kaydı ile otomatik işlem ARASINDA villa değişirse takvim değişmez", async () => {
    const beforeMavi = (await blocksOf(mavi)).length;
    const beforeAsya = (await blocksOf(asya)).length;
    const r = await send(jid, `${tr(day(70))}–${tr(day(72))} kapatalım.`, {
      autoClose: async (req) => {
        expect(await adminSetProperty(admin, adminId, id, asya)).toBe("changed");
        return autoClose(req);
      },
    });
    expect(r.proposals[0]).toMatchObject({ status: "pending", property_id: mavi });
    expect(await autoFailReason(r.proposals[0].id)).toEqual(["changed"]);
    expect((await blocksOf(mavi)).length).toBe(beforeMavi);
    expect((await blocksOf(asya)).length).toBe(beforeAsya);
  });

  it("villa değişikliği: yalnız aynı işletmenin aktif villası; yeni mesajlar yeni villaya", async () => {
    await expect(setAdminGroupProperty(adminDb, adminId, id, villaX)).rejects.toMatchObject({
      reason: "property_invalid",
    });
    await expect(setAdminGroupProperty(adminDb, adminId, id, pasifVilla)).rejects.toMatchObject({
      reason: "property_invalid",
    });
    expect(await setAdminGroupProperty(adminDb, adminId, id, asya)).toEqual({ changed: false });
    const before = (await blocksOf(asya)).length;
    const r = await send(jid, `${tr(day(80))}–${tr(day(82))} kapatalım.`);
    expect(r.proposals[0]).toMatchObject({ status: "applied", property_id: asya });
    expect((await blocksOf(asya)).length).toBe(before + 1);
    const history = (await listAdminGroupHistory(adminDb, id)).map((h) => h.action);
    expect(history).toEqual([
      "whatsapp.group_property_changed",
      "whatsapp.group_resumed",
      "whatsapp.group_suspended",
      "whatsapp.group_resumed",
      "whatsapp.group_suspended",
      "whatsapp.group_linked",
    ]);
  });

  it("bağlantı kaldırma: mesajlar silinir, alıntılar '(silindi)', öneri/rezervasyon/denetim kalır", async () => {
    // Bekleyen bir öneri bırak (otomatik işlem bu mesaj için başarısız sayılır).
    const pending = await send(jid, `${tr(day(90))}–${tr(day(92))} kapatalım.`, {
      autoClose: async () => ({ outcome: "failed", proposalId: null, reason: "error" }),
    });
    expect(pending.proposals[0]).toMatchObject({ status: "pending" });
    const applied = (
      await admin.query(
        "select id, applied_reservation_ids from wa_calendar_proposals where group_id = $1 and status = 'applied'",
        [id],
      )
    ).rows;
    expect(applied.length).toBeGreaterThan(0);
    const auditBefore = (
      await admin.query("select count(*)::int n from audit_log where workspace_id = $1", [ws])
    ).rows[0].n;

    await unlinkAdminGroup(adminDb, adminId, id);

    expect(await row(id)).toMatchObject({
      status: "discovered",
      workspace_id: null,
      property_id: null,
      linked_by_admin: null,
    });
    expect(
      (
        await admin.query("select count(*)::int n from wa_inbound_messages where group_id = $1", [
          id,
        ])
      ).rows[0].n,
    ).toBe(0);
    const props = (
      await admin.query(
        "select id, status, message_id, message_excerpt from wa_calendar_proposals where group_id = $1",
        [id],
      )
    ).rows;
    expect(props.length).toBeGreaterThan(0);
    for (const p of props) {
      expect(p.message_id).toBeNull();
      expect(p.message_excerpt).toBe("(silindi)");
      expect(p.status).not.toBe("pending");
    }
    expect(props.find((p) => p.id === pending.proposals[0].id)?.status).toBe("expired");
    // Uygulanmış öneriler ve rezervasyonları korunur.
    for (const a of applied) {
      for (const rid of a.applied_reservation_ids) {
        expect(
          (await admin.query("select count(*)::int n from reservations where id = $1", [rid]))
            .rows[0].n,
        ).toBe(1);
      }
    }
    const auditAfter = (
      await admin.query("select count(*)::int n from audit_log where workspace_id = $1", [ws])
    ).rows[0].n;
    expect(auditAfter).toBe(auditBefore + 1); // yalnız eklenir (group_unlinked)
    expect((await listAdminGroupHistory(adminDb, id))[0]!.action).toBe("whatsapp.group_unlinked");
    // İşletme artık görmez; yeni mesaj kaydedilmez, otomatik işlem yok.
    expect((await as(O, ws, (tx, ctx) => listGroups(tx, ctx))).map((g) => g.id)).not.toContain(id);
    const before = (await blocksOf(asya)).length;
    const r = await send(jid, `${tr(day(100))}–${tr(day(102))} kapatalım.`);
    expect(r.out).toBe("ignored");
    expect((await blocksOf(asya)).length).toBe(before);
    // Yeniden bekleyenlere düştü; tekrar eşleştirilebilir.
    expect(groupTab(await getAdminGroup(adminDb, adminId, id))).toBe("bekleyen");
  });

  it("öneri kaydı ile otomatik işlem ARASINDA bağlantı kaldırılırsa takvim değişmez", async () => {
    await link(id, ws, mavi);
    const before = (await blocksOf(mavi)).length;
    const r = await send(jid, `${tr(day(110))}–${tr(day(112))} kapatalım.`, {
      autoClose: async (req) => {
        expect(await adminUnlink(admin, adminId, id)).toBe("unlinked");
        return autoClose(req);
      },
    });
    expect(r.proposals).toEqual([]); // mesaj silindi; öneri kaldı ama mesaja bağlı değil
    const p = (
      await admin.query(
        "select status, message_excerpt from wa_calendar_proposals where group_id = $1 and check_in = $2",
        [id, day(110)],
      )
    ).rows;
    expect(p).toEqual([{ status: "expired", message_excerpt: "(silindi)" }]);
    expect((await blocksOf(mavi)).length).toBe(before);
  });
});

/**
 * Eşzamanlılık (0045): otomatik kapatma grup satırını FOR SHARE ile kilitler; Super Admin işlemleri
 * FOR UPDATE ile kilitler. Gerçek bağlantılar ve gerçek kilit beklemeleriyle iki sıra da sınanır.
 */
describe("eşzamanlılık: otomatik kapatma ↔ Super Admin grup işlemi", () => {
  let jid: string;
  let id: string;
  let n = 0;

  /** pg_stat_activity'de sorgusu `pattern` içeren bir bağlantı kilit bekleyene kadar bekler. */
  async function waitForLockWait(pattern: string) {
    for (let i = 0; i < 200; i++) {
      const r = await admin.query(
        `select count(*)::int n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and query ilike $1`,
        [`%${pattern}%`],
      );
      if (r.rows[0].n > 0) return;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error(`kilit beklemesi görülmedi: ${pattern}`);
  }

  /** app_admin olarak transaction açar, işlemi yapar ve commit etmeden (kilidi tutarak) bekler. */
  async function holdAdmin(text: string, values: unknown[]) {
    const c = new Client({ connectionString: db.adminUrl });
    await c.connect();
    await c.query("begin");
    await c.query("set local role app_admin");
    const out = (await c.query<{ out: string }>(text, values)).rows[0]!.out;
    return {
      out,
      commit: async () => {
        await c.query("commit");
        await c.end();
      },
    };
  }

  /** Yeni (her sınamada farklı tarihli) kapatma mesajı. */
  const closeMsg = () => {
    n += 1;
    return `${tr(day(300 + n * 5))}–${tr(day(302 + n * 5))} kapatalım.`;
  };
  const proposalByDate = async (offset: number) =>
    (
      await admin.query(
        "select id, status, message_excerpt from wa_calendar_proposals where group_id = $1 and check_in = $2",
        [id, day(offset)],
      )
    ).rows;

  beforeAll(async () => {
    jid = newJid();
    await sync(jid, conn, "Eşzamanlı");
    id = await idOf(jid);
    await link(id, ws, mavi);
  });

  it("Super Admin önce PASİFE ALIRSA: otomatik kapatma commit'i bekler, güncel durumu görür; blok yok", async () => {
    const before = (await blocksOf(mavi)).length;
    let blocksWhileWaiting = -1;
    const r = await send(jid, closeMsg(), {
      autoClose: async (req) => {
        const h = await holdAdmin("select public.app_wa_admin_set_active($1, $2, false) as out", [
          adminId,
          id,
        ]);
        expect(h.out).toBe("changed");
        const running = autoClose(req);
        await waitForLockWait("app_wa_lock_group_for_auto_close");
        blocksWhileWaiting = (await blocksOf(mavi)).length;
        await h.commit();
        return running;
      },
    });
    expect(blocksWhileWaiting).toBe(before);
    expect(r.proposals[0]).toMatchObject({ status: "pending" });
    expect(await autoFailReason(r.proposals[0].id)).toEqual(["changed"]);
    expect((await blocksOf(mavi)).length).toBe(before);
    expect(await adminSetActive(admin, adminId, id, true)).toBe("changed");
  });

  it("Super Admin önce VİLLAYI DEĞİŞTİRİRSE: otomatik kapatma bekler; hiçbir villada blok yok", async () => {
    const beforeMavi = (await blocksOf(mavi)).length;
    const beforeAsya = (await blocksOf(asya)).length;
    const r = await send(jid, closeMsg(), {
      autoClose: async (req) => {
        const h = await holdAdmin("select public.app_wa_admin_set_property($1, $2, $3) as out", [
          adminId,
          id,
          asya,
        ]);
        expect(h.out).toBe("changed");
        const running = autoClose(req);
        await waitForLockWait("app_wa_lock_group_for_auto_close");
        await h.commit();
        return running;
      },
    });
    expect(r.proposals[0]).toMatchObject({ status: "pending", property_id: mavi });
    expect(await autoFailReason(r.proposals[0].id)).toEqual(["changed"]);
    expect((await blocksOf(mavi)).length).toBe(beforeMavi);
    expect((await blocksOf(asya)).length).toBe(beforeAsya);
    expect(await adminSetProperty(admin, adminId, id, mavi)).toBe("changed");
  });

  it("Super Admin önce BAĞLANTIYI KALDIRIRSA: otomatik kapatma bekler; blok yok, öneri sona erer", async () => {
    const before = (await blocksOf(mavi)).length;
    const offset = 300 + (n + 1) * 5;
    let result: Awaited<ReturnType<typeof autoClose>> | null = null;
    await send(jid, closeMsg(), {
      autoClose: async (req) => {
        const h = await holdAdmin("select public.app_wa_admin_unlink_group($1, $2) as out", [
          adminId,
          id,
        ]);
        expect(h.out).toBe("unlinked");
        const running = autoClose(req);
        await waitForLockWait("app_wa_lock_group_for_auto_close");
        await h.commit();
        result = await running;
        return result;
      },
    });
    expect(result).toMatchObject({ outcome: "failed", reason: "changed" });
    expect(await proposalByDate(offset)).toEqual([
      expect.objectContaining({ status: "expired", message_excerpt: "(silindi)" }),
    ]);
    expect((await blocksOf(mavi)).length).toBe(before);
    await link(id, ws, mavi);
  });

  it("otomatik kapatma önce kilitlerse: Super Admin işlemi blok commit edilene kadar BEKLER", async () => {
    const before = (await blocksOf(mavi)).length;
    let adminOut: Promise<string> | null = null;
    let adminDoneWhileClosing = true;
    const r = await send(jid, closeMsg(), {
      autoClose: async (req) => {
        // Blok yazımını durdur: rezervasyon tablosuna paylaşımlı kilit (INSERT bekler). Otomatik
        // kapatma grup kilidini almış olarak rezervasyon yazımında bekler.
        const gate = new Client({ connectionString: db.adminUrl });
        await gate.connect();
        await gate.query("begin");
        await gate.query("lock table public.reservations in share mode");
        const running = autoClose(req);
        await waitForLockWait("reservations");
        // Super Admin pasife almayı dener: grup satırı otomatik kapatmada kilitli → bekler.
        const c = new Client({ connectionString: db.adminUrl });
        await c.connect();
        let done = false;
        adminOut = (async () => {
          await c.query("begin");
          await c.query("set local role app_admin");
          const out = (
            await c.query<{ out: string }>(
              "select public.app_wa_admin_set_active($1, $2, false) as out",
              [adminId, id],
            )
          ).rows[0]!.out;
          await c.query("commit");
          await c.end();
          done = true;
          return out;
        })();
        await waitForLockWait("app_wa_admin_set_active");
        adminDoneWhileClosing = done;
        await gate.query("rollback");
        await gate.end();
        return running;
      },
    });
    expect(adminDoneWhileClosing).toBe(false);
    expect(r.proposals[0]).toMatchObject({ status: "applied", property_id: mavi });
    expect((await blocksOf(mavi)).length).toBe(before + 1);
    // Pasife alma, blok commit edildikten SONRA tamamlandı.
    expect(await adminOut!).toBe("changed");
    expect(await row(id)).toMatchObject({ status: "suspended" });
    expect(await adminSetActive(admin, adminId, id, true)).toBe("changed");
  });

  it("işletme rolü grup kilidi fonksiyonuyla başka işletmenin grubunu kilitleyemez/göremez", async () => {
    const r = await as(X, wsX, (tx) =>
      tx.execute(sql`select * from public.app_wa_lock_group_for_auto_close(${id}::uuid)`),
    );
    expect(r.rows).toEqual([]);
    // Bağlamsız app_user (ağ geçidi parolasıyla) hiçbir satır alamaz.
    expect(
      (await appPool.query("select * from public.app_wa_lock_group_for_auto_close($1)", [id])).rows,
    ).toEqual([]);
    // Tablo yetkisi verilmedi: doğrudan kilit hâlâ reddedilir.
    const denied = await as(O, ws, (tx) =>
      tx.execute(sql`select id from wa_groups where id = ${id} for share`),
    ).catch((e: unknown) => e);
    expect(pgErrorInfo(denied).code).toBe("42501");
  });
});

describe("mevcut eşleştirmeler korunur", () => {
  it("Aşama 2 öncesi (işletme panelinden) bağlanmış grup çalışmaya devam eder ve yönetilebilir", async () => {
    // 0043/0044 öncesi veriyi taklit et: linked_by kullanıcı, linked_by_admin boş.
    const jid = newJid();
    await sync(jid, conn, "Eski Grup");
    const id = await idOf(jid);
    await admin.query(
      "update wa_groups set status = 'linked', workspace_id = $2, property_id = $3, linked_by = $4, linked_at = now() where id = $1",
      [id, ws, mavi, O.id],
    );
    expect(await ingest(jid).then((r) => r.out)).toBe("stored");
    const g = await getAdminGroup(adminDb, adminId, id);
    expect(g).toMatchObject({
      status: "linked",
      workspaceName: "Merkez Test",
      propertyName: "Villa Mavi",
    });
    expect(groupTab(g)).toBe("aktif");
    expect((await as(O, ws, (tx, ctx) => listGroups(tx, ctx))).map((x) => x.id)).toContain(id);
    expect(await setAdminGroupProperty(adminDb, adminId, id, asya)).toEqual({ changed: true });
    expect(await row(id)).toMatchObject({ linked_by: O.id, property_id: asya });
  });

  it("migration'lar mevcut veriyi değiştirmez (yalnız kolon/indeks/kısıt/fonksiyon/yetki)", () => {
    const dir = path.join(process.cwd(), "drizzle");
    for (const f of [
      "0043_wa_group_admin.sql",
      "0044_wa_group_admin_security.sql",
      "0045_wa_auto_close_group_lock.sql",
    ]) {
      const text = readFileSync(path.join(dir, f), "utf8")
        .replace(/\$\$[\s\S]*?\$\$/g, "$$$$") // fonksiyon gövdeleri
        .replace(/--.*$/gm, "");
      const statements = text
        .split("--> statement-breakpoint")
        .flatMap((s) => s.split(/;\s*$/m))
        .map((s) => s.trim())
        .filter(Boolean);
      for (const s of statements) {
        expect(s, `${f}: ${s.slice(0, 60)}`).toMatch(
          /^(ALTER TABLE [\w."]+ ADD (COLUMN|CONSTRAINT)|CREATE (UNIQUE )?INDEX|CREATE POLICY|CREATE FUNCTION|REVOKE|GRANT|COMMENT ON)/i,
        );
      }
    }
  });
});
