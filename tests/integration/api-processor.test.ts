import { createHmac, randomBytes } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { DB_CASING } from "@/db/casing";
import * as schema from "@/db/schema";
import { type TenantContext, type Tx, withTenant } from "@/db/tenant";
import { addDays, istanbulToday } from "@/lib/reservation-meta";
import { createApiClient, createApiKey, grantApiAccess } from "@/server/admin/api-clients";
import { changesEndpoint, connectEndpoint, snapshotEndpoint } from "@/server/api/endpoints";
import { type ApiContext, type ApiResult, handleApiRequest } from "@/server/api/handler";
import { processChangesOnce, runApiSync } from "@/server/api/processor";
import { createProperty } from "@/server/properties/service";
import {
  cancelReservation,
  createReservation,
  rescheduleReservation,
} from "@/server/reservations/service";
import { createWorkspace } from "@/server/workspaces/service";

import { createTestAdmin } from "./wa-admin";

/**
 * API 2. aşama, 4. adım — değişiklik işlemcisi (drizzle/0059; src/server/api/processor.ts) ve
 * HMAC-SHA256 cursor imzası. Gerçek PostgreSQL 17; işlemci üretimdeki gibi app_user bağlantısıyla,
 * eşzamanlı senaryolar ayrı bağlantılarda açık transaction'larla.
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 12 });
const app = drizzle(appPool, { schema, casing: DB_CASING });
const adminRolePool = new Pool({ connectionString: db.adminUrl, max: 3 });
adminRolePool.on("connect", (c) => void c.query("set role app_admin"));
const adminDb = drizzle(adminRolePool, { schema, casing: DB_CASING });
const admin = new Client({ connectionString: db.adminUrl });
const tag = randomBytes(3).toString("hex");
const T = istanbulToday();
const d = (n: number) => addDays(T, n);
const FROM = d(-366);
const TO = d(731);

type U = { id: string; email: string };
let O: U;
let ws: string;
let mavi: string, asya: string, bos: string;
let keyA: string;
let connMavi: string;
const planCode = `apip_${tag}`;
const as = <R>(u: U, w: string, fn: (tx: Tx, ctx: TenantContext) => Promise<R>) =>
  withTenant(app, { userId: u.id, workspaceId: w }, fn);
const block = (property: string, a: number, b: number) =>
  as(O, ws, (tx, ctx) =>
    createReservation(tx, ctx, {
      kind: "block",
      propertyId: property,
      checkIn: d(a),
      checkOut: d(b),
    }),
  );

type Busy = { start_date: string; end_date: string };
const truth = async (property: string, from = FROM, to = TO) =>
  (
    await admin.query("select public.app_api_busy_json($1, $2::date, $3::date) j", [
      property,
      from,
      to,
    ])
  ).rows[0].j as Busy[];
const dirtyOf = async (props: string[]) =>
  (
    await admin.query(
      `select property_id p, start_date::text s, end_date::text e, attempts, last_error,
              next_attempt_at, next_attempt_at > now() waiting
         from api_calendar_dirty where property_id = any($1) order by id`,
      [props],
    )
  ).rows;
const changesOf = async (props: string[], after = 0) =>
  (
    await admin.query(
      `select id::text, property_id p, start_date::text s, end_date::text e, busy
         from api_calendar_changes where property_id = any($1) and id > $2 order by id`,
      [props, after],
    )
  ).rows;
const maxChange = async () =>
  Number((await admin.query("select coalesce(max(id), 0) m from api_calendar_changes")).rows[0].m);
const state = async () =>
  (await admin.query("select last_change_id::int l, pruned_through_id::int p from api_sync_state"))
    .rows[0] as {
    l: number;
    p: number;
  };
/** Bekleyen her şeyi işler (başka test dosyalarının birikmiş satırları dahil). */
async function drainAll() {
  for (let i = 0; i < 100; i++) {
    const r = await processChangesOnce(app, 500);
    if (r.processed + r.failed + r.discarded === 0) return;
  }
  throw new Error("işlemci boşalmadı");
}
const settled = (p: Promise<unknown>, ms: number) =>
  Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), ms))]);

async function call(path: string, method: "GET" | "POST" = "GET", body?: unknown) {
  const req = new Request(`https://app.kiraligim.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${keyA}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const rest = new URL(req.url).pathname.split("/").filter(Boolean).slice(2);
  let run: (ctx: ApiContext) => Promise<ApiResult>;
  if (rest.length === 1) run = connectEndpoint;
  else if (rest[2] === "snapshot") run = (c) => snapshotEndpoint(c, rest[1]!);
  else run = (c) => changesEndpoint(c, rest[1]!);
  const res = await handleApiRequest(req, app, "test", run);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
class Model {
  days = new Set<string>();
  cursor = "";
  load(s: Record<string, unknown>) {
    this.days.clear();
    for (const b of s.busy_dates as Busy[]) this.fill(b);
    this.cursor = s.cursor as string;
  }
  private fill(b: Busy) {
    for (let x = b.start_date; x < b.end_date; x = addDays(x, 1)) this.days.add(x);
  }
  async drain(conn: string) {
    const ids: number[] = [];
    for (;;) {
      const r = await call(
        `/api/v1/calendar-connections/${conn}/changes?cursor=${encodeURIComponent(this.cursor)}&limit=2`,
      );
      expect(r.status).toBe(200);
      for (const c of r.body.changes as (Busy & { change_id: string; busy_dates: Busy[] })[]) {
        for (let x = c.start_date; x < c.end_date; x = addDays(x, 1)) this.days.delete(x);
        for (const b of c.busy_dates) this.fill(b);
        ids.push(Number(c.change_id));
      }
      this.cursor = r.body.next_cursor as string;
      if (!r.body.has_more) return ids;
    }
  }
  ranges(): Busy[] {
    const out: Busy[] = [];
    for (const day of [...this.days].sort()) {
      const last = out.at(-1);
      if (last && last.end_date === day) last.end_date = addDays(day, 1);
      else out.push({ start_date: day, end_date: addDays(day, 1) });
    }
    return out;
  }
}

beforeAll(async () => {
  await admin.connect();
  O = { id: uuidv7(), email: `apip.${tag}@ornek.com` };
  await admin.query(
    "insert into users (id, name, email, email_verified) values ($1, 'Proc', $2, true)",
    [O.id, O.email],
  );
  ws = (await createWorkspace(app, { userId: O.id, name: "İşlemci", slug: `apip-${tag}` })).id;
  const planId = uuidv7();
  await admin.query(
    "insert into plans (id, code, name, max_properties, trial_days, is_active, is_default) values ($1, $2, 'Proc', 20, 14, true, false)",
    [planId, planCode],
  );
  await admin.query("update workspace_subscriptions set plan_id = $1 where workspace_id = $2", [
    planId,
    ws,
  ]);
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
  bos = await villa("Villa Bağlantısız");
  const adminId = await createTestAdmin(admin, "apip");
  const a = await createApiClient(adminDb, adminId, "Acente Alfa");
  keyA = (await createApiKey(adminDb, adminId, a, "")).key;
  await grantApiAccess(adminDb, adminId, a, mavi);
  await grantApiAccess(adminDb, adminId, a, asya);
  connMavi = (
    await call("/api/v1/calendar-connections", "POST", {
      property_id: mavi,
      external_property_id: "M",
    })
  ).body.id as string;
  await call("/api/v1/calendar-connections", "POST", {
    property_id: asya,
    external_property_id: "A",
  });
  await drainAll();
});

afterAll(async () => {
  await admin.query("drop trigger if exists test_fail_changes on api_calendar_changes");
  await admin.query("drop function if exists public.test_fail_changes()");
  await admin.query("update api_sync_state set pruned_through_id = 0 where id = 1");
  await admin.query(
    "update workspace_subscriptions set plan_id = (select id from plans where is_default) where workspace_id = $1",
    [ws],
  );
  await admin.query("delete from plans where code = $1", [planCode]);
  await admin.end();
  await adminRolePool.end();
  await appPool.end();
});

describe("HMAC-SHA256 cursor imzası", () => {
  it("RFC 4231 test vektörleri ve Node crypto ile birebir", async () => {
    const hmac = async (key: Buffer, msg: Buffer) =>
      (await admin.query("select encode(public.app_api_hmac_sha256($1, $2), 'hex') h", [key, msg]))
        .rows[0].h as string;
    expect(await hmac(Buffer.alloc(20, 0x0b), Buffer.from("Hi There"))).toBe(
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    );
    expect(await hmac(Buffer.from("Jefe"), Buffer.from("what do ya want for nothing?"))).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
    expect(
      await hmac(
        Buffer.alloc(131, 0xaa),
        Buffer.from("Test Using Larger Than Block-Size Key - Hash Key First"),
      ),
    ).toBe("60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
    for (const len of [0, 1, 36, 63, 64, 65, 200]) {
      const key = randomBytes(len);
      const msg = randomBytes(1 + (len % 97));
      expect(await hmac(key, msg)).toBe(createHmac("sha256", key).update(msg).digest("hex"));
    }
  });

  it("cursor imzası = HMAC-SHA256(cursor_key, yük) ilk 128 bit; snapshot cursor'ı doğrulanabilir", async () => {
    const s = await call(`/api/v1/calendar-connections/${connMavi}/snapshot`);
    const cursor = s.body.cursor as string;
    const key = (
      await admin.query("select cursor_key from api_calendar_connections where id = $1", [connMavi])
    ).rows[0].cursor_key as string;
    const payload = cursor.slice(0, cursor.lastIndexOf("."));
    expect(cursor.slice(cursor.lastIndexOf(".") + 1)).toBe(
      createHmac("sha256", key).update(payload).digest("hex").slice(0, 32),
    );
  });
});

describe("işleme", () => {
  it("normal: 'değişti' satırı güncel dolulukla kayda dönüşür, satır silinir, last_change_id ilerler", async () => {
    const before = await maxChange();
    await block(mavi, 10, 13);
    expect(await dirtyOf([mavi])).toHaveLength(1);
    const r = await processChangesOnce(app);
    expect(r).toMatchObject({ processed: 1, failed: 0, changes: 1 });
    expect(await dirtyOf([mavi])).toEqual([]);
    const ch = await changesOf([mavi], before);
    expect(ch).toEqual([
      {
        id: expect.any(String),
        p: mavi,
        s: d(10),
        e: d(13),
        busy: [{ start_date: d(10), end_date: d(13) }],
      },
    ]);
    expect((await state()).l).toBe(Number(ch[0]!.id));
    expect(r.lastChangeId).toBe(Number(ch[0]!.id));
  });

  it("birleştirme: çakışan ve bitişik aralıklar tek kayıt; ayrık aralık ayrı kayıt (sıralı)", async () => {
    const before = await maxChange();
    const id = await block(mavi, 20, 22);
    await as(O, ws, (tx, ctx) =>
      rescheduleReservation(tx, ctx, id, { checkIn: d(21), checkOut: d(24) }),
    ); // [20,22) + [21,24)
    await block(mavi, 24, 25); // bitişik → [20,25)
    await block(mavi, 60, 61); // ayrık
    expect(await dirtyOf([mavi])).toHaveLength(5);
    const r = await processChangesOnce(app);
    expect(r).toMatchObject({ processed: 1, changes: 2 });
    const ch = await changesOf([mavi], before);
    expect(ch.map((x) => [x.s, x.e])).toEqual([
      [d(20), d(25)],
      [d(60), d(61)],
    ]);
    expect(ch[0]!.busy).toEqual([{ start_date: d(21), end_date: d(25) }]); // [20,21) artık boş
    expect(Number(ch[0]!.id)).toBeLessThan(Number(ch[1]!.id));
  });

  it("aynı villanın ardışık değişiklikleri: her çalıştırma kendi kaydı, artan kimlik, son durum doğru", async () => {
    const before = await maxChange();
    const ids: number[] = [];
    const a = await block(mavi, 30, 32);
    ids.push((await processChangesOnce(app)).lastChangeId);
    await as(O, ws, (tx, ctx) => cancelReservation(tx, ctx, a));
    ids.push((await processChangesOnce(app)).lastChangeId);
    await block(mavi, 31, 33);
    ids.push((await processChangesOnce(app)).lastChangeId);
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
    expect(new Set(ids).size).toBe(3);
    const ch = await changesOf([mavi], before);
    expect(ch.map((x) => x.busy)).toEqual([
      [{ start_date: d(30), end_date: d(32) }],
      [],
      [{ start_date: d(31), end_date: d(33) }],
    ]);
  });

  it("farklı villalar bağımsız; bağlantısız villa yalnız silinir; pencere dışı aralık kayıt üretmez", async () => {
    const before = await maxChange();
    await block(mavi, 40, 41);
    await block(asya, 40, 42);
    await block(bos, 40, 43);
    await block(mavi, 800, 802); // 731 günlük pencerenin dışı
    const r = await processChangesOnce(app);
    expect(r).toMatchObject({ processed: 2, failed: 0, discarded: 1 });
    expect(await dirtyOf([mavi, asya, bos])).toEqual([]);
    const ch = await changesOf([mavi, asya, bos], before);
    expect(ch.map((x) => [x.p, x.s, x.e]).sort()).toEqual(
      [
        [mavi, d(40), d(41)],
        [asya, d(40), d(42)],
      ].sort(),
    );
  });
});

describe("işlem sırasında yeni kayıt, hata, geri alma ve çökme", () => {
  it("işlemci transaction'ı açıkken gelen satır silinmez; sonraki çalıştırmada işlenir", async () => {
    await block(mavi, 50, 51);
    const p = await appPool.connect();
    try {
      await p.query("begin");
      await p.query("select * from public.app_api_process_changes(50)");
      // İşlemci commit etmeden yazan: beklemez (farklı kilit), satırı kaydedilir.
      const w = await settled(block(mavi, 52, 53), 3000);
      expect(w).toBe(true);
      await p.query("commit");
    } finally {
      p.release();
    }
    expect((await dirtyOf([mavi])).map((x) => [x.s, x.e])).toEqual([[d(52), d(53)]]);
    const before = await maxChange();
    expect(await processChangesOnce(app)).toMatchObject({ processed: 1, changes: 1 });
    expect((await changesOf([mavi], before)).map((x) => [x.s, x.e])).toEqual([[d(52), d(53)]]);
  });

  it("bir villada hata: yalnız o villa geri alınır, satırları korunur ve yeniden denenir; diğerleri işlenir", async () => {
    await admin.query(`create function public.test_fail_changes() returns trigger language plpgsql as $$
      begin if new.property_id = '${asya}' then raise exception 'test_fail'; end if; return new; end $$`);
    await admin.query(
      "create trigger test_fail_changes before insert on api_calendar_changes for each row execute function public.test_fail_changes()",
    );
    const before = await maxChange();
    await block(mavi, 70, 71);
    await block(asya, 70, 72);
    const r1 = await processChangesOnce(app);
    expect(r1).toMatchObject({ processed: 1, failed: 1, changes: 1 });
    expect((await changesOf([mavi, asya], before)).map((x) => x.p)).toEqual([mavi]);
    const [row] = await dirtyOf([asya]);
    expect(row).toMatchObject({
      s: d(70),
      e: d(72),
      attempts: 1,
      last_error: "sqlstate_p0001",
      waiting: true,
    });
    // Süresi gelmemiş satır alınmaz.
    expect(await processChangesOnce(app)).toMatchObject({ processed: 0, failed: 0 });
    // Geri çekilme: 10 sn, 20 sn, …, en fazla 1 saat.
    await admin.query(
      "update api_calendar_dirty set next_attempt_at = now() - interval '1 second' where property_id = $1",
      [asya],
    );
    expect(await processChangesOnce(app)).toMatchObject({ failed: 1 });
    const delay = (
      await admin.query(
        "select extract(epoch from next_attempt_at - now())::int s, attempts from api_calendar_dirty where property_id = $1",
        [asya],
      )
    ).rows[0];
    expect(delay.attempts).toBe(2);
    expect(delay.s).toBeGreaterThanOrEqual(18);
    expect(delay.s).toBeLessThanOrEqual(20);
    await admin.query(
      "update api_calendar_dirty set attempts = 20, next_attempt_at = now() - interval '1 second' where property_id = $1",
      [asya],
    );
    await processChangesOnce(app);
    const capped = (
      await admin.query(
        "select extract(epoch from next_attempt_at - now())::int s from api_calendar_dirty where property_id = $1",
        [asya],
      )
    ).rows[0].s;
    expect(capped).toBeGreaterThan(3500);
    expect(capped).toBeLessThanOrEqual(3600);
    // Hata giderilince satır işlenir ve silinir.
    await admin.query("drop trigger test_fail_changes on api_calendar_changes");
    await admin.query("drop function public.test_fail_changes()");
    await admin.query(
      "update api_calendar_dirty set next_attempt_at = now() - interval '1 second' where property_id = $1",
      [asya],
    );
    expect(await processChangesOnce(app)).toMatchObject({ processed: 1, failed: 0 });
    expect(await dirtyOf([asya])).toEqual([]);
    expect((await changesOf([asya], before)).map((x) => [x.s, x.e, x.busy])).toEqual([
      [d(70), d(72), [{ start_date: d(70), end_date: d(72) }]],
    ]);
  });

  it("rollback: satırlar eksiksiz kalır, kayıt ve last_change_id değişmez", async () => {
    await block(mavi, 80, 81);
    await block(asya, 80, 81);
    const st = await state();
    const before = await maxChange();
    const p = await appPool.connect();
    try {
      await p.query("begin");
      const r = (await p.query("select * from public.app_api_process_changes(50)")).rows[0];
      expect(r.processed).toBe(2);
      await p.query("rollback");
    } finally {
      p.release();
    }
    expect(await dirtyOf([mavi, asya])).toHaveLength(2);
    expect(await changesOf([mavi, asya], before)).toEqual([]);
    expect(await state()).toEqual(st);
  });

  it("çökme (bağlantı sonlandırılır): satırlar eksiksiz kalır; sonraki çalıştırma hepsini işler", async () => {
    const st = await state();
    const before = await maxChange();
    // Ayrı istemci (havuz dışı): sonlandırılan bağlantının hatası havuzu etkilemez.
    const p = new Client({ connectionString: db.appUrl });
    p.on("error", () => undefined);
    await p.connect();
    const pid = (await p.query("select pg_backend_pid() pid")).rows[0].pid;
    await p.query("begin");
    await p.query("select * from public.app_api_process_changes(50)");
    await admin.query("select pg_terminate_backend($1)", [pid]);
    await p.end().catch(() => undefined);
    expect(await dirtyOf([mavi, asya])).toHaveLength(2);
    expect(await changesOf([mavi, asya], before)).toEqual([]);
    expect(await state()).toEqual(st);
    expect(await processChangesOnce(app)).toMatchObject({ processed: 2, failed: 0 });
    expect(await dirtyOf([mavi, asya])).toEqual([]);
    expect((await changesOf([mavi, asya], before)).length).toBe(2);
  });
});

describe("eşzamanlılık", () => {
  it("iki işlemci çağrısı aynı anda: ikincisi birincinin commit'ini bekler, satırlar bir kez işlenir", async () => {
    await block(mavi, 90, 91);
    await block(asya, 90, 91);
    const before = await maxChange();
    const p = await appPool.connect();
    try {
      await p.query("begin");
      const first = (await p.query("select * from public.app_api_process_changes(50)")).rows[0];
      const second = processChangesOnce(app);
      expect(await settled(second, 600)).toBe(false);
      await p.query("commit");
      expect(first.processed).toBe(2);
      expect(await second).toMatchObject({ processed: 0, changes: 0 });
    } finally {
      p.release();
    }
    expect((await changesOf([mavi, asya], before)).length).toBe(2);
  });

  it("iki işlemci süreci: biri advisory lock'u alır, diğeri hemen çıkar; kilit bitişte bırakılır", async () => {
    const one = new Pool({ connectionString: db.appUrl, max: 1, idleTimeoutMillis: 0 });
    const two = new Pool({ connectionString: db.appUrl, max: 1, idleTimeoutMillis: 0 });
    try {
      const d1 = drizzle(one, { schema, casing: DB_CASING });
      const d2 = drizzle(two, { schema, casing: DB_CASING });
      const a = runApiSync(d1, { maxMs: 800, intervalMs: 100 });
      await new Promise((r) => setTimeout(r, 150));
      const b = await runApiSync(d2, { maxMs: 800, intervalMs: 100 });
      expect(b).toEqual({ locked: false });
      const ra = await a;
      expect(ra.locked).toBe(true);
      // Kilit bırakıldı: ikinci süreç şimdi alabilir.
      const c = await runApiSync(d2, { maxMs: 50, intervalMs: 10 });
      expect(c.locked).toBe(true);
    } finally {
      await one.end();
      await two.end();
    }
  });

  it("süreç çalışırken gelen değişiklik aynı çalıştırmada (birkaç saniyelik yoklamayla) işlenir", async () => {
    const pool = new Pool({ connectionString: db.appUrl, max: 1, idleTimeoutMillis: 0 });
    try {
      const before = await maxChange();
      const run = runApiSync(drizzle(pool, { schema, casing: DB_CASING }), {
        maxMs: 1500,
        intervalMs: 100,
      });
      await new Promise((r) => setTimeout(r, 300));
      await block(mavi, 100, 101);
      const s = await run;
      expect(s).toMatchObject({ locked: true });
      if (s.locked) expect(s.rounds).toBeGreaterThan(2);
      expect((await changesOf([mavi], before)).map((x) => [x.s, x.e])).toEqual([[d(100), d(101)]]);
      expect(await dirtyOf([mavi])).toEqual([]);
    } finally {
      await pool.end();
    }
  });
});

describe("kimlik sırası, cursor ve snapshot ile eşzamanlılık", () => {
  it("last_change_id her zaman en büyük kimlik; acente modeli (snapshot + cursor) veritabanına eşit", async () => {
    const m = new Model();
    m.load((await call(`/api/v1/calendar-connections/${connMavi}/snapshot`)).body);
    const seen: number[] = [];
    const live: string[] = [];
    for (let i = 0; i < 12; i++) {
      if (i % 3 === 2 && live.length)
        await as(O, ws, (tx, ctx) => cancelReservation(tx, ctx, live.shift()!));
      else live.push(await block(mavi, 200 + i * 3, 201 + i * 3));
      const r = await processChangesOnce(app);
      expect(r.lastChangeId).toBe(await maxChange());
      expect((await state()).l).toBe(r.lastChangeId);
      if (i % 2) seen.push(...(await m.drain(connMavi)));
    }
    seen.push(...(await m.drain(connMavi)));
    expect(seen).toEqual([...seen].sort((x, y) => x - y));
    expect(new Set(seen).size).toBe(seen.length);
    expect(m.ranges()).toEqual(await truth(mavi));
  });

  it("işlemci transaction'ı açıkken snapshot bekler; commit sonrası cursor ve doluluk aynı veri anı", async () => {
    await block(mavi, 300, 302);
    const p = await appPool.connect();
    let snap: Promise<{ status: number; body: Record<string, unknown> }> | null = null;
    try {
      await p.query("begin");
      await p.query("select * from public.app_api_process_changes(50)");
      snap = call(`/api/v1/calendar-connections/${connMavi}/snapshot`);
      expect(await settled(snap, 600)).toBe(false);
      await p.query("commit");
    } finally {
      p.release();
    }
    const s = await snap!;
    expect((s.body.cursor as string).split(".")[2]).toBe(String((await state()).l));
    expect(s.body.busy_dates).toEqual(await truth(mavi));
    const m = new Model();
    m.load(s.body);
    expect(await m.drain(connMavi)).toEqual([]);
  });

  it("snapshot kilidi tutulurken işlemci bekler", async () => {
    await block(mavi, 310, 311);
    const r = await superClient();
    try {
      await r.query("begin isolation level read committed");
      await r.query("select 1 from api_sync_state where id = 1 for share");
      const proc = processChangesOnce(app);
      expect(await settled(proc, 600)).toBe(false);
      await r.query("commit");
      expect(await proc).toMatchObject({ processed: 1 });
    } finally {
      await r.end();
    }
  });
});

describe("saklama (30 gün)", () => {
  it("31 günden eski kayıtlar silinir; pruned_through_id ilerler; gerisindeki cursor 410", async () => {
    const m = new Model();
    m.load((await call(`/api/v1/calendar-connections/${connMavi}/snapshot`)).body);
    await block(mavi, 320, 321);
    const r = await processChangesOnce(app);
    await admin.query(
      "update api_calendar_changes set created_at = now() - interval '32 days' where id <= $1",
      [r.lastChangeId],
    );
    const n = Number((await appPool.query("select public.app_api_prune_changes() n")).rows[0].n);
    expect(n).toBeGreaterThan(0);
    expect((await state()).p).toBe(r.lastChangeId);
    expect(
      Number(
        (
          await admin.query("select count(*) n from api_calendar_changes where id <= $1", [
            r.lastChangeId,
          ])
        ).rows[0].n,
      ),
    ).toBe(0);
    const old = await call(
      `/api/v1/calendar-connections/${connMavi}/changes?cursor=${encodeURIComponent(m.cursor)}`,
    );
    expect([old.status, (old.body.error as { code: string }).code]).toEqual([
      410,
      "cursor_expired",
    ]);
    // 30 günden yeni kayıtlar silinmez.
    await block(mavi, 330, 331);
    await processChangesOnce(app);
    expect(Number((await appPool.query("select public.app_api_prune_changes() n")).rows[0].n)).toBe(
      0,
    );
    await admin.query("update api_sync_state set pruned_through_id = 0 where id = 1");
  });
});

describe("güvenlik", () => {
  it("işlemci ve saklama yalnız app_user'da; HMAC yardımcı kimsede; dirty tablosu hâlâ kapalı", async () => {
    await expect(
      appPool.query("select public.app_api_hmac_sha256('\\x00'::bytea, '\\x00'::bytea)"),
    ).rejects.toMatchObject({
      code: "42501",
    });
    await expect(
      adminRolePool.query("select * from public.app_api_process_changes(1)"),
    ).rejects.toMatchObject({
      code: "42501",
    });
    await expect(appPool.query("select * from api_calendar_dirty")).rejects.toMatchObject({
      code: "42501",
    });
    const c = await appPool.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.api_fn', 'on', true)");
      await expect(c.query("delete from api_calendar_dirty")).rejects.toMatchObject({
        code: "42501",
      });
      await c.query("rollback");
    } finally {
      c.release();
    }
  });
});

async function superClient() {
  const c = new Client({ connectionString: db.adminUrl });
  await c.connect();
  return c;
}
