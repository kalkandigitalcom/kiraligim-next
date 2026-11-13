import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { DB_CASING } from "@/db/casing";
import * as schema from "@/db/schema";
import { type TenantContext, type Tx, withTenant } from "@/db/tenant";
import { createLogger } from "@/lib/logger";
import { addDays, istanbulToday } from "@/lib/reservation-meta";
import {
  createApiClient,
  createApiKey,
  grantApiAccess,
  listApiConnections,
  revokeApiAccess,
} from "@/server/admin/api-clients";
import {
  accountChangesEndpoint,
  changesEndpoint,
  connectEndpoint,
  disconnectEndpoint,
  snapshotEndpoint,
  webhookPutEndpoint,
} from "@/server/api/endpoints";
import { listPropertyApiConnections, listPropertyApiGrants } from "@/server/api/grants";
import { type ApiContext, type ApiResult, handleApiRequest } from "@/server/api/handler";
import { runApiSync } from "@/server/api/processor";
import { deliverDue, verifyWebhookSignature } from "@/server/api/webhooks";
import type { FetchIcsResult } from "@/server/ical/fetch";
import { addSource } from "@/server/ical/service";
import { claimSource, syncClaimed } from "@/server/ical/sync";
import { createProperty, setPropertyStatus } from "@/server/properties/service";
import { createReservation } from "@/server/reservations/service";
import { createAutoChanger } from "@/server/whatsapp/auto-change";
import { createAutoCloser } from "@/server/whatsapp/auto-close";
import { createAutoOpener } from "@/server/whatsapp/auto-open";
import { runCalendarWorker, type WorkerDeps } from "@/server/whatsapp/calendar/worker";
import { createWorkspace } from "@/server/workspaces/service";

import { createTestAdmin } from "./wa-admin";

/**
 * API 2. aşama, 6. adım — uçtan uca yayın öncesi doğrulama. Üretimdeki yollar birlikte çalışır:
 * ev sahibinin kodla izin vermesi → acentenin bağlanması → snapshot → takvim değişikliği (panel,
 * WhatsApp worker'ı, iCal senkronu) → işlemci (runApiSync, tek bağlantı + advisory lock) →
 * değişiklik akışları ve imzalı webhook. Gerçek PostgreSQL 17, app_user; alıcı yerel HTTPS
 * sunucusu (kendinden imzalı sertifika; yerel adres yalnız testte izinli).
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 10 });
const app = drizzle(appPool, { schema, casing: DB_CASING });
const adminRolePool = new Pool({ connectionString: db.adminUrl, max: 3 });
adminRolePool.on("connect", (c) => void c.query("set role app_admin"));
const adminDb = drizzle(adminRolePool, { schema, casing: DB_CASING });
const admin = new Client({ connectionString: db.adminUrl });
const tag = randomBytes(3).toString("hex");
const log = createLogger({ service: "api-e2e-test" }, () => {});
const T = istanbulToday();
const d = (n: number) => addDays(T, n);
const W = { start: d(-366), end: d(731) };
const KEY = randomBytes(32);
const HOST = "hooks.kg-e2e.example";

type U = { id: string; email: string };
type Busy = { start_date: string; end_date: string };
let O: U;
let ws: string;
let adminId: string;
let clientA: string, clientB: string;
let keyA: string, keyB: string;
let mavi: string, ical: string, deniz: string;
let connMavi: string, connIcal: string, connDeniz: string, connB: string;
let secretA = "";
const planCode = `apie_${tag}`;

// --- alıcı ---------------------------------------------------------------------------------
let dir: string;
let ca: Buffer;
let server: https.Server;
let port = 0;
type Hit = { headers: Record<string, string | string[] | undefined>; body: string };
const hits: Hit[] = [];
let reply: () => number = () => 204;
type Event = {
  id: string;
  type: string;
  connection_id: string;
  external_property_id: string;
  change: { change_id: string; start_date: string; end_date: string; busy_dates: Busy[] };
};
const events = (conn?: string) =>
  hits
    .map((h) => JSON.parse(h.body) as Event)
    .filter((e) => conn === undefined || e.connection_id === conn);

// --- işlemci: üretimdeki gibi tek bağlantı + advisory lock + teslim ----------------------------
const syncPools = [1, 2].map(() => new Pool({ connectionString: db.appUrl, max: 1 }));
const syncDbs = syncPools.map((p) => drizzle(p, { schema, casing: DB_CASING }));
const deliverOpts = {
  key: KEY,
  resolver: async () => [{ address: "127.0.0.1", family: 4 as const }],
  allowAddress: (a: string) => a === "127.0.0.1",
  ca: undefined as Buffer | undefined,
  timeoutMs: 3_000,
};
/** Tek tur: bekleyen değişiklikleri işler ve süresi gelmiş teslimleri gönderir. */
const cycle = (i = 0) =>
  runApiSync(syncDbs[i]!, {
    maxMs: 5_000,
    intervalMs: 10_000,
    deliver: (budget) => deliverDue(syncDbs[i]!, { ...deliverOpts, ca, maxMs: budget }),
  });
const dueNow = () =>
  admin.query("update api_webhook_deliveries set next_attempt_at = now() where status = 'pending'");

// --- yardımcılar ---------------------------------------------------------------------------
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
const truth = async (property: string, from = W.start, to = W.end) =>
  (
    await admin.query("select public.app_api_busy_json($1, $2::date, $3::date) j", [
      property,
      from,
      to,
    ])
  ).rows[0].j as Busy[];

type Method = "GET" | "POST" | "PUT" | "DELETE";
async function call(key: string, path: string, method: Method = "GET", body?: unknown) {
  const req = new Request(`https://app.kiraligim.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const p = new URL(req.url).pathname.split("/").filter(Boolean).slice(2);
  let run: (ctx: ApiContext) => Promise<ApiResult>;
  if (p[0] === "webhook") run = webhookPutEndpoint;
  else if (p[0] === "calendar-changes") run = accountChangesEndpoint;
  else if (p.length === 1) run = connectEndpoint;
  else if (p[2] === "snapshot") run = (c) => snapshotEndpoint(c, p[1]!);
  else if (p[2] === "changes") run = (c) => changesEndpoint(c, p[1]!);
  else run = (c) => disconnectEndpoint(c, p[1]!);
  const res = await handleApiRequest(req, app, "test", run);
  const out = (await res.json()) as Record<string, unknown>;
  if (out.error && typeof out.error === "object") out.error = (out.error as { code: string }).code;
  return { status: res.status, body: out };
}
const enc = encodeURIComponent;

/** Acentenin yerel takvim modeli: snapshot + değişiklikler (aralığı sil, dolu kısımları yaz). */
class Agency {
  days = new Map<string, Set<string>>();
  cursors = new Map<string, string>();
  account = "";
  async snapshot(key: string, conn: string) {
    const r = await call(key, `/api/v1/calendar-connections/${conn}/snapshot`);
    expect(r.status).toBe(200);
    const set = new Set<string>();
    for (const b of r.body.busy_dates as Busy[]) fill(set, b);
    this.days.set(conn, set);
    this.cursors.set(conn, r.body.cursor as string);
    return r.body;
  }
  apply(conn: string, c: { start_date: string; end_date: string; busy_dates: Busy[] }) {
    const set = this.days.get(conn)!;
    for (let x = c.start_date; x < c.end_date; x = addDays(x, 1)) set.delete(x);
    for (const b of c.busy_dates) fill(set, b);
  }
  async pull(key: string, conn: string) {
    const ids: string[] = [];
    for (;;) {
      const r = await call(
        key,
        `/api/v1/calendar-connections/${conn}/changes?cursor=${enc(this.cursors.get(conn)!)}&limit=2`,
      );
      expect(r.status).toBe(200);
      for (const c of r.body.changes as (Busy & { change_id: string; busy_dates: Busy[] })[]) {
        this.apply(conn, c);
        ids.push(c.change_id);
      }
      this.cursors.set(conn, r.body.next_cursor as string);
      if (!r.body.has_more) return ids;
    }
  }
  ranges(conn: string): Busy[] {
    const out: Busy[] = [];
    for (const day of [...this.days.get(conn)!].sort()) {
      const last = out.at(-1);
      if (last && last.end_date === day) last.end_date = addDays(day, 1);
      else out.push({ start_date: day, end_date: addDays(day, 1) });
    }
    return out;
  }
}
const fill = (set: Set<string>, b: Busy) => {
  for (let x = b.start_date; x < b.end_date; x = addDays(x, 1)) set.add(x);
};

// --- WhatsApp (üretimdeki worker) ----------------------------------------------------------
const PN_OWNER = `9053277${String(parseInt(tag, 16) % 100_000).padStart(5, "0")}`;
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
function md(months: number, day: number): string {
  const y = Number(T.slice(0, 4));
  const m0 = Number(T.slice(5, 7)) - 1 + months;
  const yy = y + Math.floor(m0 / 12);
  return `${yy}-${String((m0 % 12) + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
const waDeps = (): WorkerDeps => ({
  log,
  autoClose: createAutoCloser(app),
  autoOpen: createAutoOpener(app),
  autoChange: createAutoChanger(app),
});
let waConn: string;
let groupJid: string;
let msgN = 0;
async function wa(text: string) {
  await appPool.query(
    "select public.app_wa_ingest_message($1, $2, $3, '1@lid', $4, null, $5, now(), 'live')",
    [waConn, groupJid, `E2E${tag}${++msgN}`, PN_OWNER, text],
  );
  await runCalendarWorker(app, waDeps());
}

// --- iCal (sahte indirici) -----------------------------------------------------------------
const feeds = new Map<string, string>();
const fetcher = async (url: string): Promise<FetchIcsResult> => {
  const v = feeds.get(url);
  return v === undefined ? { ok: false, code: "http_status" } : { ok: true, text: v };
};
const ics = (iso: string) => iso.replace(/-/g, "");
const calendar = (...evs: { uid: string; from: number; to: number }[]) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Test//TR",
    ...evs.flatMap((e) => [
      "BEGIN:VEVENT",
      `UID:${e.uid}`,
      "SUMMARY:Reserved",
      `DTSTART;VALUE=DATE:${ics(d(e.from))}`,
      `DTEND;VALUE=DATE:${ics(d(e.to))}`,
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ].join("\r\n");
let icalSource = "";
const icalUrl = `https://www.airbnb.com/calendar/ical/e2e-${tag}.ics`;
async function icalSync() {
  await admin.query(
    "update external_calendar_sources set last_synced_at = now() - interval '5 hours' where id = $1",
    [icalSource],
  );
  const c = await as(O, ws, (tx) => claimSource(tx, icalSource));
  expect(c.outcome).toBe("claimed");
  return syncClaimed(app, c.claim!, "manual", { fetcher, today: () => T });
}

// --- panel görünümleri ---------------------------------------------------------------------
const hostView = async (property: string) =>
  as(O, ws, async (tx) => ({
    grants: (await listPropertyApiGrants(tx, property)).map((g) => g.clientName),
    connections: (await listPropertyApiConnections(tx, property)).map((c) => ({
      client: c.clientName,
      paused: c.paused,
    })),
  }));
const adminView = async (client: string) =>
  Object.fromEntries(
    (await listApiConnections(adminDb, adminId, client)).map((c) => [c.propertyName, c.status]),
  );

const agency = new Agency();
/** Ev sahibinin izin listesi (kimlikleriyle) — panelin kullandığı fonksiyon. */
const grantsSql = (p: string) => sql`select * from public.app_api_property_grants(${p}::uuid)`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kg-e2e-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      `/CN=${HOST}`,
      "-addext",
      `subjectAltName=DNS:${HOST}`,
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  ca = readFileSync(join(dir, "cert.pem"));
  server = https.createServer({ key: readFileSync(join(dir, "key.pem")), cert: ca }, (req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      hits.push({ headers: req.headers, body });
      res.writeHead(reply()).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  process.env.API_WEBHOOK_SECRET_KEY = KEY.toString("base64");

  await admin.connect();
  O = { id: uuidv7(), email: `apie.${tag}@ornek.com` };
  await admin.query(
    "insert into users (id, name, email, email_verified) values ($1, 'E2E Sahip', $2, true)",
    [O.id, O.email],
  );
  ws = (await createWorkspace(app, { userId: O.id, name: "E2E", slug: `apie-${tag}` })).id;
  const planId = uuidv7();
  await admin.query(
    "insert into plans (id, code, name, max_properties, trial_days, is_active, is_default) values ($1, $2, 'E2E', 20, 14, true, false)",
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
  ical = await villa("Villa iCal");
  deniz = await villa("Villa Deniz");
  adminId = await createTestAdmin(admin, "apie");
  clientA = await createApiClient(adminDb, adminId, "Acente Alfa");
  clientB = await createApiClient(adminDb, adminId, "Acente Beta");
  keyA = (await createApiKey(adminDb, adminId, clientA, "")).key;
  keyB = (await createApiKey(adminDb, adminId, clientB, "")).key;

  // WhatsApp: Villa Mavi'ye bağlı grup, doğrulanmış sahip numarası.
  waConn = (
    await appPool.query<{ id: string }>("select public.app_wa_heartbeat($1, 'open', null) as id", [
      `e2e-${tag}`,
    ])
  ).rows[0]!.id;
  groupJid = `120368${String(parseInt(tag, 16) % 10_000_000).padStart(7, "0")}00001@g.us`;
  await appPool.query("select public.app_wa_sync_group($1, $2, 'Ekip', 4, false, false, true)", [
    waConn,
    groupJid,
  ]);
  await admin.query(
    "update wa_groups set status = 'linked', workspace_id = $2, property_id = $3, linked_at = now() where jid = $1",
    [groupJid, ws, mavi],
  );
  await admin.query(
    "insert into wa_verified_phones (user_id, phone_hash, phone_masked) values ($1, $2, '+90 532 *** ** 02')",
    [O.id, createHash("sha256").update(`wa-phone:${PN_OWNER}`).digest("hex")],
  );
  await runCalendarWorker(app, waDeps());

  // iCal kaynağı (Villa iCal).
  feeds.set(icalUrl, calendar({ uid: "a1", from: 30, to: 33 }));
  icalSource = await as(O, ws, (tx, ctx) =>
    addSource(tx, ctx, ical, { name: "Airbnb", url: icalUrl, isActive: "on" }),
  );
  expect((await icalSync()).outcome).toBe("ok");
});

afterAll(async () => {
  await admin.query("delete from wa_inbound_messages where workspace_id = $1", [ws]);
  await admin.query("update workspaces set status = 'active' where id = $1", [ws]);
  await admin.query(
    "update workspace_subscriptions set plan_id = (select id from plans where is_default) where workspace_id = $1",
    [ws],
  );
  await admin.query("delete from plans where code = $1", [planCode]);
  await admin.end();
  await adminRolePool.end();
  await appPool.end();
  for (const p of syncPools) await p.end();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  hits.length = 0;
  reply = () => 204;
});

// ===========================================================================================
describe("uçtan uca: izin → bağlantı → snapshot → değişiklik → webhook", () => {
  it("Super Admin izin verir; acente bağlanır, webhook kaydeder, snapshot alır", async () => {
    for (const [client, props] of [
      [clientA, [mavi, ical, deniz]],
      [clientB, [mavi]],
    ] as const) {
      for (const p of props) await grantApiAccess(adminDb, adminId, client, p);
    }
    const connect = async (key: string, p: string, ext: string) => {
      const r = await call(key, "/api/v1/calendar-connections", "POST", {
        property_id: p,
        external_property_id: ext,
      });
      expect(r.status).toBe(201);
      return r.body.id as string;
    };
    connMavi = await connect(keyA, mavi, "A-MAVI");
    connIcal = await connect(keyA, ical, "A-ICAL");
    connDeniz = await connect(keyA, deniz, "A-DENIZ");
    connB = await connect(keyB, mavi, "B-MAVI");

    const put = await call(keyA, "/api/v1/webhook", "PUT", { url: "https://hooks.example.com/a" });
    expect(put.status).toBe(201);
    secretA = put.body.secret as string;
    await admin.query("update api_webhook_endpoints set url = $1 where client_id = $2", [
      `https://${HOST}:${port}/a`,
      clientA,
    ]);

    await cycle();
    for (const c of [connMavi, connIcal, connDeniz]) await agency.snapshot(keyA, c);
    agency.account = (await call(keyA, "/api/v1/calendar-changes")).body.next_cursor as string;
    // iCal olayı snapshot'ta.
    expect(agency.ranges(connIcal)).toEqual(await truth(ical));
    expect(agency.ranges(connIcal)).toContainEqual({ start_date: d(30), end_date: d(33) });

    // Panel görünümleri.
    expect(await hostView(mavi)).toEqual({
      grants: ["Acente Alfa", "Acente Beta"],
      connections: [
        { client: "Acente Alfa", paused: false },
        { client: "Acente Beta", paused: false },
      ],
    });
    expect(await adminView(clientA)).toEqual({
      "Villa Mavi": "active",
      "Villa iCal": "active",
      "Villa Deniz": "active",
    });
  });

  it("panel değişikliği → işlemci → bağlantı akışı, hesap akışı ve imzalı webhook aynı veriyi taşır", async () => {
    await block(deniz, 10, 14);
    const s = await cycle();
    expect(s.locked).toBe(true);
    const ev = events(connDeniz);
    expect(ev).toHaveLength(1);
    const h = hits.find((x) => (JSON.parse(x.body) as Event).connection_id === connDeniz)!;
    expect(
      verifyWebhookSignature(
        secretA,
        h.headers["kiraligim-signature"] as string,
        h.headers["kiraligim-timestamp"] as string,
        h.body,
      ),
    ).toBe(true);
    expect(h.headers["kiraligim-event-id"]).toBe(ev[0]!.id);
    expect(ev[0]!.external_property_id).toBe("A-DENIZ");

    const ids = await agency.pull(keyA, connDeniz);
    expect(ids).toEqual([ev[0]!.change.change_id]);
    expect(agency.ranges(connDeniz)).toEqual(await truth(deniz));

    const acc = await call(keyA, `/api/v1/calendar-changes?cursor=${enc(agency.account)}`);
    const mine = (acc.body.changes as { change_id: string; connection_id: string }[]).filter(
      (c) => c.connection_id === connDeniz,
    );
    expect(mine.map((c) => c.change_id)).toEqual([ev[0]!.change.change_id]);
    agency.account = acc.body.next_cursor as string;
    // B (Deniz'e izni yok) bu değişikliği hiçbir yoldan görmez.
    const bAcc = await call(keyB, "/api/v1/calendar-changes");
    expect(bAcc.status).toBe(200);
    expect((await call(keyB, `/api/v1/calendar-connections/${connDeniz}/snapshot`)).status).toBe(
      404,
    );
  });

  it("WhatsApp üzerinden kapatma ve açma: değişiklik akışa ve webhook'a gelir", async () => {
    const [a, b] = [md(2, 10), md(2, 14)];
    await wa(`${tr(a)}-${tr(b)} kapatalım`);
    await cycle();
    await agency.pull(keyA, connMavi);
    expect(agency.ranges(connMavi)).toEqual(await truth(mavi));
    expect(agency.ranges(connMavi)).toContainEqual({ start_date: a, end_date: b });
    const closed = events(connMavi);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.change.busy_dates).toContainEqual({ start_date: a, end_date: b });

    hits.length = 0;
    await wa(`${tr(a)}-${tr(b)} tekrar müsait`);
    await cycle();
    await agency.pull(keyA, connMavi);
    expect(agency.ranges(connMavi)).toEqual(await truth(mavi));
    expect(agency.ranges(connMavi)).not.toContainEqual({ start_date: a, end_date: b });
    const opened = events(connMavi);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.change.start_date <= a && opened[0]!.change.end_date >= b).toBe(true);
    expect(opened[0]!.change.busy_dates).toEqual([]);
  });

  it("iCal değişikliği: yeni/silinen olay akışa ve webhook'a gelir", async () => {
    feeds.set(icalUrl, calendar({ uid: "a1", from: 31, to: 34 }, { uid: "a2", from: 50, to: 52 }));
    expect((await icalSync()).outcome).toBe("ok");
    await cycle();
    await agency.pull(keyA, connIcal);
    expect(agency.ranges(connIcal)).toEqual(await truth(ical));
    expect(agency.ranges(connIcal)).toContainEqual({ start_date: d(50), end_date: d(52) });
    expect(events(connIcal).length).toBeGreaterThanOrEqual(1);

    feeds.set(icalUrl, calendar({ uid: "a1", from: 31, to: 34 }));
    expect((await icalSync()).outcome).toBe("ok");
    await cycle();
    await agency.pull(keyA, connIcal);
    expect(agency.ranges(connIcal)).toEqual(await truth(ical));
    expect(agency.ranges(connIcal)).not.toContainEqual({ start_date: d(50), end_date: d(52) });
  });
});

// ===========================================================================================
describe("duraklatma, kesme, izin kaldırma", () => {
  it("villa pasif: webhook gitmez, akışta görünmez, panelde 'duraklatıldı'; yeniden aktif → tam pencere", async () => {
    await as(O, ws, (tx, ctx) => setPropertyStatus(tx, ctx, deniz, "passive"));
    await cycle();
    expect(await adminView(clientA)).toMatchObject({ "Villa Deniz": "paused" });
    expect((await hostView(deniz)).connections).toEqual([{ client: "Acente Alfa", paused: true }]);
    expect((await call(keyA, `/api/v1/calendar-connections/${connDeniz}/snapshot`)).status).toBe(
      404,
    );
    expect(events(connDeniz)).toEqual([]);

    await as(O, ws, (tx, ctx) => setPropertyStatus(tx, ctx, deniz, "active"));
    await cycle();
    expect(await adminView(clientA)).toMatchObject({ "Villa Deniz": "active" });
    const ev = events(connDeniz);
    expect(ev).toHaveLength(1);
    expect([ev[0]!.change.start_date, ev[0]!.change.end_date]).toEqual([W.start, W.end]);
    expect(ev[0]!.change.busy_dates).toEqual(await truth(deniz));
    await agency.pull(keyA, connDeniz);
    expect(agency.ranges(connDeniz)).toEqual(await truth(deniz));
  });

  it("işletme askıda: tüm bağlantılar duraklar; yeniden aktif → her villa için tam pencere", async () => {
    await admin.query("update workspaces set status = 'suspended' where id = $1", [ws]);
    await cycle();
    expect(await adminView(clientA)).toEqual({
      "Villa Mavi": "paused",
      "Villa iCal": "paused",
      "Villa Deniz": "paused",
    });
    expect(hits).toEqual([]);
    const acc = await call(keyA, `/api/v1/calendar-changes?cursor=${enc(agency.account)}`);
    expect(acc.status).toBe(200);

    await admin.query("update workspaces set status = 'active' where id = $1", [ws]);
    await cycle();
    for (const c of [connMavi, connIcal, connDeniz]) {
      const ev = events(c);
      expect(ev.length).toBeGreaterThanOrEqual(1);
      expect([ev.at(-1)!.change.start_date, ev.at(-1)!.change.end_date]).toEqual([W.start, W.end]);
      await agency.pull(keyA, c);
    }
    expect(agency.ranges(connMavi)).toEqual(await truth(mavi));
    expect(agency.ranges(connIcal)).toEqual(await truth(ical));
    expect(agency.ranges(connDeniz)).toEqual(await truth(deniz));
  });

  it("snapshot yenileme: eski bekleyen teslimler iptal (superseded), yeni snapshot güncel", async () => {
    reply = () => 500;
    await block(ical, 70, 72);
    await cycle();
    expect(events(connIcal)).toHaveLength(1); // başarısız deneme
    await agency.snapshot(keyA, connIcal);
    reply = () => 204;
    hits.length = 0;
    await dueNow();
    await cycle();
    expect(events(connIcal)).toEqual([]);
    const r = await admin.query(
      "select status, cancel_reason from api_webhook_deliveries where connection_id = $1 order by created_at desc limit 1",
      [connIcal],
    );
    expect(r.rows[0]).toEqual({ status: "cancelled", cancel_reason: "superseded" });
    expect(agency.ranges(connIcal)).toEqual(await truth(ical));
  });

  it("sıra ve yeniden deneme: başarısız baş teslim sonrakileri bekletir; sonra sırayla gider", async () => {
    reply = () => 503;
    for (const a of [80, 82, 84]) {
      await block(mavi, a, a + 1);
      await cycle();
    }
    expect(events(connMavi)).toHaveLength(1);
    const head = events(connMavi)[0]!;
    reply = () => 204;
    hits.length = 0;
    await dueNow();
    await cycle();
    await dueNow();
    await cycle();
    const got = events(connMavi);
    expect(got[0]!.id).toBe(head.id); // aynı olay kimliği
    const ids = got.map((e) => Number(e.change.change_id));
    expect([...ids].sort((x, y) => x - y)).toEqual(ids);
    expect(ids).toHaveLength(3);
  });

  it("işlemci eşzamanlılığı: aynı anda iki süreç → biri kilidi alamaz; teslimler tekrarlanmaz", async () => {
    await block(mavi, 90, 91);
    const [x, y] = await Promise.all([cycle(0), cycle(1)]);
    expect([x.locked, y.locked].sort()).toEqual([false, true]);
    const ev = events(connMavi);
    expect(ev).toHaveLength(1);
    expect(new Set(hits.map((h) => h.headers["kiraligim-event-id"])).size).toBe(hits.length);
  });

  it("acente bağlantıyı keser: bekleyenler iptal, webhook/akış durur; panelde bağlantı yok", async () => {
    reply = () => 500;
    await block(ical, 100, 101);
    await cycle();
    const r = await call(keyA, `/api/v1/calendar-connections/${connIcal}`, "DELETE");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("disconnected");
    const pend = await admin.query(
      "select count(*)::int n from api_webhook_deliveries where connection_id = $1 and status = 'pending'",
      [connIcal],
    );
    expect(pend.rows[0].n).toBe(0);
    reply = () => 204;
    hits.length = 0;
    await block(ical, 102, 103);
    await dueNow();
    await cycle();
    expect(events(connIcal)).toEqual([]);
    expect((await call(keyA, `/api/v1/calendar-connections/${connIcal}/snapshot`)).status).toBe(
      404,
    );
    const acc = await call(keyA, `/api/v1/calendar-changes?cursor=${enc(agency.account)}`);
    expect(
      (acc.body.changes as { connection_id: string }[]).map((c) => c.connection_id),
    ).not.toContain(connIcal);
    expect((await hostView(ical)).connections).toEqual([]);
    expect((await hostView(ical)).grants).toEqual(["Acente Alfa"]); // izin sürer
    expect(await adminView(clientA)).toMatchObject({ "Villa iCal": "disconnected" });
  });

  it("Super Admin izni kaldırır: bağlantı biter (revoked), bekleyenler iptal, veri sızmaz", async () => {
    reply = () => 500;
    await block(mavi, 110, 111);
    await cycle();
    const grant = await as(O, ws, async (tx) => {
      const rows = await tx.execute<{ id: string; client_name: string }>(grantsSql(mavi));
      return rows.rows.find((g) => g.client_name === "Acente Beta")!.id;
    });
    await revokeApiAccess(adminDb, adminId, grant);
    const pend = await admin.query(
      "select count(*)::int n from api_webhook_deliveries where connection_id = $1 and status = 'pending'",
      [connB],
    );
    expect(pend.rows[0].n).toBe(0);
    expect(await adminView(clientB)).toEqual({ "Villa Mavi": "revoked" });
    expect((await hostView(mavi)).grants).toEqual(["Acente Alfa"]);
    expect((await hostView(mavi)).connections).toEqual([{ client: "Acente Alfa", paused: false }]);
    expect((await call(keyB, `/api/v1/calendar-connections/${connB}/snapshot`)).status).toBe(404);
    const bCur = (await call(keyB, "/api/v1/calendar-changes")).body.next_cursor as string;
    await block(mavi, 112, 113);
    await cycle();
    const bAcc = await call(keyB, `/api/v1/calendar-changes?cursor=${enc(bCur)}`);
    expect(bAcc.body.changes).toEqual([]);
  });
});

// ===========================================================================================
describe("cursor izolasyonu (hesap ve villa bazlı)", () => {
  it("bağlantı cursor'ı başka bağlantıda/hesap akışında; hesap cursor'ı başka hesapta geçersiz", async () => {
    const maviCur = agency.cursors.get(connMavi)!;
    const denizCur = agency.cursors.get(connDeniz)!;
    const bad = async (key: string, path: string) => {
      const r = await call(key, path);
      expect([r.status, r.body.error]).toEqual([400, "invalid_cursor"]);
    };
    await bad(keyA, `/api/v1/calendar-connections/${connDeniz}/changes?cursor=${enc(maviCur)}`);
    await bad(keyA, `/api/v1/calendar-connections/${connMavi}/changes?cursor=${enc(denizCur)}`);
    await bad(keyA, `/api/v1/calendar-changes?cursor=${enc(maviCur)}`);
    await bad(
      keyA,
      `/api/v1/calendar-connections/${connMavi}/changes?cursor=${enc(agency.account)}`,
    );
    const bAccount = (await call(keyB, "/api/v1/calendar-changes")).body.next_cursor as string;
    await bad(keyA, `/api/v1/calendar-changes?cursor=${enc(bAccount)}`);
    await bad(keyB, `/api/v1/calendar-changes?cursor=${enc(agency.account)}`);
    // B, A'nın bağlantısına hiç erişemez (cursor doğru olsa bile).
    const r = await call(
      keyB,
      `/api/v1/calendar-connections/${connMavi}/changes?cursor=${enc(maviCur)}`,
    );
    expect(r.status).toBe(404);
    // Son durumda A'nın modeli merkezi gerçeğe eşit.
    await agency.pull(keyA, connMavi);
    await agency.pull(keyA, connDeniz);
    expect(agency.ranges(connMavi)).toEqual(await truth(mavi));
    expect(agency.ranges(connDeniz)).toEqual(await truth(deniz));
  });
});
