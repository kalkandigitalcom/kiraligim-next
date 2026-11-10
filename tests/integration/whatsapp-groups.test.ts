import { randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { DB_CASING } from "@/db/casing";
import { pgErrorInfo } from "@/db/pg-error";
import * as schema from "@/db/schema";
import { type TenantContext, type Tx, withTenant } from "@/db/tenant";
import { WA_RETENTION_DAYS } from "@/lib/whatsapp-meta";
import { createProperty } from "@/server/properties/service";
import {
  canManageWhatsapp,
  getConnectionStatus,
  listGroups,
  listRecentMessages,
} from "@/server/whatsapp/service";
import { addWorkspaceMember, createWorkspace } from "@/server/workspaces/service";

import { adminLink, adminSetActive, adminUnlink, createTestAdmin } from "./wa-admin";

/**
 * WhatsApp Asistanı A1 (drizzle/0030–0032) — gerçek PostgreSQL, app_user, FORCE RLS.
 * Aşama 2 (0044): eşleştirme, pasife alma ve bağlantı kaldırma yalnız Super Admin'dedir
 * (tests/integration/admin-wa-groups.test.ts); burada grup yönetici fonksiyonlarıyla bağlanır.
 * Ağ geçidi bağlamsız app_user olarak yalnız app_wa_* fonksiyonlarını çağırır (burada doğrudan
 * SQL ile taklit edilir); panel withTenant ile servis fonksiyonlarını kullanır.
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 6 });
const app = drizzle(appPool, { schema, casing: DB_CASING });
const admin = new Client({ connectionString: db.adminUrl });
const tag = randomBytes(3).toString("hex");

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

/** Ağ geçidi: bağlamsız app_user (havuzdan doğrudan sorgu). */
const gw = async <T>(text: string, values: unknown[]): Promise<T> =>
  (await appPool.query<{ out: T }>(text, values)).rows[0]!.out;

let conn = "";
const jidSeq = BigInt(`0x${randomBytes(4).toString("hex")}`) % 10_000_000n;
let jidN = 0;
const newJid = () =>
  `120363${String(jidSeq).padStart(7, "0")}${String(++jidN).padStart(5, "0")}@g.us`;

const sync = (jid: string, present = true, subject: string | null = "Villa Ekibi") =>
  gw<string>("select public.app_wa_sync_group($1, $2, $3, 5, false, false, $4) as out", [
    conn,
    jid,
    subject,
    present,
  ]);
let msgN = 0;
const ingest = (jid: string, body = "Villa Defne 12-15 Temmuz dolu", id = `M${tag}${++msgN}`) =>
  gw<string>(
    "select public.app_wa_ingest_message($1, $2, $3, $4, $5, $6, $7, now(), 'live') as out",
    [conn, jid, id, "111222333444@lid", PN_O, "111222333444@lid", body],
  );

const PN_O = "905321112233";

let O: U, M: U, M2: U, S: U, X: U;
let ws: string, wsX: string;
let adminId = "";
let villa = "";

const groupRow = async (jid: string) =>
  (
    await admin.query(
      "select id, status, workspace_id, link_fail_count from wa_groups where jid = $1",
      [jid],
    )
  ).rows[0] as { id: string; status: string; workspace_id: string | null; link_fail_count: number };

beforeAll(async () => {
  await admin.connect();
  O = await mkUser("waowner");
  M = await mkUser("wamanager");
  M2 = await mkUser("wamanager2");
  S = await mkUser("wastaff");
  X = await mkUser("waother");
  ws = (await createWorkspace(app, { userId: O.id, name: "WA İşletme", slug: `wa-${tag}` })).id;
  wsX = (await createWorkspace(app, { userId: X.id, name: "WA Diğer", slug: `wax-${tag}` })).id;
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: M.id, role: "manager" }));
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: M2.id, role: "manager" }));
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: S.id, role: "staff" }));
  villa = await as(O, ws, (tx, ctx) =>
    createProperty(tx, ctx, {
      name: "Villa Defne",
      propertyType: "villa",
      maxGuests: "6",
      bedrooms: "3",
      bathrooms: "2",
      province: "Antalya",
      district: "Kaş",
    }),
  );
  adminId = await createTestAdmin(admin, "wagroups");
});

afterAll(async () => {
  await admin.end();
  await appPool.end();
});

describe("ağ geçidi: bağlantı ve grup keşfi", () => {
  it("kalp atışı etikete göre tek kayıt; panel durumu görür", async () => {
    conn = await gw<string>("select public.app_wa_heartbeat($1, 'connecting', null) as out", [
      `t-${tag}`,
    ]);
    const again = await gw<string>("select public.app_wa_heartbeat($1, 'open', null) as out", [
      `t-${tag}`,
    ]);
    expect(again).toBe(conn);
    const st = await as(S, ws, (tx) => getConnectionStatus(tx));
    expect(st).toMatchObject({ status: "open", stale: false });
    expect(st.lastConnectedAt).toBeInstanceOf(Date);
    await expect(
      appPool.query("select public.app_wa_heartbeat('Ana Hat', 'open', null)"),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("keşfedilen grup hiçbir işletmeye görünmez; mesajı kaydedilmez", async () => {
    const jid = newJid();
    expect(await sync(jid)).toBe("discovered");
    expect(await as(O, ws, (tx, ctx) => listGroups(tx, ctx))).toEqual([]);
    expect(await ingest(jid)).toBe("ignored");
    const n = await admin.query("select count(*)::int n from wa_inbound_messages");
    expect(n.rows[0].n).toBe(0);
    await expect(
      appPool.query("select public.app_wa_sync_group($1, 'abc', null, 1, false, false, true)", [
        conn,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

/**
 * Eski kodlu bağlama (0031) ve işletme tarafı eşleştirme (0033/0034): Aşama 2 (0044) ile işletme
 * rolünden tamamen kaldırıldı. Yetki kaldırıldığı veritabanında denetlenir.
 */
describe("işletme tarafı eşleştirme yolları kapalı (Aşama 2)", () => {
  it("bağlama kodu eklenemez, eski kod fonksiyonu çağrılamaz, yönetici yetkisi verilemez", async () => {
    for (const u of [O, M]) {
      const err = await as(u, ws, (tx) =>
        tx.execute(sql`
          insert into wa_link_codes (id, workspace_id, created_by, code_salt, code_hash, phone_hash,
                                     expires_at)
          values (${uuidv7()}, app_current_workspace_id(), app_current_user_id(), ${"a".repeat(32)},
                  ${"b".repeat(64)}, ${"c".repeat(64)}, now() + interval '5 minutes')`),
      ).catch((e: unknown) => e);
      expect(pgErrorInfo(err).code).toBe("42501");
    }
    const jid = newJid();
    await sync(jid);
    await expect(
      appPool.query("select public.app_wa_redeem_link_code($1, $2, 'ABCDEFGH', $3)", [
        conn,
        jid,
        PN_O,
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    expect((await groupRow(jid)).workspace_id).toBeNull();
    const err = await as(O, ws, (tx) =>
      tx.execute(sql`
        insert into wa_link_managers (workspace_id, user_id, granted_by)
        values (app_current_workspace_id(), ${M.id}, app_current_user_id())`),
    ).catch((e: unknown) => e);
    expect(pgErrorInfo(err).code).toBe("42501");
    expect(await as(M, ws, (tx, ctx) => canManageWhatsapp(tx, ctx))).toBe(false);
    expect(await as(O, ws, (tx, ctx) => canManageWhatsapp(tx, ctx))).toBe(true);
  });
});

describe("mesaj kaydı", () => {
  let jid = "";
  let groupId = "";

  beforeAll(async () => {
    jid = newJid();
    await sync(jid, true, "Defne Operasyon");
    groupId = (await groupRow(jid)).id;
    expect(await adminLink(admin, adminId, groupId, ws, villa)).toBe("linked");
  });

  it("bağlı grupta kaydedilir; aynı mesaj ikinci kez kaydedilmez; boş mesaj atlanır", async () => {
    expect(await ingest(jid, "Villa Defne 12-15 Temmuz dolu", `D${tag}`)).toBe("stored");
    expect(await ingest(jid, "Villa Defne 12-15 Temmuz dolu", `D${tag}`)).toBe("duplicate");
    expect(await ingest(jid, "   ")).toBe("ignored");
    const msgs = await as(O, ws, (tx, ctx) => listRecentMessages(tx, ctx, groupId));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ body: "Villa Defne 12-15 Temmuz dolu", senderPn: PN_O });
    const groups = await as(O, ws, (tx, ctx) => listGroups(tx, ctx));
    expect(groups.find((g) => g.id === groupId)).toMatchObject({
      status: "linked",
      messages7d: 1,
    });
  });

  it("mesajları owner ve manager görür; staff ve diğer işletme göremez", async () => {
    expect(await as(M2, ws, (tx, ctx) => listRecentMessages(tx, ctx, groupId))).toHaveLength(1);
    await expect(
      as(S, ws, (tx, ctx) => listRecentMessages(tx, ctx, groupId)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const staffDirect = await as(S, ws, (tx) =>
      tx.execute(sql`select id from wa_inbound_messages`),
    );
    expect(staffDirect.rows).toEqual([]);
    const staffGroups = await as(S, ws, (tx, ctx) => listGroups(tx, ctx));
    expect(staffGroups.find((g) => g.id === groupId)).toMatchObject({ messages7d: null });
    const otherDirect = await as(X, wsX, (tx) =>
      tx.execute(sql`select id from wa_inbound_messages`),
    );
    expect(otherDirect.rows).toEqual([]);
    expect(await as(X, wsX, (tx, ctx) => listRecentMessages(tx, ctx, groupId))).toEqual([]);
  });

  it("pasif grubun mesajı kaydedilmez; işletme rolü durumu değiştiremez", async () => {
    for (const [u, w] of [
      [O, ws],
      [M, ws],
      [X, wsX],
    ] as const) {
      const err = await as(u, w, (tx) =>
        tx.execute(sql`update wa_groups set status = 'suspended' where id = ${groupId}`),
      ).catch((e: unknown) => e);
      expect(pgErrorInfo(err).code).toBe("42501");
    }
    expect(await adminSetActive(admin, adminId, groupId, false)).toBe("changed");
    expect(await ingest(jid)).toBe("ignored");
    // İşletme pasif grubunu salt okunur görür.
    expect(
      (await as(O, ws, (tx, ctx) => listGroups(tx, ctx))).find((g) => g.id === groupId),
    ).toMatchObject({ status: "suspended" });
    expect(await adminSetActive(admin, adminId, groupId, true)).toBe("changed");
    expect(await ingest(jid)).toBe("stored");
  });

  it("gruptan çıkarılınca 'ayrıldı'; yeniden eklenince pasif başlar", async () => {
    expect(await sync(jid, false)).toBe("left");
    expect(await ingest(jid)).toBe("ignored");
    expect(await adminSetActive(admin, adminId, groupId, true)).toBe("not_available");
    expect(await sync(jid, true)).toBe("suspended");
    expect((await groupRow(jid)).workspace_id).toBe(ws);
    expect(await adminSetActive(admin, adminId, groupId, true)).toBe("changed");
    expect(await ingest(jid)).toBe("stored");
  });

  it("90 günden eski mesajlar silinir", async () => {
    expect(WA_RETENTION_DAYS).toBe(90);
    await ingest(jid, "eski mesaj", `OLD${tag}`);
    await admin.query(
      "update wa_inbound_messages set received_at = now() - interval '91 days' where wa_message_id = $1",
      [`OLD${tag}`],
    );
    const before = await admin.query(
      "select count(*)::int n from wa_inbound_messages where group_id = $1",
      [groupId],
    );
    expect(await gw<number>("select public.app_wa_purge_messages($1) as out", [90])).toBe(1);
    const after = await admin.query(
      "select count(*)::int n from wa_inbound_messages where group_id = $1",
      [groupId],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n - 1);
    // 0032: 90 günden kısa (ve 365'ten uzun) süre reddedilir; hiçbir şey silinmez.
    // 30 günlük mesaj: kısa süreli silme denemeleri onu silememeli.
    expect(await ingest(jid, "30 günlük mesaj", `M30${tag}`)).toBe("stored");
    await admin.query(
      "update wa_inbound_messages set received_at = now() - interval '30 days' where wa_message_id = $1",
      [`M30${tag}`],
    );
    const recent = await admin.query("select count(*)::int n from wa_inbound_messages");
    for (const days of [0, 1, 30, 89, 366, null]) {
      await expect(
        appPool.query("select public.app_wa_purge_messages($1::int)", [days]),
        String(days),
      ).rejects.toMatchObject({ code: "23514" });
    }
    const still = await admin.query("select count(*)::int n from wa_inbound_messages");
    expect(still.rows[0].n).toBe(recent.rows[0].n);
    expect(await gw<number>("select public.app_wa_purge_messages($1) as out", [90])).toBe(0);
    expect(await gw<number>("select public.app_wa_purge_messages($1) as out", [365])).toBe(0);
    const kept = await admin.query(
      "select count(*)::int n from wa_inbound_messages where wa_message_id = $1",
      [`M30${tag}`],
    );
    expect(kept.rows[0].n).toBe(1);
  });

  it("bağlantı kaldırılınca mesajlar silinir; grup hiçbir işletmeye görünmez", async () => {
    // İşletme rolü (sahip dahil) bağlantıyı kaldıramaz.
    for (const u of [O, S]) {
      const err = await as(u, ws, (tx) =>
        tx.execute(sql`select public.app_wa_unlink_group(${groupId}::uuid)`),
      ).catch((e: unknown) => e);
      expect(pgErrorInfo(err).code).toBe("42501");
    }
    expect(await adminUnlink(admin, adminId, groupId)).toBe("unlinked");
    const n = await admin.query(
      "select count(*)::int n from wa_inbound_messages where group_id = $1",
      [groupId],
    );
    expect(n.rows[0].n).toBe(0);
    expect(await groupRow(jid)).toMatchObject({ status: "discovered", workspace_id: null });
    expect((await as(O, ws, (tx, ctx) => listGroups(tx, ctx))).map((g) => g.id)).not.toContain(
      groupId,
    );
    expect(await ingest(jid)).toBe("ignored");
    const audit = await admin.query(
      "select workspace_id, actor_user_id from audit_log where action = 'whatsapp.group_unlinked' and target_id = $1",
      [groupId],
    );
    expect(audit.rows).toEqual([{ workspace_id: ws, actor_user_id: null }]);
  });
});

describe("veritabanı güvenliği", () => {
  const denied = async (q: ReturnType<typeof sql>, u: U = O, w = () => ws) => {
    const err = await as(u, w(), (tx) => tx.execute(q)).catch((e: unknown) => e);
    return pgErrorInfo(err).code;
  };

  it("app_user tablolara doğrudan yazamaz (yalnız tanımlı kolonlar)", async () => {
    expect(
      await denied(sql`insert into wa_groups (id, connection_id, jid, status)
                       values (${uuidv7()}, ${conn}, ${newJid()}, 'discovered')`),
    ).toBe("42501");
    expect(await denied(sql`update wa_groups set workspace_id = ${wsX}`)).toBe("42501");
    expect(await denied(sql`update wa_connections set status = 'open'`)).toBe("42501");
    expect(await denied(sql`insert into wa_inbound_messages (id) values (${uuidv7()})`)).toBe(
      "42501",
    );
    expect(await denied(sql`delete from wa_inbound_messages`)).toBe("42501");
    expect(await denied(sql`select link_fail_count from wa_groups`)).toBe("42501");
    expect(await denied(sql`select last_error_code from wa_connections`)).toBe("42501");
    expect(await denied(sql`select sender_jid from wa_inbound_messages`)).toBe("42501");
  });

  it("bağlamsız app_user hiçbir satır görmez; app.wa_fn ayarı ona bir şey açmaz", async () => {
    const c = await appPool.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.wa_fn', 'on', true)");
      for (const t of ["wa_connections", "wa_groups", "wa_link_codes", "wa_inbound_messages"]) {
        const r = await c.query(`select id from ${t}`);
        expect(r.rows, t).toEqual([]);
      }
      await c.query("rollback");
    } finally {
      c.release();
    }
  });

  it("fonksiyonlar app.wa_fn ayarını geri bırakır ve app_migrator sahipliğinde", async () => {
    const c = await appPool.connect();
    try {
      await c.query("begin");
      await c.query("select public.app_wa_heartbeat($1, 'open', null)", [`t-${tag}`]);
      const r = await c.query("select coalesce(current_setting('app.wa_fn', true), '') v");
      expect(r.rows[0].v).toBe("");
      await c.query("rollback");
    } finally {
      c.release();
    }
    const fns = await admin.query(`
      select p.proname, pg_get_userbyid(p.proowner) owner, p.prosecdef definer, p.prosrc,
             p.proconfig,
             has_function_privilege('app_worker', p.oid, 'EXECUTE') worker,
             has_function_privilege('app_admin', p.oid, 'EXECUTE') adm,
             has_function_privilege('app_user', p.oid, 'EXECUTE') app_user
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like 'app_wa_%' order by p.proname`);
    // 0036 (A2): takvim önerisi worker'ı, durum makinesi tetikleyicisi ve güvenli başlangıç.
    const A2 = [
      "app_wa_busy",
      "app_wa_calendar_cutover",
      "app_wa_claim_messages",
      "app_wa_expire_proposals",
      "app_wa_fail_message",
      "app_wa_message_context",
      "app_wa_message_sender", // 0038 (A2e): kilitli mesajın gönderen kullanıcısı (yalnız okuma)
      "app_wa_queue_reaction", // 0040 (A2f): öneri durumunu okur (tepki kararı doğrulaması)
      "app_wa_proposals_guard",
      "app_wa_sender_role",
      "app_wa_store_proposals",
    ];
    // 0044 (Aşama 2): Super Admin grup yönetimi; YALNIZ app_admin çağırır.
    const ADMIN = [
      "app_wa_admin_archive_group",
      "app_wa_admin_connections",
      "app_wa_admin_groups",
      "app_wa_admin_link_group",
      "app_wa_admin_properties",
      "app_wa_admin_set_active",
      "app_wa_admin_set_property",
      "app_wa_admin_unlink_group",
      "app_wa_admin_workspaces",
    ];
    // 0044: işletme rolünden kaldırılan eşleştirme fonksiyonları (kimse çağıramaz).
    const REVOKED = [
      "app_wa_claim_group",
      "app_wa_pending_groups",
      "app_wa_redeem_link_code",
      "app_wa_unlink_group",
    ];
    expect(fns.rows.map((r) => r.proname)).toEqual([
      ...ADMIN,
      "app_wa_busy", // 0036
      "app_wa_calendar_cutover", // 0036 (yalnız migration; kimseye açık değil)
      "app_wa_can_manage",
      "app_wa_claim_group", // 0034
      "app_wa_claim_messages", // 0036
      "app_wa_claim_reactions", // 0040
      "app_wa_expire_proposals", // 0036
      "app_wa_fail_message", // 0036
      "app_wa_finish_reaction", // 0040
      "app_wa_heartbeat",
      "app_wa_heartbeat", // 0034: 4 parametreli (asistan numarası)
      "app_wa_ingest_message",
      "app_wa_lock_group_for_auto_close", // 0045
      "app_wa_message_context", // 0036
      "app_wa_message_sender", // 0038
      "app_wa_pending_groups", // 0034
      "app_wa_phone_hash", // 0034 (yalnız fonksiyonlar içinden)
      "app_wa_proposals_guard", // 0036 (tetikleyici)
      "app_wa_purge_messages",
      "app_wa_queue_reaction", // 0040
      "app_wa_redeem_link_code",
      "app_wa_sender_role", // 0036 (yalnız fonksiyonlar içinden)
      "app_wa_store_proposals", // 0036
      "app_wa_sync_group",
      "app_wa_sync_group", // 0034: 9 parametreli (ekleyen/kurucu)
      "app_wa_unlink_group",
      "app_wa_verify_phone", // 0034
    ]);
    for (const f of fns.rows) {
      expect(f.owner, f.proname).toBe("app_migrator");
      expect(f.definer, f.proname).toBe(
        ![
          "app_wa_can_manage",
          "app_wa_phone_hash",
          "app_wa_calendar_cutover",
          "app_wa_proposals_guard",
          "app_wa_sender_role",
        ].includes(f.proname),
      );
      expect(f.proconfig, f.proname).toContain("search_path=pg_catalog, pg_temp");
      expect(f.worker, f.proname).toBe(false);
      expect(f.adm, f.proname).toBe(ADMIN.includes(f.proname));
      if (ADMIN.includes(f.proname) || REVOKED.includes(f.proname)) {
        expect(f.app_user, f.proname).toBe(false);
      }
      // HİÇBİR WhatsApp fonksiyonu rezervasyon, fiyat veya iCal tablolarına yazmaz.
      expect(f.prosrc, f.proname).not.toMatch(
        /(insert\s+into|update|delete\s+from)\s+public\.(reservations|property_rates|external_calendar|property_ical)/i,
      );
      // A1 kapsamı: rezervasyon, fiyat, takvim ve iCal nesnelerine hiç dokunulmaz. (0034'teki
      // eşleştirme villayı yalnız bileşik yabancı anahtarla doğrular; properties tablosunu okumaz.)
      // A2 worker'ı rezervasyon ve harici olayları YALNIZ OKUR (tests/integration/wa-calendar-proposals.test.ts).
      // Super Admin fonksiyonları villayı (properties) doğrulamak için okur, önerileri sona erdirir.
      if (!A2.includes(f.proname) && !ADMIN.includes(f.proname)) {
        expect(f.prosrc, f.proname).not.toMatch(
          /reservation|property_rate|external_calendar|ical|public\.propert/i,
        );
      }
    }
  });

  it("tüm A1 tabloları FORCE RLS; PUBLIC / app_worker / app_admin yetkisi yok", async () => {
    const t = await admin.query(`
      select c.relname, c.relrowsecurity rls, c.relforcerowsecurity force,
             has_table_privilege('app_worker', c.oid, 'SELECT') worker,
             has_table_privilege('app_admin', c.oid, 'SELECT') adm
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname like 'wa\\_%' and c.relkind = 'r'
       order by c.relname`);
    expect(t.rows).toEqual(
      [
        "wa_calendar_proposals", // 0035 (A2)
        "wa_calendar_worker_state", // 0037 (A2c)
        "wa_connections",
        "wa_groups",
        "wa_inbound_messages",
        "wa_link_codes",
        "wa_link_managers",
        "wa_message_reactions", // 0039/0040 (A2f)
        "wa_phone_challenges", // 0033
        "wa_verified_phones", // 0033
      ].map((relname) => ({ relname, rls: true, force: true, worker: false, adm: false })),
    );
  });
});
