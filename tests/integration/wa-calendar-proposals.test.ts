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
import { addDays, istanbulToday } from "@/lib/reservation-meta";
import { WA_CALENDAR_PARSER_VERSION } from "@/lib/wa-calendar-parse";
import { createProperty } from "@/server/properties/service";
import { createReservation } from "@/server/reservations/service";
import { addWorkspaceMember, createWorkspace } from "@/server/workspaces/service";

import { adminUnlink, createTestAdmin } from "./wa-admin";

/**
 * WhatsApp Asistanı A2a — takvim önerileri veri modeli (drizzle/0035, 0036). Gerçek PostgreSQL,
 * app_user, FORCE RLS. Worker henüz yok: worker'ın yapacağı çağrılar (iş alma → bağlam → çakışma →
 * kayıt / hata) burada doğrudan SQL ile taklit edilir; panel withTenant ile çalışır.
 *
 * Güvenlik özü:
 *  - worker fonksiyonları rezervasyonlara YAZMAZ; işletme kimliğini kilitli mesajdan bulur;
 *  - öneri yalnız oturumdaki owner/manager tarafından onaylanır/reddedilir; karar verilmiş öneri
 *    değişmez; "tek tık" yalnız nedensiz kapatma (veritabanı CHECK'i, güven puanından bağımsız);
 *  - güvenli başlangıç: worker öncesi kuyrukta bekleyen mesajlar öneri üretmez.
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 8 });
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
const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) => pgErrorInfo(e).code ?? "error",
  );
const phoneHash = (pn: string) => createHash("sha256").update(`wa-phone:${pn}`).digest("hex");

const PN_OWNER = "905321220001";
const PN_STAFF = "905321220003";
const PN_MANAGER = "905321220002";
const PN_STRANGER = "905321220009";
const PN_X = "905321220019"; // başka işletmenin sahibi
const TODAY = istanbulToday();
const day = (n: number) => addDays(TODAY, n);

let O: U, M: U, S: U, X: U;
let ws: string, wsX: string;
let mavi: string, asya: string, pasif: string, villaX: string;
let conn: string;
const planCode = `wa_cal_${tag}`;

let jidN = 0;
const jidBase = BigInt(`0x${randomBytes(4).toString("hex")}`) % 10_000_000n;
const newJid = () =>
  `120363${String(jidBase).padStart(7, "0")}${String(++jidN).padStart(5, "0")}@g.us`;

/** Grup keşfi (ağ geçidi) + bağlama (test kurulumu: doğrudan). */
async function linkedGroup(
  w: string,
  property: string | null,
): Promise<{ id: string; jid: string }> {
  const jid = newJid();
  await appPool.query("select public.app_wa_sync_group($1, $2, 'Ekip', 4, false, false, true)", [
    conn,
    jid,
  ]);
  const id = (await admin.query("select id from wa_groups where jid = $1", [jid])).rows[0].id;
  await admin.query(
    "update wa_groups set status = 'linked', workspace_id = $2, property_id = $3, linked_at = now() where id = $1",
    [id, w, property],
  );
  return { id, jid };
}

let msgN = 0;
/** Ağ geçidi: mesaj kaydı. Dönüş: wa_inbound_messages.id */
async function ingest(
  jid: string,
  body: string,
  pn: string | null = PN_OWNER,
  opts: { kind?: "live" | "backlog"; sentAt?: string } = {},
): Promise<string> {
  const mid = `W${tag}${++msgN}`;
  const out = await appPool.query<{ s: string }>(
    "select public.app_wa_ingest_message($1, $2, $3, '1@lid', $4, null, $5, coalesce($6::timestamptz, now()), $7) as s",
    [conn, jid, mid, pn, body, opts.sentAt ?? null, opts.kind ?? "live"],
  );
  expect(out.rows[0]!.s).toBe("stored");
  return (await admin.query("select id from wa_inbound_messages where wa_message_id = $1", [mid]))
    .rows[0].id;
}

type Claimed = {
  message_id: string;
  lock_token: string;
  workspace_id: string;
  group_id: string;
  group_property_id: string | null;
  body: string;
  sent_at: Date;
  sender_hash: string | null;
  sender_role: "owner" | "manager" | "staff";
  sender_verified: boolean;
  attempts: number;
};
const claim = async (limit = 50, q: Pool | Client = appPool) =>
  (await q.query<Claimed>("select * from public.app_wa_claim_messages($1)", [limit])).rows;
/** Yalnız belirtilen mesajı içeren iş (testler aynı veritabanında paralel değil). */
async function claimOne(messageId: string): Promise<Claimed> {
  const rows = await claim();
  const c = rows.find((r) => r.message_id === messageId);
  expect(c, "mesaj alınmalı").toBeDefined();
  return c!;
}

type Item = Record<string, unknown>;
const item = (over: Item = {}): Item => ({
  item_no: 0,
  parser_version: WA_CALENDAR_PARSER_VERSION,
  message_excerpt: "Villa Mavi kapalı",
  action: "close",
  villa_name_raw: "Mavi",
  property_id: mavi,
  villa_resolution: "named",
  candidate_property_ids: [],
  check_in: day(30),
  check_out: day(35),
  reservation_status: null,
  flags: ["year_inferred"],
  conflicts: [],
  score: 100,
  band: "high",
  review_reasons: [],
  ...over,
});
const store = (c: { message_id: string; lock_token: string }, items: Item[]) =>
  appPool.query<{ n: number }>("select public.app_wa_store_proposals($1, $2, $3::jsonb) as n", [
    c.message_id,
    c.lock_token,
    JSON.stringify(items),
  ]);
const msgRow = async (id: string) =>
  (
    await admin.query(
      "select status, attempts, lock_token, locked_until, processed_at, last_error from wa_inbound_messages where id = $1",
      [id],
    )
  ).rows[0];
const proposalsOf = async (messageId: string) =>
  (
    await admin.query(
      "select * from wa_calendar_proposals where message_id = $1 order by item_no",
      [messageId],
    )
  ).rows;

/** Uçtan uca (worker taklidi): mesaj → iş → öneri. Dönüş: öneri satırı. */
async function proposal(jid: string, over: Item = {}, body = "Villa Mavi kapalı") {
  const m = await ingest(jid, body);
  const c = await claimOne(m);
  await store(c, [item(over)]);
  return (await proposalsOf(m))[0];
}

async function villa(owner: U, w: string, name: string) {
  return as(owner, w, (tx, ctx) =>
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

let G: { id: string; jid: string };

beforeAll(async () => {
  await admin.connect();
  O = await mkUser("waco");
  M = await mkUser("wacm");
  S = await mkUser("wacs");
  X = await mkUser("wacx");
  ws = (await createWorkspace(app, { userId: O.id, name: "Takvim", slug: `wac-${tag}` })).id;
  wsX = (await createWorkspace(app, { userId: X.id, name: "Başka", slug: `wacx-${tag}` })).id;
  const planId = uuidv7();
  await admin.query(
    "insert into plans (id, code, name, max_properties, trial_days, is_active, is_default) values ($1, $2, 'WA cal', 20, 14, true, false)",
    [planId, planCode],
  );
  await admin.query("update workspace_subscriptions set plan_id = $1 where workspace_id = $2", [
    planId,
    ws,
  ]);
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: M.id, role: "manager" }));
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: S.id, role: "staff" }));
  mavi = await villa(O, ws, "Villa Mavi");
  asya = await villa(O, ws, "Villa Asya");
  pasif = await villa(O, ws, "Villa Pasif");
  await admin.query("update properties set status = 'passive' where id = $1", [pasif]);
  villaX = await villa(X, wsX, "Başka Villa");
  conn = (
    await appPool.query<{ id: string }>("select public.app_wa_heartbeat($1, 'open', null) as id", [
      `wac-${tag}`,
    ])
  ).rows[0]!.id;
  // Doğrulanmış numaralar: owner ve staff (staff'ın numarası doğrulanmış olsa da yetkili sayılmaz).
  for (const [u, pn] of [
    [O, PN_OWNER],
    [M, PN_MANAGER],
    [S, PN_STAFF],
    [X, PN_X],
  ] as const) {
    await admin.query(
      "insert into wa_verified_phones (user_id, phone_hash, phone_masked) values ($1, $2, '+90 532 *** ** 01')",
      [u.id, phoneHash(pn)],
    );
  }
  G = await linkedGroup(ws, mavi);
  // Önceki dosyaların bıraktığı bekleyen mesajlar bu testleri etkilemesin.
  await admin.query("select public.app_wa_calendar_cutover()");
  // A2c (0037): worker ilk iş almada etkinleşir ve o ana kadarki mesajları yok sayar. Bu dosyanın
  // mesajları etkinleşmeden SONRA gelsin diye burada etkinleştirilir (zaten etkinse değişmez).
  await appPool.query("select * from public.app_wa_claim_messages(1)");
});

afterAll(async () => {
  // Diğer test dosyaları kuyruğu boş varsayar (whatsapp-groups): bu dosyanın mesajları silinir;
  // öneriler kalır (message_id boşalır — yabancı anahtar, durum makinesinin bakım yolu).
  await admin.query("delete from wa_inbound_messages where workspace_id = any($1)", [[ws, wsX]]);
  await admin.query(
    "update workspace_subscriptions set plan_id = (select id from plans where is_default) where workspace_id = $1",
    [ws],
  );
  await admin.query("delete from plans where code = $1", [planCode]);
  await admin.end();
  await appPool.end();
});

describe("veri modeli ve yetkiler", () => {
  it("wa_calendar_proposals: ENABLE + FORCE RLS; app_user yalnız SELECT/UPDATE (owner/manager), INSERT/DELETE yok", async () => {
    const f = await admin.query(
      "select relrowsecurity r, relforcerowsecurity f from pg_class where relname = 'wa_calendar_proposals'",
    );
    expect(f.rows[0]).toEqual({ r: true, f: true });
    const pol = await admin.query(
      "select policyname, cmd, roles::text[] as roles from pg_policies where tablename = 'wa_calendar_proposals' order by 1",
    );
    expect(pol.rows.map((x) => [x.policyname, x.cmd, x.roles])).toEqual([
      ["wa_calendar_proposals_fn", "ALL", ["app_migrator"]],
      ["wa_calendar_proposals_select", "SELECT", ["app_user"]],
      ["wa_calendar_proposals_update", "UPDATE", ["app_user"]],
    ]);
    const t = await admin.query(`
      select case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as rol, a.privilege_type
        from pg_class c, aclexplode(c.relacl) a
       where c.relname = 'wa_calendar_proposals' and a.grantee <> c.relowner order by 1, 2`);
    expect(t.rows).toEqual([{ rol: "app_user", privilege_type: "SELECT" }]);
    const cols = await admin.query(`
      select privilege_type, string_agg(column_name, ',' order by column_name) as cols
        from information_schema.column_privileges
       where table_schema = 'public' and table_name = 'wa_calendar_proposals' and grantee = 'app_user'
         and privilege_type in ('INSERT', 'UPDATE')
       group by 1 order by 1`);
    expect(cols.rows).toEqual([
      {
        privilege_type: "UPDATE",
        cols: "action,applied_reservation_ids,check_in,check_out,decided_at,decided_by,decision_mode,decision_note,decision_reasons,edited,property_id,reservation_status,status,target_reservation_ids",
      },
    ]);
  });

  it("wa_inbound_messages: yeni durumlar ve hata kodu biçimi; app_user kuyruk kolonlarını göremez", async () => {
    const chk = await admin.query(
      "select pg_get_constraintdef(oid) d from pg_constraint where conname = 'wa_inbound_messages_status_check'",
    );
    expect(chk.rows[0].d).toContain("'processing'");
    expect(chk.rows[0].d).toContain("'failed'");
    const m = await ingest(G.jid, "Merhaba");
    expect(
      await code(
        admin.query("update wa_inbound_messages set last_error = 'Mesaj: Villa A' where id = $1", [
          m,
        ]),
      ),
    ).toBe("23514");
    expect(
      await code(
        as(O, ws, (tx) =>
          tx.execute(sql`select lock_token, attempts, processed_at from wa_inbound_messages`),
        ),
      ),
    ).toBe("42501");
    await admin.query("select public.app_wa_calendar_cutover()");
  });

  it("rezervasyon: 'whatsapp' kaynağı kabul edilir; origin_proposal_id app_user'a INSERT ile açık, başka işletmenin önerisine bağlanamaz", async () => {
    const chk = await admin.query(
      "select pg_get_constraintdef(oid) d from pg_constraint where conname = 'reservations_source_check'",
    );
    expect(chk.rows[0].d).toContain("'whatsapp'");
    const ins = await admin.query(`
      select string_agg(column_name, ',' order by column_name) as cols
        from information_schema.column_privileges
       where table_schema = 'public' and table_name = 'reservations' and grantee = 'app_user'
         and privilege_type = 'INSERT'`);
    expect(ins.rows[0].cols).toContain("origin_proposal_id");
    const gX = await linkedGroup(wsX, villaX);
    const mx = await ingest(gX.jid, "Başka Villa kapalı", PN_X);
    const cx = await claimOne(mx);
    await store(cx, [item({ property_id: villaX, villa_name_raw: "Başka" })]);
    const px = (await proposalsOf(mx))[0];
    const r = await code(
      as(O, ws, (tx) =>
        tx.execute(sql`
          insert into reservations (id, workspace_id, property_id, kind, status, check_in, check_out, created_by, origin_proposal_id)
          values (${uuidv7()}, app_current_workspace_id(), ${mavi}, 'block', 'confirmed', ${day(200)}, ${day(201)}, app_current_user_id(), ${px.id})`),
      ),
    );
    expect(r).toBe("23503");
  });

  it("ağ geçidi rolüne yeni yetki yok; güvenli başlangıç fonksiyonunu app_user çağıramaz", async () => {
    expect(await code(appPool.query("select public.app_wa_calendar_cutover()"))).toBe("42501");
    expect(
      await code(appPool.query("select public.app_wa_sender_role(gen_random_uuid(), 'x')")),
    ).toBe("42501");
  });
});

describe("güvenli başlangıç (worker öncesi kuyruk)", () => {
  it("bekleyen tüm mesajlar 'ignored' olur; sonra iş almada hiçbiri görünmez", async () => {
    const live = await ingest(G.jid, "Villa Mavi 15-20 Haziran kapalı");
    const back = await ingest(G.jid, "Villa Mavi 1-5 Temmuz kapalı", PN_OWNER, { kind: "backlog" });
    expect((await msgRow(live)).status).toBe("received");
    const n = (await admin.query("select public.app_wa_calendar_cutover() as n")).rows[0].n;
    expect(n).toBeGreaterThanOrEqual(2);
    for (const id of [live, back]) {
      expect(await msgRow(id)).toMatchObject({ status: "ignored", last_error: "before_worker" });
    }
    const got = await claim();
    expect(got.map((r) => r.message_id)).not.toContain(live);
    expect(await proposalsOf(live)).toEqual([]);
  });

  it("migration (0036) güvenli başlangıcı çalıştırır", async () => {
    const src = await admin.query(
      "select prosrc from pg_proc where proname = 'app_wa_calendar_cutover'",
    );
    expect(src.rows[0].prosrc).toMatch(/status IN \('received', 'processing'\)/);
  });
});

describe("worker: iş alma", () => {
  it("yalnız canlı, yakın tarihli ve bağlı gruptaki mesajları alır; diğerleri 'ignored'", async () => {
    const ok = await ingest(G.jid, "Villa Mavi kapalı");
    const back = await ingest(G.jid, "x", PN_OWNER, { kind: "backlog" });
    const old = await ingest(G.jid, "x", PN_OWNER, {
      sentAt: new Date(Date.now() - 8 * 86_400_000).toISOString(),
    });
    const g2 = await linkedGroup(ws, null);
    const orphan = await ingest(g2.jid, "x");
    await admin.query("update wa_groups set status = 'suspended' where id = $1", [g2.id]);
    const rows = await claim();
    expect(rows.map((r) => r.message_id)).toEqual([ok]);
    expect(await msgRow(back)).toMatchObject({ status: "ignored", last_error: "backlog" });
    expect(await msgRow(old)).toMatchObject({ status: "ignored", last_error: "too_old" });
    expect(await msgRow(orphan)).toMatchObject({
      status: "ignored",
      last_error: "group_not_linked",
    });
    const c = rows[0]!;
    expect(c).toMatchObject({
      workspace_id: ws,
      group_id: G.id,
      group_property_id: mavi,
      body: "Villa Mavi kapalı",
      sender_hash: phoneHash(PN_OWNER),
      sender_role: "owner",
      sender_verified: true,
      attempts: 1,
    });
    // Ham numara döndürülmez.
    expect(Object.keys(c)).not.toContain("sender_pn");
    expect(await msgRow(ok)).toMatchObject({ status: "processing", attempts: 1 });
    await store(c, []);
  });

  it("GÖNDEREN POLİTİKASI: owner/manager doğrulanmış; staff ayrı rol; kayıtsız numara hiç işlenmez", async () => {
    for (const [pn, role, verified] of [
      [PN_OWNER, "owner", true],
      [PN_MANAGER, "manager", true],
      [PN_STAFF, "staff", false],
    ] as const) {
      const m = await ingest(G.jid, "x", pn);
      const c = await claimOne(m);
      expect([pn, c.sender_role, c.sender_verified, c.sender_hash]).toEqual([
        pn,
        role,
        verified,
        phoneHash(pn),
      ]);
      await store(c, []);
    }
    // Kayıtsız numara, başka işletmenin doğrulanmış numarası ve çözülemeyen gönderen (LID):
    // iş olarak alınmaz, öneri üretmez.
    for (const pn of [PN_STRANGER, PN_X, null]) {
      const m = await ingest(G.jid, "Villa Mavi 15-20 Haziran kapalı", pn);
      expect((await claim()).map((r) => r.message_id)).not.toContain(m);
      expect([pn, await msgRow(m)]).toMatchObject([
        pn,
        { status: "ignored", last_error: "sender_not_authorized" },
      ]);
      expect(await proposalsOf(m)).toEqual([]);
    }
  });

  it("GÖNDEREN POLİTİKASI: iş alındıktan sonra yetki kalkarsa öneri yazılmaz", async () => {
    const m = await ingest(G.jid, "Villa Mavi kapalı", PN_MANAGER);
    const c = await claimOne(m);
    await admin.query("delete from wa_verified_phones where user_id = $1", [M.id]);
    try {
      expect((await store(c, [item()])).rows[0]!.n).toBe(0);
      expect(await msgRow(m)).toMatchObject({
        status: "ignored",
        last_error: "sender_not_authorized",
      });
      expect(await proposalsOf(m)).toEqual([]);
    } finally {
      await admin.query(
        "insert into wa_verified_phones (user_id, phone_hash, phone_masked) values ($1, $2, '+90 532 *** ** 02')",
        [M.id, phoneHash(PN_MANAGER)],
      );
    }
  });

  it("kilitli iş ikinci kez alınmaz; eşzamanlı iki iş alma aynı mesajı paylaşmaz (SKIP LOCKED)", async () => {
    const ids = [await ingest(G.jid, "a"), await ingest(G.jid, "b"), await ingest(G.jid, "c")];
    const c1 = new Client({ connectionString: db.appUrl });
    const c2 = new Client({ connectionString: db.appUrl });
    await c1.connect();
    await c2.connect();
    try {
      await c1.query("begin");
      const a = await claim(2, c1);
      // c1 henüz commit etmedi: satırları kilitli; c2 beklemeden kalanları alır.
      const b = await claim(50, c2);
      await c1.query("commit");
      const all = [...a, ...b].map((r) => r.message_id).filter((id) => ids.includes(id));
      expect(new Set(all).size).toBe(all.length);
      expect(all.sort()).toEqual([...ids].sort());
      expect(await claim()).toEqual([]);
      for (const r of [...a, ...b]) await store(r, []);
    } finally {
      await c1.end();
      await c2.end();
    }
  });

  it("kilidi dolan iş yeniden alınır (attempts + 1); geçersiz sınır reddedilir", async () => {
    const m = await ingest(G.jid, "x");
    const first = await claimOne(m);
    expect(await claim()).toEqual([]);
    await admin.query(
      "update wa_inbound_messages set locked_until = now() - interval '1 second' where id = $1",
      [m],
    );
    const again = await claimOne(m);
    expect(again.attempts).toBe(2);
    expect(again.lock_token).not.toBe(first.lock_token);
    // Eski belirteçle kayıt yapılamaz.
    expect(await code(store(first, [item()]))).toBe("55000");
    await store(again, []);
    for (const bad of [0, 51, -1]) expect(await code(claim(bad))).toBe("23514");
  });
});

describe("worker: bağlam ve çakışma özeti (yalnız okuma)", () => {
  it("bağlam: yalnız kilitli mesajın işletmesinin etkin villaları; geçersiz belirteçte boş", async () => {
    const m = await ingest(G.jid, "x");
    const c = await claimOne(m);
    const ctx = await appPool.query("select * from public.app_wa_message_context($1, $2)", [
      m,
      c.lock_token,
    ]);
    expect(ctx.rows.map((r) => r.name).sort()).toEqual(["Villa Asya", "Villa Mavi"]);
    expect(ctx.rows.map((r) => r.property_id)).not.toContain(villaX);
    const bad = await appPool.query("select * from public.app_wa_message_context($1, $2)", [
      m,
      uuidv7(),
    ]);
    expect(bad.rows).toEqual([]);
    await store(c, []);
  });

  it("çakışma: rezervasyon/blok ve harici olay döner; misafir bilgisi yok; başka işletmenin villası boş", async () => {
    const blockId = await as(O, ws, (tx, ctx) =>
      createReservation(tx, ctx, {
        kind: "block",
        propertyId: asya,
        checkIn: day(60),
        checkOut: day(65),
      }),
    );
    const m = await ingest(G.jid, "x");
    const c = await claimOne(m);
    const busy = (from: string, to: string, property = asya) =>
      appPool.query(
        "select kind, record_id, check_in::text, check_out::text, status from public.app_wa_busy($1, $2, $3, $4::date, $5::date)",
        [m, c.lock_token, property, from, to],
      );
    const r = await busy(day(62), day(70));
    expect(r.rows).toEqual([
      {
        kind: "block",
        record_id: blockId,
        check_in: day(60),
        check_out: day(65),
        status: "confirmed",
      },
    ]);
    expect(Object.keys(r.rows[0]!)).not.toContain("guest_name");
    expect((await busy(day(65), day(70))).rows).toEqual([]); // [) : çıkış günü boş
    expect((await busy(day(62), day(70), villaX)).rows).toEqual([]);
    expect(await code(busy(day(70), day(62)))).toBe("23514");
    // Worker fonksiyonu takvime hiçbir şey yazmadı.
    const n = await admin.query("select count(*)::int n from reservations where property_id = $1", [
      asya,
    ]);
    expect(n.rows[0].n).toBe(1);
    await store(c, []);
  });
});

describe("worker: öneri kaydı", () => {
  it("kaydeder; işletme, grup ve gönderen MESAJDAN alınır; mesaj processed olur; tekrar kayıt yok", async () => {
    const m = await ingest(G.jid, "Villa Mavi 15-20 kapalı", PN_STAFF);
    const c = await claimOne(m);
    const n = await store(c, [
      item({ item_no: 0 }),
      // Grup dışı villa (A2c, 0037): bayrak zorunlu; veritabanı villa_needs_review ekler.
      item({
        item_no: 1,
        property_id: asya,
        villa_name_raw: "Asya",
        flags: ["villa_outside_group"],
      }),
    ]);
    expect(n.rows[0]!.n).toBe(2);
    const rows = await proposalsOf(m);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      workspace_id: ws,
      group_id: G.id,
      status: "pending",
      version: 1,
      sender_hash: phoneHash(PN_STAFF),
      sender_role: "staff",
      sender_verified: false,
      // Staff önerisi: worker göndermese de veritabanı nedeni ekler.
      review_reasons: ["staff_review_required"],
      action: "close",
      property_id: mavi,
      parser_version: WA_CALENDAR_PARSER_VERSION,
    });
    expect(rows[1]).toMatchObject({
      property_id: asya,
      review_reasons: ["villa_needs_review", "staff_review_required"],
    });
    expect(await msgRow(m)).toMatchObject({
      status: "processed",
      lock_token: null,
      last_error: null,
    });
    // Aynı belirteçle ikinci çağrı: iş artık bu çalıştırmada değil → hiçbir şey yazılmaz.
    expect(await code(store(c, [item()]))).toBe("55000");
    expect(await proposalsOf(m)).toHaveLength(2);
  });

  it("öneri yoksa mesaj 'ignored'; soru 'noop'; aynı içerik yeniden gelirse 'superseded'", async () => {
    const m1 = await ingest(G.jid, "Merhaba");
    await store(await claimOne(m1), []);
    expect(await msgRow(m1)).toMatchObject({ status: "ignored", last_error: "no_proposal" });

    const q = await proposal(G.jid, { action: null, flags: ["question"], score: 40, band: "low" });
    expect(q.status).toBe("noop");

    const first = await proposal(G.jid, { check_in: day(90), check_out: day(95) });
    const dup = await proposal(G.jid, { check_in: day(90), check_out: day(95) });
    expect(first.status).toBe("pending");
    expect(dup).toMatchObject({ status: "superseded", superseded_by: first.id });
  });

  it("başka işletmenin villası, geçersiz alanlar ve fazla öğe reddedilir; mesaj processing kalır", async () => {
    const m = await ingest(G.jid, "x");
    const c = await claimOne(m);
    expect(await code(store(c, [item({ property_id: villaX })]))).toBe("23503");
    expect(await code(store(c, [item({ action: "delete_all" })]))).toBe("23514");
    expect(await code(store(c, [item({ band: "x" })]))).toBe("23514");
    expect(await code(store(c, [item({ check_in: day(5), check_out: day(5) })]))).toBe("23514");
    expect(await code(store(c, [item({ flags: ["Bad Flag"] })]))).toBe("23514");
    expect(await code(store(c, [item({ action: "reserve", reservation_status: null })]))).toBe(
      "23514",
    );
    expect(
      await code(
        store(
          c,
          Array.from({ length: 11 }, (_, i) => item({ item_no: i })),
        ),
      ),
    ).toBe("23514");
    expect(await proposalsOf(m)).toEqual([]);
    expect((await msgRow(m)).status).toBe("processing");
    // Aday villalar işletmeyle süzülür.
    await store(c, [
      item({
        property_id: null,
        villa_resolution: "ambiguous",
        candidate_property_ids: [mavi, villaX, asya],
      }),
    ]);
    const p = (await proposalsOf(m))[0];
    expect([...p.candidate_property_ids].sort()).toEqual([mavi, asya].sort());
  });

  it("hata: yeniden dene; 5. denemeden sonra failed; kilit dolmuş + sınır aşılmış iş failed olur", async () => {
    const m = await ingest(G.jid, "x");
    let c = await claimOne(m);
    expect(
      await code(
        appPool.query("select public.app_wa_fail_message($1, $2, 'Hata!')", [m, c.lock_token]),
      ),
    ).toBe("23514");
    expect(
      (await appPool.query("select public.app_wa_fail_message($1, $2, 'x') as o", [m, uuidv7()]))
        .rows[0].o,
    ).toBe("lost");
    for (let attempt = 1; attempt <= 5; attempt++) {
      const o = (
        await appPool.query("select public.app_wa_fail_message($1, $2, 'parse_error') as o", [
          m,
          c.lock_token,
        ])
      ).rows[0].o;
      expect([attempt, o]).toEqual([attempt, attempt < 5 ? "retry" : "failed"]);
      if (attempt < 5) c = await claimOne(m);
    }
    expect(await msgRow(m)).toMatchObject({
      status: "failed",
      attempts: 5,
      last_error: "parse_error",
    });

    const m2 = await ingest(G.jid, "y");
    await claimOne(m2);
    await admin.query(
      "update wa_inbound_messages set attempts = 5, locked_until = now() - interval '1 second' where id = $1",
      [m2],
    );
    expect((await claim()).map((r) => r.message_id)).not.toContain(m2);
    expect(await msgRow(m2)).toMatchObject({ status: "failed", last_error: "max_attempts" });
  });
});

describe("öneri: RLS, durum makinesi ve karar", () => {
  const upd = (u: U, w: string, q: ReturnType<typeof sql>) => code(as(u, w, (tx) => tx.execute(q)));

  it("owner ve manager görür; staff ve başka işletme görmez", async () => {
    const p = await proposal(G.jid, { check_in: day(100), check_out: day(103) });
    const see = async (u: U, w: string) =>
      (
        await as(u, w, (tx) =>
          tx.execute<{ id: string }>(sql`select id from wa_calendar_proposals where id = ${p.id}`),
        )
      ).rows.length;
    expect(await see(O, ws)).toBe(1);
    expect(await see(M, ws)).toBe(1);
    expect(await see(S, ws)).toBe(0);
    expect(await see(X, wsX)).toBe(0);
    // Bağlamsız app_user (worker'ın ham bağlantısı) tabloyu doğrudan okuyamaz.
    expect((await appPool.query("select id from wa_calendar_proposals")).rows).toEqual([]);
  });

  it("app_user ekleyemez/silemez; korunan kolonları değiştiremez; düzeltme sürümü artırır", async () => {
    const p = await proposal(G.jid, { check_in: day(110), check_out: day(113) });
    expect(await upd(O, ws, sql`insert into wa_calendar_proposals (id) values (${uuidv7()})`)).toBe(
      "42501",
    );
    expect(await upd(O, ws, sql`delete from wa_calendar_proposals where id = ${p.id}`)).toBe(
      "42501",
    );
    for (const col of [
      "score",
      "flags",
      "workspace_id",
      "message_excerpt",
      "sender_verified",
      "version",
    ]) {
      expect([
        col,
        await upd(
          O,
          ws,
          sql`update wa_calendar_proposals set ${sql.raw(col)} = ${sql.raw(col)} where id = ${p.id}`,
        ),
      ]).toEqual([col, "42501"]);
    }
    expect(
      await upd(
        M,
        ws,
        sql`update wa_calendar_proposals set property_id = ${asya}, check_out = ${day(114)}, edited = true where id = ${p.id}`,
      ),
    ).toBe("ok");
    const after = (
      await admin.query(
        "select version, property_id, edited from wa_calendar_proposals where id = $1",
        [p.id],
      )
    ).rows[0];
    expect(after).toEqual({ version: 2, property_id: asya, edited: true });
    // Başka işletmenin villasına yönlendirilemez (bileşik yabancı anahtar).
    expect(
      await upd(
        O,
        ws,
        sql`update wa_calendar_proposals set property_id = ${villaX} where id = ${p.id}`,
      ),
    ).toBe("23503");
  });

  it("app_user superseded/expired/noop yapamaz; bekleyen öneride karar alanları boş kalır", async () => {
    const p = await proposal(G.jid, { check_in: day(120), check_out: day(123) });
    for (const st of ["superseded", "expired", "noop"]) {
      expect([
        st,
        await upd(O, ws, sql`update wa_calendar_proposals set status = ${st} where id = ${p.id}`),
      ]).toEqual([st, "42501"]);
    }
    expect(
      await upd(O, ws, sql`update wa_calendar_proposals set decided_at = now() where id = ${p.id}`),
    ).toBe("23514");
  });

  it("ret: yalnız oturumdaki kullanıcı adına; sonra öneri değişmez", async () => {
    const p = await proposal(G.jid, { check_in: day(130), check_out: day(133) });
    expect(
      await upd(
        O,
        ws,
        sql`update wa_calendar_proposals set status = 'rejected', decided_by = ${M.id}, decided_at = now() where id = ${p.id}`,
      ),
    ).toBe("42501");
    expect(
      await upd(
        S,
        ws,
        sql`update wa_calendar_proposals set status = 'rejected', decided_by = ${S.id}, decided_at = now() where id = ${p.id}`,
      ),
    ).toBe("ok");
    expect(
      (await admin.query("select status from wa_calendar_proposals where id = $1", [p.id])).rows[0]
        .status,
    ).toBe("pending"); // staff RLS ile göremez → 0 satır
    expect(
      await upd(
        O,
        ws,
        sql`update wa_calendar_proposals set status = 'rejected', decided_by = app_current_user_id(), decided_at = now(), decision_note = 'yanlış villa' where id = ${p.id}`,
      ),
    ).toBe("ok");
    expect(
      await upd(
        O,
        ws,
        sql`update wa_calendar_proposals set decision_note = 'değişti' where id = ${p.id}`,
      ),
    ).toBe("23514");
    expect(
      await upd(
        O,
        ws,
        sql`update wa_calendar_proposals set status = 'pending', decided_at = null, decided_by = null where id = ${p.id}`,
      ),
    ).toBe("23514");
  });

  it("GÜVENLİK: 'tek tık' yalnız nedensiz kapatma — rezervasyon/iptal/açma puan 100 olsa da 'quick' kaydedilemez", async () => {
    const decide = (id: string, mode: string, reasons: string[]) =>
      upd(
        O,
        ws,
        sql`update wa_calendar_proposals set status = 'applied', decided_by = app_current_user_id(), decided_at = now(),
              decision_mode = ${mode}, decision_reasons = ${`{${reasons.join(",")}}`}::text[] where id = ${id}`,
      );
    const reserve = await proposal(G.jid, {
      action: "reserve",
      reservation_status: "confirmed",
      check_in: day(140),
      check_out: day(143),
      score: 100,
      band: "high",
    });
    expect(await decide(reserve.id, "quick", [])).toBe("23514");
    for (const action of ["cancel", "open"]) {
      const p = await proposal(G.jid, {
        action,
        check_in: day(150),
        check_out: day(152),
        score: 100,
      });
      expect([action, await decide(p.id, "quick", [])]).toEqual([action, "23514"]);
    }
    const closeFlagged = await proposal(G.jid, { check_in: day(160), check_out: day(162) });
    expect(await decide(closeFlagged.id, "quick", ["flagged"])).toBe("23514");
    // İncelenmiş onay kabul edilir; nedenler kaydedilir.
    expect(await decide(reserve.id, "reviewed", ["action_requires_review", "flagged"])).toBe("ok");
    const close = await proposal(G.jid, { check_in: day(170), check_out: day(172) });
    expect(await decide(close.id, "quick", [])).toBe("ok");
    const row = (
      await admin.query(
        "select status, decision_mode, decided_by, version from wa_calendar_proposals where id = $1",
        [close.id],
      )
    ).rows[0];
    expect(row).toEqual({
      status: "applied",
      decision_mode: "quick",
      decided_by: O.id,
      version: 2,
    });
    // Uygulanmış öneri değişmez.
    expect(
      await upd(
        O,
        ws,
        sql`update wa_calendar_proposals set check_out = ${day(173)} where id = ${close.id}`,
      ),
    ).toBe("23514");
  });

  it("GÖNDEREN POLİTİKASI: staff önerisi WhatsApp'tan doğrudan takvimi değiştiremez ('tek tık' yok)", async () => {
    const m = await ingest(G.jid, "Villa Mavi kapalı", PN_STAFF);
    await store(await claimOne(m), [item({ check_in: day(175), check_out: day(177) })]);
    const p = (await proposalsOf(m))[0];
    expect(p).toMatchObject({ sender_role: "staff", review_reasons: ["staff_review_required"] });
    const decide = (mode: string, reasons: string) =>
      upd(
        O,
        ws,
        sql`update wa_calendar_proposals set status = 'applied', decided_by = app_current_user_id(), decided_at = now(),
              decision_mode = ${mode}, decision_reasons = ${reasons}::text[] where id = ${p.id}`,
      );
    // Nedensiz kapatma bile staff'tan geliyorsa "tek tık" kaydedilemez.
    expect(await decide("quick", "{}")).toBe("23514");
    // Yönetici incelemesiyle onaylanabilir.
    expect(await decide("reviewed", "{staff_review_required}")).toBe("ok");
    // Veritabanı kuralı: staff satırı "staff_review_required" olmadan var olamaz; rol/doğrulama tutarlı.
    const def = await admin.query(
      "select pg_get_constraintdef(oid) d from pg_constraint where conname = 'wa_calendar_proposals_sender_role'",
    );
    expect(def.rows[0].d).toContain("staff_review_required");
  });

  it("GÜVENLİK: kullanıcısız bağlantı (worker bağlamı) öneriyi onaylayamaz", async () => {
    const p = await proposal(G.jid, { check_in: day(180), check_out: day(182) });
    const mig = new Client({ connectionString: db.migratorUrl });
    await mig.connect();
    try {
      await mig.query("begin");
      await mig.query("select set_config('app.wa_calendar', 'on', true)");
      const r = await code(
        mig.query(
          "update wa_calendar_proposals set status = 'applied', decided_at = now(), decision_mode = 'quick' where id = $1",
          [p.id],
        ),
      );
      await mig.query("rollback");
      expect(r).toBe("42501");
    } finally {
      await mig.end();
    }
  });

  it("onaylanacak öneride villa ve tarihler dolu olmalı", async () => {
    const p = await proposal(G.jid, {
      property_id: null,
      villa_resolution: "none",
      check_in: day(190),
      check_out: day(192),
    });
    expect(
      await upd(
        O,
        ws,
        sql`update wa_calendar_proposals set status = 'applied', decided_by = app_current_user_id(), decided_at = now(), decision_mode = 'reviewed', decision_reasons = '{villa_unresolved}' where id = ${p.id}`,
      ),
    ).toBe("23514");
  });
});

describe("süre, bağlantı kesme ve saklama", () => {
  it("girişi geçmiş bekleyen öneriler 'expired' olur", async () => {
    const past = await proposal(G.jid, { check_in: day(-3), check_out: day(2) });
    const future = await proposal(G.jid, { check_in: day(200), check_out: day(203) });
    const n = (await appPool.query("select public.app_wa_expire_proposals() as n")).rows[0].n;
    expect(n).toBeGreaterThanOrEqual(1);
    const st = async (id: string) =>
      (await admin.query("select status from wa_calendar_proposals where id = $1", [id])).rows[0]
        .status;
    expect(await st(past.id)).toBe("expired");
    expect(await st(future.id)).toBe("pending");
  });

  it("bağlantı kesilince bekleyen öneriler sona erer; mesaj silinir, öneri kalır (message_id boşalır)", async () => {
    const g = await linkedGroup(ws, mavi);
    const pending = await proposal(g.jid, { check_in: day(210), check_out: day(212) });
    const decided = await proposal(g.jid, { check_in: day(220), check_out: day(222) });
    await as(O, ws, (tx) =>
      tx.execute(
        sql`update wa_calendar_proposals set status = 'rejected', decided_by = app_current_user_id(), decided_at = now() where id = ${decided.id}`,
      ),
    );
    // Aşama 2: bağlantıyı yalnız Super Admin kaldırır (işletme rolü çağıramaz).
    const denied = await as(O, ws, (tx) =>
      tx.execute(sql`select public.app_wa_unlink_group(${g.id}::uuid)`),
    ).catch((e: unknown) => e);
    expect(pgErrorInfo(denied).code).toBe("42501");
    expect(await adminUnlink(admin, await createTestAdmin(admin, "proposals"), g.id)).toBe(
      "unlinked",
    );
    const rows = (
      await admin.query(
        "select id, status, message_id, message_excerpt, version from wa_calendar_proposals where id = any($1) order by created_at",
        [[pending.id, decided.id]],
      )
    ).rows;
    expect(rows).toEqual([
      {
        id: pending.id,
        status: "expired",
        message_id: null,
        message_excerpt: "(silindi)",
        version: expect.any(Number),
      },
      {
        id: decided.id,
        status: "rejected",
        message_id: null,
        message_excerpt: "(silindi)",
        version: expect.any(Number),
      },
    ]);
  });

  it("saklama: karar verilmiş eski önerilerin alıntısı boşaltılır; bekleyenler korunur", async () => {
    const decided = await proposal(G.jid, { check_in: day(230), check_out: day(232) });
    const pending = await proposal(G.jid, { check_in: day(240), check_out: day(242) });
    await as(O, ws, (tx) =>
      tx.execute(
        sql`update wa_calendar_proposals set status = 'rejected', decided_by = app_current_user_id(), decided_at = now() where id = ${decided.id}`,
      ),
    );
    // Test kurulumu: kararı 100 gün öncesine taşı (tetikleyiciler geçici olarak kapalı).
    await admin.query("begin");
    await admin.query("set local session_replication_role = replica");
    await admin.query(
      "update wa_calendar_proposals set decided_at = now() - interval '100 days' where id = $1",
      [decided.id],
    );
    await admin.query(
      "update wa_calendar_proposals set updated_at = now() - interval '100 days' where id = $1",
      [pending.id],
    );
    await admin.query("commit");
    await appPool.query("select public.app_wa_purge_messages(90)");
    const ex = async (id: string) =>
      (await admin.query("select message_excerpt from wa_calendar_proposals where id = $1", [id]))
        .rows[0].message_excerpt;
    expect(await ex(decided.id)).toBe("(silindi)");
    expect(await ex(pending.id)).toBe("Villa Mavi kapalı");
    // Alıntı boşaltma app_user'a açık değil.
    expect(
      await code(
        as(O, ws, (tx) =>
          tx.execute(
            sql`update wa_calendar_proposals set message_excerpt = '(silindi)' where id = ${pending.id}`,
          ),
        ),
      ),
    ).toBe("42501");
  });
});
