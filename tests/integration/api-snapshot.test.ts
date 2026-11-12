import { randomBytes } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool, type PoolClient } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { DB_CASING } from "@/db/casing";
import * as schema from "@/db/schema";
import { type TenantContext, type Tx, withTenant } from "@/db/tenant";
import { addDays, istanbulToday } from "@/lib/reservation-meta";
import {
  createApiClient,
  createApiKey,
  grantApiAccess,
  setApiClientActive,
} from "@/server/admin/api-clients";
import {
  availabilityEndpoint,
  changesEndpoint,
  connectEndpoint,
  disconnectEndpoint,
  snapshotEndpoint,
} from "@/server/api/endpoints";
import { type ApiContext, type ApiResult, handleApiRequest } from "@/server/api/handler";
import { hashApiKey } from "@/server/api/keys";
import { createProperty, setPropertyStatus } from "@/server/properties/service";
import { cancelReservation, createReservation } from "@/server/reservations/service";
import { createWorkspace } from "@/server/workspaces/service";

import { createTestAdmin } from "./wa-admin";

/**
 * API 2. aşama, 3. adım — snapshot ve cursor (drizzle/0057, 0058).
 * Gerçek PostgreSQL 17, ayrı bağlantılarla eşzamanlı transaction'lar. İşlemci (4. adım) henüz
 * yoktur: testler onun SÖZLEŞMESİNİ uygulayan küçük bir yardımcıyla (`processor`) çalışır —
 * ilk ifadesi api_sync_state satırını UPDATE ile kilitler, "değişti" satırlarını tüketir, güncel
 * doluluğu yazar, last_change_id'yi aynı transaction'da günceller.
 *
 * Doğrulananlar: snapshot = 12 ay geri / 24 ay ileri dolu aralıklar [start, end) + aynı veri
 * anının cursor'ı; snapshot ile işlemci birbirini bekler (kayıp/çift yok); snapshot sırasında ve
 * sonrasında yapılan değişiklikler cursor'dan alınır; sayfalama sırasında yeni kayıtlar atlanmaz
 * ve iki kez dönmez; cursor bağlantıya bağlı ve imzalı; 30 gün / saklama sınırı → 410; yanıtlarda
 * yalnız izinli alanlar; paused/bitmiş/başka acentenin bağlantısı kullanılamaz.
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 12 });
const app = drizzle(appPool, { schema, casing: DB_CASING });
const adminRolePool = new Pool({ connectionString: db.adminUrl, max: 3 });
adminRolePool.on("connect", (c) => void c.query("set role app_admin"));
const adminDb = drizzle(adminRolePool, { schema, casing: DB_CASING });
const superPool = new Pool({ connectionString: db.adminUrl, max: 6 });
const admin = new Client({ connectionString: db.adminUrl });
const tag = randomBytes(3).toString("hex");
const T = istanbulToday();
const d = (n: number) => addDays(T, n);
const FROM = d(-366);
const TO = d(731);

type U = { id: string; email: string };
let O: U;
let ws: string;
let mavi: string, asya: string;
let keyA: string, keyB: string;
let connMavi: string, connAsya: string, connBMavi: string;
const planCode = `apis_${tag}`;
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

type Res = { status: number; body: Record<string, unknown> };
async function call(method: "GET" | "POST" | "DELETE", path: string, key: string, body?: unknown) {
  const req = new Request(`https://app.kiraligim.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const rest = new URL(req.url).pathname.split("/").filter(Boolean).slice(2);
  let run: (ctx: ApiContext) => Promise<ApiResult>;
  if (rest[0] === "properties") run = (c) => availabilityEndpoint(c, rest[1]!);
  else if (rest.length === 1) run = connectEndpoint;
  else if (rest[2] === "snapshot") run = (c) => snapshotEndpoint(c, rest[1]!);
  else if (rest[2] === "changes") run = (c) => changesEndpoint(c, rest[1]!);
  else if (method === "DELETE") run = (c) => disconnectEndpoint(c, rest[1]!);
  else throw new Error(path);
  const res = await handleApiRequest(req, app, "test", run);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> } as Res;
}
type Busy = { start_date: string; end_date: string };
type Change = { change_id: string; start_date: string; end_date: string; busy_dates: Busy[] };
const snapshot = (conn: string, key = keyA) =>
  call("GET", `/api/v1/calendar-connections/${conn}/snapshot`, key);
const changes = (conn: string, cursor: string, key = keyA, limit?: number) =>
  call(
    "GET",
    `/api/v1/calendar-connections/${conn}/changes?cursor=${encodeURIComponent(cursor)}${limit ? `&limit=${limit}` : ""}`,
    key,
  );
const errCode = (r: Res) => (r.body.error as { code: string }).code;

/** Gerçek doluluk (veritabanı), API penceresinde. */
const truth = async (property: string) =>
  (
    await admin.query("select public.app_api_busy_json($1, $2::date, $3::date) j", [
      property,
      FROM,
      TO,
    ])
  ).rows[0].j as Busy[];

/**
 * İşlemci sözleşmesinin test uygulaması (4. adımın gerçek işlemcisi aynı protokolü kullanır):
 * READ COMMITTED; 1) api_sync_state UPDATE (kilit), 2) bu testin villalarının "değişti"
 * satırlarını tüket + güncel doluluğu yaz (tek ifade), 3) last_change_id. `hold` verilirse commit
 * etmeden bekler (eşzamanlılık testleri).
 */
async function processor(opts: { hold?: (c: PoolClient) => Promise<void> } = {}) {
  const c = await superPool.connect();
  try {
    await c.query("begin isolation level read committed");
    await c.query("update api_sync_state set updated_at = now() where id = 1");
    await c.query(
      `with dd as (
         delete from api_calendar_dirty where property_id = any($1) returning property_id, start_date, end_date
       ), g as (
         select property_id, greatest(min(start_date), $2::date) s, least(max(end_date), $3::date) e
           from dd group by property_id
       )
       insert into api_calendar_changes (property_id, start_date, end_date, busy)
       select property_id, s, e, public.app_api_busy_json(property_id, s, e) from g where e > s`,
      [[mavi, asya], FROM, TO],
    );
    await c.query(
      "update api_sync_state set last_change_id = (select coalesce(max(id), 0) from api_calendar_changes) where id = 1",
    );
    if (opts.hold) await opts.hold(c);
    await c.query("commit");
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Acentenin modeli: gün → dolu; snapshot yükler, değişiklik aralığını yerine koyar. */
class AgencyModel {
  days = new Set<string>();
  cursor = "";
  private fill(b: Busy) {
    for (let x = b.start_date; x < b.end_date; x = addDays(x, 1)) this.days.add(x);
  }
  load(s: Record<string, unknown>) {
    this.days.clear();
    for (const b of s.busy_dates as Busy[]) this.fill(b);
    this.cursor = s.cursor as string;
  }
  apply(c: Change) {
    for (let x = c.start_date; x < c.end_date; x = addDays(x, 1)) this.days.delete(x);
    for (const b of c.busy_dates) this.fill(b);
  }
  ranges(): Busy[] {
    const sorted = [...this.days].sort();
    const out: Busy[] = [];
    for (const day of sorted) {
      const last = out.at(-1);
      if (last && last.end_date === day) last.end_date = addDays(day, 1);
      else out.push({ start_date: day, end_date: addDays(day, 1) });
    }
    return out;
  }
}
/** Cursor'dan sonuna kadar bütün değişiklikleri sayfa sayfa okur. */
async function drain(conn: string, model: AgencyModel, limit = 100) {
  const ids: string[] = [];
  for (;;) {
    const r = await changes(conn, model.cursor, keyA, limit);
    expect(r.status).toBe(200);
    for (const c of r.body.changes as Change[]) {
      model.apply(c);
      ids.push(c.change_id);
    }
    model.cursor = r.body.next_cursor as string;
    if (!r.body.has_more) return ids;
  }
}
const settled = (p: Promise<unknown>, ms: number) =>
  Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), ms))]);

beforeAll(async () => {
  await admin.connect();
  O = { id: uuidv7(), email: `apis.${tag}@ornek.com` };
  await admin.query(
    "insert into users (id, name, email, email_verified) values ($1, 'Snap', $2, true)",
    [O.id, O.email],
  );
  ws = (await createWorkspace(app, { userId: O.id, name: "Snapshot", slug: `apis-${tag}` })).id;
  const planId = uuidv7();
  await admin.query(
    "insert into plans (id, code, name, max_properties, trial_days, is_active, is_default) values ($1, $2, 'Snap', 20, 14, true, false)",
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
  const adminId = await createTestAdmin(admin, "apis");
  const a = await createApiClient(adminDb, adminId, "Acente Alfa");
  const b = await createApiClient(adminDb, adminId, "Acente Beta");
  keyA = (await createApiKey(adminDb, adminId, a, "")).key;
  keyB = (await createApiKey(adminDb, adminId, b, "")).key;
  for (const p of [mavi, asya]) await grantApiAccess(adminDb, adminId, a, p);
  await grantApiAccess(adminDb, adminId, b, mavi);
  // Bağlantıdan önceki takvim: rezervasyon (misafirli), blok ve harici takvim olayı.
  await as(O, ws, (tx, ctx) =>
    createReservation(tx, ctx, {
      kind: "reservation",
      propertyId: mavi,
      checkIn: d(10),
      checkOut: d(14),
      guestName: "Zeynep Gizlisoy",
      guestPhone: "+90 532 987 65 43",
      adults: "2",
      children: "0",
      source: "airbnb",
      totalAmount: "48.750",
      currency: "TRY",
      note: "Özel not",
    }),
  );
  await block(mavi, 14, 16); // bitişik: [10, 16)
  await block(mavi, -100, -95); // geçmiş
  const src = uuidv7();
  await admin.query(
    `insert into external_calendar_sources (id, workspace_id, property_id, name, url)
     values ($1, $2, $3, 'Airbnb Gizli', 'https://www.airbnb.com/calendar/ical/x.ics')`,
    [src, ws, mavi],
  );
  await admin.query(
    "update external_calendar_sources set locked_until = now() + interval '1 day' where id = $1",
    [src],
  );
  await admin.query(
    `insert into external_calendar_events (id, workspace_id, property_id, source_id, uid, start_date, end_date)
     values ($1, $2, $3, $4, 'u1', $5, $6)`,
    [uuidv7(), ws, mavi, src, d(40), d(45)],
  );
  connMavi = (
    await call("POST", "/api/v1/calendar-connections", keyA, {
      property_id: mavi,
      external_property_id: "M-1",
    })
  ).body.id as string;
  connAsya = (
    await call("POST", "/api/v1/calendar-connections", keyA, {
      property_id: asya,
      external_property_id: "A-1",
    })
  ).body.id as string;
  connBMavi = (
    await call("POST", "/api/v1/calendar-connections", keyB, {
      property_id: mavi,
      external_property_id: "M-1",
    })
  ).body.id as string;
  // Kurulumdaki "değişti" satırları önceden işlenir (temiz başlangıç).
  await processor();
});

afterAll(async () => {
  await admin.query(
    "update workspace_subscriptions set plan_id = (select id from plans where is_default) where workspace_id = $1",
    [ws],
  );
  await admin.query("delete from plans where code = $1", [planCode]);
  await admin.end();
  await superPool.end();
  await adminRolePool.end();
  await appPool.end();
});

describe("snapshot", () => {
  it("12 ay geri / 24 ay ileri, birleştirilmiş [start, end) aralıklar; yalnız izinli alanlar", async () => {
    const r = await snapshot(connMavi);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual([
      "busy_dates",
      "connection_id",
      "cursor",
      "external_property_id",
      "from",
      "property_id",
      "to",
    ]);
    expect(r.body).toMatchObject({
      connection_id: connMavi,
      property_id: mavi,
      external_property_id: "M-1",
      from: FROM,
      to: TO,
      busy_dates: [
        { start_date: d(-100), end_date: d(-95) },
        { start_date: d(10), end_date: d(16) },
        { start_date: d(40), end_date: d(45) },
      ],
    });
    expect(r.body.cursor).toMatch(/^c1\.[0-9a-f]{32}\.\d+\.\d+\.[0-9a-f]{32}$/);
    // 1. aşama müsaitlik uç noktasıyla aynı kural.
    const av = await call(
      "GET",
      `/api/v1/properties/${mavi}/availability?from=${d(-366)}&to=${d(0)}`,
      keyA,
    );
    const av2 = await call(
      "GET",
      `/api/v1/properties/${mavi}/availability?from=${d(0)}&to=${d(366)}`,
      keyA,
    );
    expect([...(av.body.busy_dates as Busy[]), ...(av2.body.busy_dates as Busy[])]).toEqual(
      r.body.busy_dates,
    );
    const text = JSON.stringify(r.body);
    for (const s of [
      "Zeynep",
      "Gizlisoy",
      "987 65",
      "48.750",
      "4875000",
      "Özel not",
      "Airbnb",
      "airbnb",
      "Gizli",
      "block",
      "reservation",
      "confirmed",
    ]) {
      expect(text, s).not.toContain(s);
    }
    const synced = (
      await admin.query("select last_synced_at from api_calendar_connections where id = $1", [
        connMavi,
      ])
    ).rows[0].last_synced_at;
    expect(synced).not.toBeNull();
  });

  it("başka acentenin, paused, bitmiş, olmayan bağlantı: 404; parametre 400", async () => {
    expect((await snapshot(connMavi, keyB)).status).toBe(404);
    expect((await snapshot(uuidv7())).status).toBe(404);
    expect((await snapshot("abc")).status).toBe(404);
    expect(
      (await call("GET", `/api/v1/calendar-connections/${connMavi}/snapshot?x=1`, keyA)).status,
    ).toBe(400);
    await as(O, ws, (tx, ctx) => setPropertyStatus(tx, ctx, asya, "passive"));
    expect((await snapshot(connAsya)).status).toBe(404);
    await as(O, ws, (tx, ctx) => setPropertyStatus(tx, ctx, asya, "active"));
    expect((await snapshot(connAsya)).status).toBe(200);
    await processor();
  });
});

describe("cursor ve değişiklikler", () => {
  it("snapshot'tan sonraki değişiklik cursor'dan gelir; tekrar okuma boş; yerine koyma", async () => {
    const m = new AgencyModel();
    m.load((await snapshot(connMavi)).body);
    expect(await drain(connMavi, m)).toEqual([]);
    const id = await block(mavi, 60, 63);
    await processor();
    const ids = await drain(connMavi, m);
    expect(ids).toHaveLength(1);
    expect(m.ranges()).toEqual(await truth(mavi));
    await as(O, ws, (tx, ctx) => cancelReservation(tx, ctx, id));
    await processor();
    expect(await drain(connMavi, m)).toHaveLength(1);
    expect(m.ranges()).toEqual(await truth(mavi));
    expect(await drain(connMavi, m)).toEqual([]);
  });

  it("değişiklik yalnız tanımlı alanları taşır; yalnız bağlantının villası", async () => {
    const m = new AgencyModel();
    m.load((await snapshot(connMavi)).body);
    const ma = new AgencyModel();
    ma.load((await snapshot(connAsya)).body);
    await block(asya, 70, 72);
    await block(mavi, 80, 81);
    await processor();
    const r = await changes(connMavi, m.cursor);
    expect(Object.keys(r.body).sort()).toEqual([
      "changes",
      "connection_id",
      "external_property_id",
      "has_more",
      "next_cursor",
      "property_id",
    ]);
    const cs = r.body.changes as Change[];
    expect(cs).toHaveLength(1);
    expect(Object.keys(cs[0]!).sort()).toEqual([
      "busy_dates",
      "change_id",
      "end_date",
      "start_date",
    ]);
    expect(cs[0]).toMatchObject({
      start_date: d(80),
      end_date: d(81),
      busy_dates: [{ start_date: d(80), end_date: d(81) }],
    });
    const ra = await changes(connAsya, ma.cursor);
    expect((ra.body.changes as Change[]).map((c) => c.start_date)).toEqual([d(70)]);
  });

  it("sayfalama: limit=1 ile hepsi tam bir kez, artan sırada", async () => {
    const m = new AgencyModel();
    m.load((await snapshot(connMavi)).body);
    for (const [a, b] of [
      [90, 91],
      [92, 93],
      [94, 95],
    ]) {
      await block(mavi, a!, b!);
      await processor();
    }
    const ids = await drain(connMavi, m, 1);
    expect(ids).toHaveLength(3);
    expect(ids.map(Number)).toEqual([...ids.map(Number)].sort((x, y) => x - y));
    expect(m.ranges()).toEqual(await truth(mavi));
  });
});

describe("cursor güvenliği", () => {
  it("başka bağlantının, değiştirilmiş, bozuk veya eksik cursor: 400; başka acente: 404", async () => {
    const sm = (await snapshot(connMavi)).body.cursor as string;
    const sa = (await snapshot(connAsya)).body.cursor as string;
    const sb = (await snapshot(connBMavi, keyB)).body.cursor as string;
    expect(errCode(await changes(connAsya, sm))).toBe("invalid_cursor");
    expect(errCode(await changes(connMavi, sb))).toBe("invalid_cursor");
    expect((await changes(connMavi, sm, keyB)).status).toBe(404);
    const parts = sm.split(".");
    const tampered = [
      [parts[0], parts[1], "0", parts[3], parts[4]].join("."),
      [parts[0], parts[1], parts[2], String(Number(parts[3]) + 10), parts[4]].join("."),
      [parts[0], parts[1], parts[2], parts[3], "0".repeat(32)].join("."),
      sm.replace("c1.", "c2."),
      "x",
      sa.slice(0, -1),
    ];
    for (const t of tampered) {
      const r = await changes(connMavi, t);
      expect([t.slice(0, 20), r.status, errCode(r)]).toEqual([
        t.slice(0, 20),
        400,
        "invalid_cursor",
      ]);
    }
    const missing = await call("GET", `/api/v1/calendar-connections/${connMavi}/changes`, keyA);
    expect([missing.status, errCode(missing)]).toEqual([400, "invalid_request"]);
  });

  it("30 günden eski cursor ve saklama sınırının gerisindeki cursor: 410", async () => {
    const key = (
      await admin.query("select cursor_key from api_calendar_connections where id = $1", [connMavi])
    ).rows[0].cursor_key as string;
    const last = Number(
      (await admin.query("select last_change_id from api_sync_state")).rows[0].last_change_id,
    );
    const forge = async (change: number, ageDays: number) => {
      const payload = `c1.${connMavi.replace(/-/g, "")}.${change}.${Math.floor(Date.now() / 1000) - ageDays * 86400}`;
      const mac = (await admin.query("select public.app_api_cursor_mac($1, $2) m", [key, payload]))
        .rows[0].m;
      return `${payload}.${mac}`;
    };
    expect((await changes(connMavi, await forge(last, 29))).status).toBe(200);
    const old = await changes(connMavi, await forge(last, 31));
    expect(old).toEqual({
      status: 410,
      body: {
        error: { code: "cursor_expired", message: "The cursor has expired. Take a new snapshot." },
      },
    });
    await admin.query("update api_sync_state set pruned_through_id = $1 where id = 1", [last]);
    try {
      expect(errCode(await changes(connMavi, await forge(last - 1, 0)))).toBe("cursor_expired");
      expect((await changes(connMavi, await forge(last, 0))).status).toBe(200);
    } finally {
      await admin.query("update api_sync_state set pruned_through_id = 0 where id = 1");
    }
    // Snapshot her zaman yeni (geçerli) cursor verir.
    expect((await changes(connMavi, (await snapshot(connMavi)).body.cursor as string)).status).toBe(
      200,
    );
  });

  it("bitmiş bağlantının cursor'ı: 404; yeni bağlantı yeni snapshot ister (eski cursor geçersiz)", async () => {
    const old = (await snapshot(connAsya)).body.cursor as string;
    expect((await call("DELETE", `/api/v1/calendar-connections/${connAsya}`, keyA)).status).toBe(
      200,
    );
    expect((await changes(connAsya, old)).status).toBe(404);
    const re = await call("POST", "/api/v1/calendar-connections", keyA, {
      property_id: asya,
      external_property_id: "A-1",
    });
    connAsya = re.body.id as string;
    expect(errCode(await changes(connAsya, old))).toBe("invalid_cursor");
    expect((await snapshot(connAsya)).status).toBe(200);
  });
});

describe("snapshot tutarlılığı (eşzamanlı, gerçek PostgreSQL)", () => {
  it("işlemci transaction'ı açıkken snapshot bekler; commit sonrası cursor onun kayıtlarını kapsar", async () => {
    const m = new AgencyModel();
    m.load((await snapshot(connMavi)).body);
    await block(mavi, 100, 102);
    let snap: Promise<Res> | null = null;
    await processor({
      hold: async () => {
        snap = snapshot(connMavi);
        expect(await settled(snap, 600)).toBe(false); // işlemci commit etmeden dönemez
      },
    });
    const s = await snap!;
    expect(s.status).toBe(200);
    const last = Number(
      (await admin.query("select last_change_id from api_sync_state")).rows[0].last_change_id,
    );
    expect((s.body.cursor as string).split(".")[2]).toBe(String(last));
    expect(s.body.busy_dates).toEqual(await truth(mavi));
    // İşlemcinin kaydı snapshot'ta; cursor'dan sonra tekrar gelmez.
    const after = new AgencyModel();
    after.load(s.body);
    expect(await drain(connMavi, after)).toEqual([]);
    // Eski cursor'la okuyan da aynı sona ulaşır (kayıp yok).
    await drain(connMavi, m);
    expect(m.ranges()).toEqual(after.ranges());
  });

  it("snapshot kilidi tutulurken işlemci bekler (aynı satır kilidi protokolü)", async () => {
    const reader = await superPool.connect();
    const writer = await superPool.connect();
    try {
      await reader.query("begin isolation level read committed");
      await reader.query("select 1 from api_sync_state where id = 1 for share");
      await writer.query("begin");
      await writer.query("set local lock_timeout = '500ms'");
      await expect(
        writer.query("update api_sync_state set updated_at = now() where id = 1"),
      ).rejects.toMatchObject({ code: "55P03" });
      await writer.query("rollback");
      await reader.query("commit");
      await writer.query("begin");
      await writer.query("set local lock_timeout = '500ms'");
      await writer.query("update api_sync_state set updated_at = now() where id = 1");
      await writer.query("commit");
    } finally {
      reader.release();
      writer.release();
    }
  });

  it("snapshot sırasında açık olan yazma sonra kaydedilir: snapshot'ta yok, cursor'dan gelir", async () => {
    const w = await appPool.connect();
    try {
      await w.query("begin");
      await w.query(
        "select set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)",
        [O.id, ws],
      );
      await w.query(
        `insert into reservations (id, workspace_id, property_id, kind, status, check_in, check_out, created_by)
         values ($1, $2, $3, 'block', 'confirmed', $4, $5, app_current_user_id())`,
        [uuidv7(), ws, mavi, d(110), d(113)],
      );
      const m = new AgencyModel();
      m.load((await snapshot(connMavi)).body);
      expect(m.days.has(d(110))).toBe(false);
      await w.query("commit");
      expect(await drain(connMavi, m)).toEqual([]); // henüz işlenmedi
      await processor();
      expect((await drain(connMavi, m)).length).toBe(1);
      expect(m.days.has(d(110))).toBe(true);
      expect(m.ranges()).toEqual(await truth(mavi));
    } finally {
      w.release();
    }
  });

  it("kaydedilmiş ama işlenmemiş değişiklik: snapshot'ta görünür; sonraki kayıt iki kez uygulanması zararsız", async () => {
    await block(mavi, 120, 121);
    const m = new AgencyModel();
    m.load((await snapshot(connMavi)).body);
    expect(m.days.has(d(120))).toBe(true);
    await processor();
    expect((await drain(connMavi, m)).length).toBe(1);
    expect(m.ranges()).toEqual(await truth(mavi));
  });

  it("okuma sırasında işlemci yeni kayıt yazar: hiçbiri atlanmaz, hiçbiri iki kez dönmez", async () => {
    const m = new AgencyModel();
    m.load((await snapshot(connMavi)).body);
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      await block(mavi, 130 + i * 2, 131 + i * 2);
      const [, r] = await Promise.all([processor(), changes(connMavi, m.cursor, keyA, 1)]);
      for (const c of r.body.changes as Change[]) {
        m.apply(c);
        seen.push(c.change_id);
      }
      m.cursor = r.body.next_cursor as string;
    }
    seen.push(...(await drain(connMavi, m, 2)));
    expect(new Set(seen).size).toBe(seen.length);
    const expected = (
      await admin.query(
        "select id::text from api_calendar_changes where property_id = $1 and id > $2 order by id",
        [mavi, Number(seen[0]) - 1],
      )
    ).rows.map((x) => x.id);
    expect(seen).toEqual(expected);
    expect(m.ranges()).toEqual(await truth(mavi));
  });

  it("karışık işlemler + rastgele snapshot/işlemci: acente modeli her zaman veritabanına eşit", async () => {
    const rnd = (() => {
      let s = parseInt(tag, 16);
      return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    })();
    const m = new AgencyModel();
    m.load((await snapshot(connMavi)).body);
    const live: string[] = [];
    for (let i = 0; i < 30; i++) {
      const x = rnd();
      if (x < 0.45) {
        const a = 200 + Math.floor(rnd() * 200);
        await block(mavi, a, a + 1 + Math.floor(rnd() * 3)).then(
          (id) => live.push(id),
          () => undefined, // çakışma: atla
        );
      } else if (x < 0.65 && live.length) {
        const [id] = live.splice(Math.floor(rnd() * live.length), 1);
        await as(O, ws, (tx, ctx) => cancelReservation(tx, ctx, id!));
      } else if (x < 0.85) {
        await processor();
        await drain(connMavi, m, 1 + Math.floor(rnd() * 3));
      } else {
        await processor();
        m.load((await snapshot(connMavi)).body);
      }
    }
    await processor();
    await drain(connMavi, m);
    expect(m.ranges()).toEqual(await truth(mavi));
  });
});

describe("hesap ve güvenlik", () => {
  it("pasif hesap 403; tablolar uygulama rollerine kapalı; yalnız iki fonksiyon app_user'da", async () => {
    const adminId = await createTestAdmin(admin, "apis2");
    const client = (
      await admin.query("select client_id from api_calendar_connections where id = $1", [connMavi])
    ).rows[0].client_id;
    await setApiClientActive(adminDb, adminId, client, false);
    expect((await snapshot(connMavi)).status).toBe(403);
    await setApiClientActive(adminDb, adminId, client, true);
    for (const t of ["api_sync_state", "api_calendar_changes"]) {
      const r = (
        await admin.query(
          "select relrowsecurity r, relforcerowsecurity f from pg_class where relname = $1",
          [t],
        )
      ).rows[0];
      expect([t, r]).toEqual([t, { r: true, f: true }]);
      await expect(appPool.query(`select * from ${t}`)).rejects.toMatchObject({ code: "42501" });
      await expect(adminRolePool.query(`select * from ${t}`)).rejects.toMatchObject({
        code: "42501",
      });
    }
    for (const f of [
      "app_api_busy_json($1, current_date, current_date + 1)",
      "app_api_cursor_mac('a', 'b')",
    ]) {
      await expect(
        appPool.query(`select public.${f}`, f.includes("$1") ? [mavi] : []),
      ).rejects.toMatchObject({ code: "42501" });
    }
    await expect(
      adminRolePool.query("select * from public.app_api_snapshot($1, $2)", [
        hashApiKey(keyA),
        connMavi,
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    // cursor_key hiçbir yanıtta yok.
    const key = (
      await admin.query("select cursor_key from api_calendar_connections where id = $1", [connMavi])
    ).rows[0].cursor_key;
    const s = await snapshot(connMavi);
    expect(JSON.stringify(s.body)).not.toContain(key);
  });
});
