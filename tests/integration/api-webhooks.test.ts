import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { DB_CASING } from "@/db/casing";
import * as schema from "@/db/schema";
import { type TenantContext, type Tx, withTenant } from "@/db/tenant";
import { addDays, istanbulToday } from "@/lib/reservation-meta";
import {
  createApiClient,
  createApiKey,
  grantApiAccess,
  revokeApiAccess,
  setApiClientActive,
} from "@/server/admin/api-clients";
import {
  accountChangesEndpoint,
  changesEndpoint,
  connectEndpoint,
  disconnectEndpoint,
  snapshotEndpoint,
  webhookDeleteEndpoint,
  webhookGetEndpoint,
  webhookPutEndpoint,
  webhookRotateEndpoint,
} from "@/server/api/endpoints";
import { type ApiContext, type ApiResult, handleApiRequest } from "@/server/api/handler";
import { processChangesOnce } from "@/server/api/processor";
import {
  claimDeliveries,
  deliverDue,
  finishDelivery,
  verifyWebhookSignature,
} from "@/server/api/webhooks";
import { createProperty, setPropertyStatus } from "@/server/properties/service";
import { createReservation } from "@/server/reservations/service";
import { createWorkspace } from "@/server/workspaces/service";

import { createTestAdmin } from "./wa-admin";

/**
 * API 2. aşama, 5. adım — webhook'lar ve hesap geneli değişiklik akışı (drizzle/0060, 0061;
 * src/server/api/webhooks.ts). Gerçek PostgreSQL 17, app_user bağlantısı; alıcı yerel HTTPS
 * sunucusudur (kendinden imzalı sertifika, sahte çözümleyici — yerel adres yalnız testte izinli).
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
const KEY = randomBytes(32);
const HOST = "hooks.kg-test.example";

type U = { id: string; email: string };
let O: U;
let ws: string;
let adminId: string;
let clientA: string, clientB: string;
let keyA: string, keyB: string;
let mavi: string, asya: string, deniz: string;
const conn: Record<string, string> = {};
const planCode = `apiw_${tag}`;

// --- alıcı ---------------------------------------------------------------------------------
let dir: string;
let ca: Buffer;
let server: https.Server;
let port = 0;
type Hit = { headers: Record<string, string | string[] | undefined>; body: string };
const hits: Hit[] = [];
let reply: (h: Hit) => number = () => 204;
const sendOpts = () => ({
  key: KEY,
  resolver: async () => [{ address: "127.0.0.1", family: 4 as const }],
  allowAddress: (a: string) => a === "127.0.0.1",
  ca,
  timeoutMs: 3_000,
});
const deliver = () => deliverDue(app, sendOpts());

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
async function drainAll() {
  for (let i = 0; i < 100; i++) {
    const r = await processChangesOnce(app, 500);
    if (r.processed + r.failed + r.discarded === 0) return;
  }
  throw new Error("işlemci boşalmadı");
}
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
  if (p[0] === "webhook") {
    run =
      p[1] === "rotate-secret"
        ? webhookRotateEndpoint
        : method === "PUT"
          ? webhookPutEndpoint
          : method === "DELETE"
            ? webhookDeleteEndpoint
            : webhookGetEndpoint;
  } else if (p[0] === "calendar-changes") run = accountChangesEndpoint;
  else if (p.length === 1) run = connectEndpoint;
  else if (p[2] === "snapshot") run = (c) => snapshotEndpoint(c, p[1]!);
  else if (p[2] === "changes") run = (c) => changesEndpoint(c, p[1]!);
  else run = (c) => disconnectEndpoint(c, p[1]!);
  const res = await handleApiRequest(req, app, "test", run);
  const out = (await res.json()) as Record<string, unknown>;
  // Hata gövdesi {error: {code, message}}: testlerde kod düzleştirilir.
  if (out.error && typeof out.error === "object") {
    out.error = (out.error as { code: string }).code;
  }
  return { status: res.status, body: out };
}
const snapshot = (key: string, c: string) =>
  call(key, `/api/v1/calendar-connections/${c}/snapshot`);
const deliveries = async (where = "true", args: unknown[] = []) =>
  (
    await admin.query(
      `select id, connection_id, change_id::int change_id, status, attempts, cancel_reason,
              last_error, last_status, next_attempt_at, lease_token, finished_at
         from api_webhook_deliveries where ${where} order by change_id, connection_id`,
      args,
    )
  ).rows as {
    id: string;
    connection_id: string;
    change_id: number;
    status: string;
    attempts: number;
    cancel_reason: string | null;
    last_error: string | null;
    last_status: number | null;
    next_attempt_at: Date;
    lease_token: string | null;
    finished_at: Date | null;
  }[];
const pendingOf = (c: string) => deliveries("connection_id = $1 and status = 'pending'", [c]);
const dueNow = () =>
  admin.query("update api_webhook_deliveries set next_attempt_at = now() where status = 'pending'");
const pointHookAtLocal = (client: string) =>
  admin.query("update api_webhook_endpoints set url = $1 where client_id = $2", [
    `https://${HOST}:${port}/kg/${client.slice(0, 8)}`,
    client,
  ]);
type Busy = { start_date: string; end_date: string };
const truth = async (property: string, from: string, to: string) =>
  (
    await admin.query("select public.app_api_busy_json($1, $2::date, $3::date) j", [
      property,
      from,
      to,
    ])
  ).rows[0].j as Busy[];
const lastChange = async () =>
  Number((await admin.query("select last_change_id l from api_sync_state where id = 1")).rows[0].l);

beforeAll(async () => {
  process.env.API_WEBHOOK_SECRET_KEY = KEY.toString("base64");
  dir = mkdtempSync(join(tmpdir(), "kg-whi-"));
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
      const h: Hit = { headers: req.headers, body };
      hits.push(h);
      res.writeHead(reply(h)).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;

  await admin.connect();
  O = { id: uuidv7(), email: `apiw.${tag}@ornek.com` };
  await admin.query(
    "insert into users (id, name, email, email_verified) values ($1, 'Hook', $2, true)",
    [O.id, O.email],
  );
  ws = (await createWorkspace(app, { userId: O.id, name: "Webhook", slug: `apiw-${tag}` })).id;
  const planId = uuidv7();
  await admin.query(
    "insert into plans (id, code, name, max_properties, trial_days, is_active, is_default) values ($1, $2, 'Hook', 20, 14, true, false)",
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
  deniz = await villa("Villa Deniz");
  adminId = await createTestAdmin(admin, "apiw");
  clientA = await createApiClient(adminDb, adminId, "Acente Alfa");
  clientB = await createApiClient(adminDb, adminId, "Acente Beta");
  keyA = (await createApiKey(adminDb, adminId, clientA, "")).key;
  keyB = (await createApiKey(adminDb, adminId, clientB, "")).key;
  for (const p of [mavi, asya, deniz]) await grantApiAccess(adminDb, adminId, clientA, p);
  await grantApiAccess(adminDb, adminId, clientB, mavi);
  for (const [name, p] of [
    ["mavi", mavi],
    ["asya", asya],
    ["deniz", deniz],
  ] as const) {
    conn[name] = (
      await call(keyA, "/api/v1/calendar-connections", "POST", {
        property_id: p,
        external_property_id: name,
      })
    ).body.id as string;
  }
  conn.maviB = (
    await call(keyB, "/api/v1/calendar-connections", "POST", {
      property_id: mavi,
      external_property_id: "B-mavi",
    })
  ).body.id as string;
  await drainAll();
});

afterAll(async () => {
  await admin.query("update api_sync_state set pruned_through_id = 0 where id = 1");
  await admin.query(
    "update workspace_subscriptions set plan_id = (select id from plans where is_default) where workspace_id = $1",
    [ws],
  );
  await admin.query("delete from plans where code = $1", [planCode]);
  await admin.end();
  await adminRolePool.end();
  await appPool.end();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  hits.length = 0;
  reply = () => 204;
});

// ===========================================================================================
describe("webhook yapılandırması", () => {
  let secretA = "";

  it("PUT oluşturur: 201, sır yalnız bu yanıtta; veritabanında şifreli", async () => {
    const r = await call(keyA, "/api/v1/webhook", "PUT", { url: "https://hooks.example.com/kg" });
    expect(r.status).toBe(201);
    secretA = r.body.secret as string;
    expect(secretA).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(Object.keys(r.body).sort()).toEqual(
      ["created_at", "secret", "secret_rotated_at", "updated_at", "url"].sort(),
    );
    const row = (
      await admin.query("select url, secret_enc from api_webhook_endpoints where client_id = $1", [
        clientA,
      ])
    ).rows[0];
    expect(row.url).toBe("https://hooks.example.com/kg");
    expect(row.secret_enc).toMatch(/^v1:/);
    expect(row.secret_enc).not.toContain(secretA.slice(6));
  });

  it("GET sırrı göstermez; PUT güncelleme 200, sır değişmez", async () => {
    const g = await call(keyA, "/api/v1/webhook");
    expect(g.status).toBe(200);
    expect(g.body.secret).toBeUndefined();
    expect(JSON.stringify(g.body)).not.toContain("whsec_");
    const before = (
      await admin.query("select secret_enc from api_webhook_endpoints where client_id = $1", [
        clientA,
      ])
    ).rows[0].secret_enc;
    const u = await call(keyA, "/api/v1/webhook", "PUT", { url: "https://hooks.example.com/v2" });
    expect(u.status).toBe(200);
    expect(u.body.secret).toBeUndefined();
    expect(u.body.url).toBe("https://hooks.example.com/v2");
    const after = (
      await admin.query("select secret_enc from api_webhook_endpoints where client_id = $1", [
        clientA,
      ])
    ).rows[0].secret_enc;
    expect(after).toBe(before);
  });

  it("geçersiz/SSRF adresleri 400; bilinmeyen alan 400; JSON değilse 415", async () => {
    for (const url of [
      "http://hooks.example.com/x",
      "https://127.0.0.1/x",
      "https://169.254.169.254/latest",
      "https://localhost/x",
      "https://[::1]/x",
      "https://10.0.0.1/x",
      "https://hooks.example.com:8443/x",
      "https://u:p@hooks.example.com/x",
    ]) {
      const r = await call(keyA, "/api/v1/webhook", "PUT", { url });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("invalid_request");
    }
    expect(
      (await call(keyA, "/api/v1/webhook", "PUT", { url: "https://a.example.com", x: 1 })).status,
    ).toBe(400);
    const res = await handleApiRequest(
      new Request("https://app.kiraligim.test/api/v1/webhook", {
        method: "PUT",
        headers: { authorization: `Bearer ${keyA}`, "content-type": "text/plain" },
        body: "https://a.example.com",
      }),
      app,
      "test",
      webhookPutEndpoint,
    );
    expect(res.status).toBe(415);
  });

  it("sır yenileme: yeni sır döner; eski sırla imza artık doğrulanmaz", async () => {
    const r = await call(keyA, "/api/v1/webhook/rotate-secret", "POST");
    expect(r.status).toBe(200);
    expect(r.body.secret).toMatch(/^whsec_/);
    expect(r.body.secret).not.toBe(secretA);
    secretA = r.body.secret as string;
    expect((await call(keyB, "/api/v1/webhook/rotate-secret", "POST")).status).toBe(404);
  });

  it("anahtar tanımlı değilse oluşturma/yenileme 503; okuma ve silme çalışır", async () => {
    const saved = process.env.API_WEBHOOK_SECRET_KEY;
    delete process.env.API_WEBHOOK_SECRET_KEY;
    try {
      const p = await call(keyB, "/api/v1/webhook", "PUT", { url: "https://b.example.com/x" });
      expect(p.status).toBe(503);
      expect(p.body.error).toBe("webhooks_unavailable");
      expect((await call(keyA, "/api/v1/webhook/rotate-secret", "POST")).status).toBe(503);
      expect((await call(keyA, "/api/v1/webhook")).status).toBe(200);
    } finally {
      process.env.API_WEBHOOK_SECRET_KEY = saved;
    }
  });

  it("hesap izolasyonu: B, A'nın webhook'unu göremez/silemez", async () => {
    expect((await call(keyB, "/api/v1/webhook")).status).toBe(404);
    expect((await call(keyB, "/api/v1/webhook", "DELETE")).status).toBe(404);
    expect((await call(keyA, "/api/v1/webhook")).status).toBe(200);
  });

  it("app_user tablolara doğrudan erişemez", async () => {
    for (const t of ["api_webhook_endpoints", "api_webhook_deliveries"]) {
      await expect(appPool.query(`select * from ${t}`)).rejects.toThrow(/permission denied/);
    }
  });

  it("alıcıyı yerel test sunucusuna yönlendir (port yalnız test için doğrudan yazılır)", async () => {
    await pointHookAtLocal(clientA);
    const r = await call(keyB, "/api/v1/webhook", "PUT", { url: "https://hooks.example.com/b" });
    expect(r.status).toBe(201);
    await pointHookAtLocal(clientB);
    // İmza testleri için sırları sakla.
    (globalThis as Record<string, unknown>).__secretA = secretA;
    (globalThis as Record<string, unknown>).__secretB = r.body.secret;
  });
});

const secretOf = (c: "A" | "B") =>
  (globalThis as Record<string, unknown>)[`__secret${c}`] as string;

// ===========================================================================================
describe("teslim kuyruğu ve gönderim", () => {
  it("snapshot alınmamış bağlantı için teslim oluşmaz", async () => {
    await block(mavi, 10, 12);
    await drainAll();
    expect(await deliveries("connection_id = any($1)", [[conn.mavi, conn.maviB]])).toEqual([]);
  });

  it("snapshot sonrası değişiklik: imzalı teslim, olay kimliği = Event-Id, gövde doğru", async () => {
    expect((await snapshot(keyA, conn.mavi!)).status).toBe(200);
    expect((await snapshot(keyB, conn.maviB!)).status).toBe(200);
    await block(mavi, 20, 23);
    await drainAll();
    const rows = await deliveries("connection_id = any($1)", [[conn.mavi, conn.maviB]]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "pending" && r.attempts === 0)).toBe(true);
    const sum = await deliver();
    expect(sum.delivered).toBe(2);
    expect(hits).toHaveLength(2);
    for (const h of hits) {
      const id = h.headers["kiraligim-event-id"] as string;
      const ts = h.headers["kiraligim-timestamp"] as string;
      const sig = h.headers["kiraligim-signature"] as string;
      const body = JSON.parse(h.body) as Record<string, unknown>;
      expect(body.id).toBe(id);
      expect(body.type).toBe("calendar.changed");
      const mine = body.connection_id === conn.mavi ? "A" : "B";
      expect(verifyWebhookSignature(secretOf(mine), sig, ts, h.body)).toBe(true);
      expect(verifyWebhookSignature(secretOf(mine === "A" ? "B" : "A"), sig, ts, h.body)).toBe(
        false,
      );
      expect(Object.keys(body).sort()).toEqual(
        [
          "change",
          "connection_id",
          "created_at",
          "external_property_id",
          "id",
          "property_id",
          "type",
        ].sort(),
      );
      const ch = body.change as Record<string, unknown>;
      expect(ch.busy_dates).toEqual([{ start_date: d(20), end_date: d(23) }]);
      // Kişisel veri yok.
      expect(h.body).not.toMatch(/guest|phone|email|price|note/i);
    }
    const done = await deliveries("connection_id = any($1)", [[conn.mavi, conn.maviB]]);
    expect(done.every((r) => r.status === "delivered" && r.last_status === 204)).toBe(true);
  });

  it("yeniden deneme takvimi: 1dk,5dk,15dk,1sa,3sa,6sa,12sa,24sa; 9. denemeden sonra failed; olay kimliği sabit", async () => {
    await block(asya, 30, 31);
    await drainAll();
    expect(await pendingOf(conn.asya!)).toEqual([]); // asya henüz snapshot almadı
    await snapshot(keyA, conn.asya!);
    await block(asya, 32, 33);
    await drainAll();
    const [first] = await pendingOf(conn.asya!);
    expect(first).toBeDefined();
    reply = (h) => (JSON.parse(h.body).connection_id === conn.asya ? 503 : 204);
    const expected = [1, 5, 15, 60, 180, 360, 720, 1440];
    const ids = new Set<string>();
    for (let i = 0; i < 9; i++) {
      await dueNow();
      const t0 = Date.now();
      await deliver();
      const [row] = await deliveries("id = $1", [first!.id]);
      expect(row!.attempts).toBe(i + 1);
      if (i < 8) {
        expect(row!.status).toBe("pending");
        expect(row!.last_error).toBe("http_status");
        expect(row!.last_status).toBe(503);
        const mins = (row!.next_attempt_at.getTime() - t0) / 60_000;
        expect(Math.abs(mins - expected[i]!)).toBeLessThan(0.2);
      } else {
        expect(row!.status).toBe("failed");
        expect(row!.finished_at).not.toBeNull();
      }
    }
    for (const h of hits) {
      const b = JSON.parse(h.body);
      if (b.connection_id === conn.asya) ids.add(h.headers["kiraligim-event-id"] as string);
    }
    expect([...ids]).toEqual([first!.id]);
  });

  it("bağlantı başına sıra: baştaki teslim bitmeden sonrakiler gönderilmez", async () => {
    await block(deniz, 1, 2); // snapshot öncesi — teslim yok
    await drainAll();
    await snapshot(keyA, conn.deniz!);
    for (const a of [40, 42, 44]) {
      await block(deniz, a, a + 1);
      await drainAll();
    }
    const q = await pendingOf(conn.deniz!);
    expect(q).toHaveLength(3);
    let fail = true;
    reply = (h) => (JSON.parse(h.body).connection_id === conn.deniz && fail ? 500 : 204);
    await deliver();
    // Yalnız baştaki denendi.
    const tried = await deliveries("connection_id = $1 and attempts > 0", [conn.deniz]);
    expect(tried.map((r) => r.id)).toEqual([q[0]!.id]);
    fail = false;
    await dueNow();
    await deliver();
    const order = hits
      .map((h) => JSON.parse(h.body) as { connection_id: string; change: { change_id: string } })
      .filter((b) => b.connection_id === conn.deniz)
      .map((b) => Number(b.change.change_id));
    expect(order).toEqual([q[0]!.change_id, q[0]!.change_id, q[1]!.change_id, q[2]!.change_id]);
    expect(await pendingOf(conn.deniz!)).toEqual([]);
  });

  it("en az bir kez: sonuç yazılamazsa kilit süresi dolunca aynı olay yeniden alınır; eski belirteç stale", async () => {
    await block(deniz, 50, 51);
    await drainAll();
    const c1 = await claimDeliveries(app, 50, 60);
    const mine = c1.filter((c) => JSON.parse(c.body).connection_id === conn.deniz);
    expect(mine).toHaveLength(1);
    // Kilit sürerken yeniden alınmaz.
    const c2 = await claimDeliveries(app, 50, 60);
    expect(c2.find((c) => c.id === mine[0]!.id)).toBeUndefined();
    // Süreç düştü varsayımı: kilit süresi dolar.
    await admin.query(
      "update api_webhook_deliveries set lease_until = now() - interval '1 second' where id = $1",
      [mine[0]!.id],
    );
    const c3 = await claimDeliveries(app, 50, 60);
    const again = c3.find((c) => c.id === mine[0]!.id);
    expect(again).toBeDefined();
    expect(again!.attempt).toBe(2);
    expect(again!.lease_token).not.toBe(mine[0]!.lease_token);
    expect(JSON.parse(again!.body).id).toBe(mine[0]!.id);
    expect(await finishDelivery(app, mine[0]!.id, mine[0]!.lease_token, true, 200, null)).toBe(
      "stale",
    );
    expect(await finishDelivery(app, again!.id, again!.lease_token, true, 200, null)).toBe(
      "delivered",
    );
    expect(await finishDelivery(app, again!.id, again!.lease_token, true, 200, null)).toBe("stale");
    // Diğer alınanları serbest bırak.
    for (const c of [...c1, ...c2, ...c3].filter((c) => c.id !== mine[0]!.id)) {
      await finishDelivery(app, c.id, c.lease_token, true, 200, null);
    }
  });

  it("eşzamanlılık: paralel alımlar aynı teslimi iki kez almaz, bağlantı başına en fazla bir", async () => {
    await snapshot(keyA, conn.asya!);
    for (const a of [60, 62, 64]) {
      await block(mavi, a, a + 1);
      await block(deniz, a, a + 1);
      await block(asya, a, a + 1);
      await drainAll();
    }
    const results = await Promise.all(
      Array.from({ length: 6 }, () => claimDeliveries(app, 100, 60)),
    );
    const all = results.flat();
    const ids = all.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const perConn = new Map<string, number>();
    for (const c of all) {
      const k = JSON.parse(c.body).connection_id as string;
      perConn.set(k, (perConn.get(k) ?? 0) + 1);
    }
    expect([...perConn.values()].every((n) => n === 1)).toBe(true);
    expect(perConn.size).toBe(4); // mavi(A), mavi(B), deniz, asya
    for (const c of all) await finishDelivery(app, c.id, c.lease_token, true, 200, null);
    await deliver();
    for (const c of [conn.mavi, conn.maviB, conn.deniz, conn.asya]) {
      expect(await pendingOf(c!)).toEqual([]);
    }
  });

  it("yeni snapshot daha eski bekleyen teslimleri geçersiz kılar (superseded)", async () => {
    reply = () => 500;
    await block(deniz, 70, 71);
    await drainAll();
    await deliver();
    expect(await pendingOf(conn.deniz!)).toHaveLength(1);
    await snapshot(keyA, conn.deniz!);
    reply = () => 204;
    hits.length = 0;
    await dueNow();
    await deliver();
    const rows = await deliveries("connection_id = $1 and cancel_reason = 'superseded'", [
      conn.deniz,
    ]);
    expect(rows).toHaveLength(1);
    expect(hits).toHaveLength(0);
  });

  it("hesap pasifken teslimler bekletilir (iptal edilmez), etkinleşince gönderilir", async () => {
    await setApiClientActive(adminDb, adminId, clientB, false);
    await block(mavi, 80, 81);
    await drainAll();
    await deliver();
    const held = await pendingOf(conn.maviB!);
    expect(held).toHaveLength(1);
    expect(held[0]!.attempts).toBe(0);
    expect(hits.some((h) => JSON.parse(h.body).connection_id === conn.maviB)).toBe(false);
    await setApiClientActive(adminDb, adminId, clientB, true);
    await deliver();
    expect(await pendingOf(conn.maviB!)).toEqual([]);
    expect(hits.some((h) => JSON.parse(h.body).connection_id === conn.maviB)).toBe(true);
  });

  it("villa pasif: bekleyenler iptal (paused), yeni değişiklik gönderilmez; etkinleşince tam pencere", async () => {
    reply = () => 500;
    await block(asya, 90, 91);
    await drainAll();
    await deliver(); // başarısız, bekliyor
    expect(await pendingOf(conn.asya!)).toHaveLength(1);
    await as(O, ws, (tx, ctx) => setPropertyStatus(tx, ctx, asya, "passive"));
    await drainAll();
    reply = () => 204;
    hits.length = 0;
    await dueNow();
    await deliver();
    expect(await pendingOf(conn.asya!)).toEqual([]);
    expect(
      await deliveries("connection_id = $1 and cancel_reason = 'paused'", [conn.asya]),
    ).toHaveLength(1);
    expect(hits).toHaveLength(0);
    // Pasifken (iç işlemler) değişiklik yok sayılır, teslim oluşmaz.
    const pend = await deliveries("connection_id = $1 and status = 'pending'", [conn.asya]);
    expect(pend).toEqual([]);
    await as(O, ws, (tx, ctx) => setPropertyStatus(tx, ctx, asya, "active"));
    await drainAll();
    await deliver();
    const got = hits
      .map((h) => JSON.parse(h.body) as { connection_id: string; change: Record<string, unknown> })
      .filter((b) => b.connection_id === conn.asya);
    expect(got).toHaveLength(1);
    const ch = got[0]!.change as { start_date: string; end_date: string; busy_dates: Busy[] };
    expect(ch.start_date).toBe(d(-366));
    expect(ch.end_date).toBe(d(731));
    expect(ch.busy_dates).toEqual(await truth(asya, d(-366), d(731)));
  });

  it("bağlantı kesilince bekleyenler iptal (connection_ended), sonra hiç gönderilmez", async () => {
    reply = () => 500;
    await block(deniz, 100, 101);
    await drainAll();
    await deliver();
    expect(await pendingOf(conn.deniz!)).toHaveLength(1);
    const r = await call(keyA, `/api/v1/calendar-connections/${conn.deniz}`, "DELETE");
    expect(r.status).toBe(200);
    expect(await pendingOf(conn.deniz!)).toEqual([]);
    expect(
      await deliveries("connection_id = $1 and cancel_reason = 'connection_ended'", [conn.deniz]),
    ).toHaveLength(1);
    reply = () => 204;
    hits.length = 0;
    await block(deniz, 102, 103);
    await drainAll();
    await dueNow();
    await deliver();
    expect(hits.filter((h) => JSON.parse(h.body).connection_id === conn.deniz)).toHaveLength(0);
  });

  it("izin kaldırılınca bekleyenler iptal; webhook silinince bekleyenler iptal (no_endpoint)", async () => {
    reply = () => 500;
    await block(mavi, 110, 111);
    await drainAll();
    await deliver();
    expect(await pendingOf(conn.maviB!)).toHaveLength(1);
    expect(await pendingOf(conn.mavi!)).toHaveLength(1);
    const g = (
      await admin.query(
        "select id from api_access_grants where client_id = $1 and property_id = $2 and status = 'active'",
        [clientB, mavi],
      )
    ).rows[0].id as string;
    await revokeApiAccess(adminDb, adminId, g);
    expect(await pendingOf(conn.maviB!)).toEqual([]);
    expect((await call(keyA, "/api/v1/webhook", "DELETE")).status).toBe(200);
    expect(await pendingOf(conn.mavi!)).toEqual([]);
    expect(
      await deliveries("connection_id = $1 and cancel_reason = 'no_endpoint'", [conn.mavi]),
    ).toHaveLength(1);
    // Webhook yokken teslim kaydı oluşmaz.
    await block(mavi, 112, 113);
    await drainAll();
    expect(await pendingOf(conn.mavi!)).toEqual([]);
    reply = () => 204;
    hits.length = 0;
    await dueNow();
    await deliver();
    expect(hits).toHaveLength(0);
  });
});

// ===========================================================================================
describe("hesap geneli değişiklik akışı (GET /api/v1/calendar-changes)", () => {
  let C: string, D: string, M: string;
  let B2: string;

  beforeAll(async () => {
    // Yeni villalar ve temiz bağlantılar.
    const villa = (name: string) =>
      as(O, ws, (tx, ctx) =>
        createProperty(tx, ctx, {
          name,
          propertyType: "villa",
          maxGuests: "4",
          bedrooms: "2",
          bathrooms: "1",
          province: "Muğla",
          district: "Fethiye",
        }),
      );
    C = await villa("Villa Çam");
    D = await villa("Villa Defne");
    M = await villa("Villa Mersin");
    for (const p of [C, D, M]) await grantApiAccess(adminDb, adminId, clientA, p);
    await grantApiAccess(adminDb, adminId, clientB, C);
    for (const [n, p] of [
      ["cam", C],
      ["defne", D],
      ["mersin", M],
    ] as const) {
      conn[n] = (
        await call(keyA, "/api/v1/calendar-connections", "POST", {
          property_id: p,
          external_property_id: `acc-${n}`,
        })
      ).body.id as string;
    }
    B2 = (
      await call(keyB, "/api/v1/calendar-connections", "POST", {
        property_id: C,
        external_property_id: "B-cam",
      })
    ).body.id as string;
    await drainAll();
  });

  it("cursor yoksa şimdiki konumdan başlar: boş liste + hesaba özel cursor", async () => {
    const r = await call(keyA, "/api/v1/calendar-changes");
    expect(r.status).toBe(200);
    expect(r.body.changes).toEqual([]);
    expect(r.body.has_more).toBe(false);
    expect(r.body.next_cursor).toMatch(/^a1\.[0-9a-f]{32}\.\d+\.\d+\.[0-9a-f]{32}$/);
    expect(r.body.next_cursor).toContain(clientA.replace(/-/g, ""));
  });

  it("yalnız snapshot alınmış etkin bağlantılar; snapshot öncesi değişiklik gelmez; sayfalama", async () => {
    const start = (await call(keyA, "/api/v1/calendar-changes")).body.next_cursor as string;
    await block(C, 5, 6); // hiç snapshot yok
    await drainAll();
    let r = await call(keyA, `/api/v1/calendar-changes?cursor=${encodeURIComponent(start)}`);
    expect(r.body.changes).toEqual([]);
    await snapshot(keyA, conn.cam!);
    await snapshot(keyA, conn.defne!);
    for (const [p, a] of [
      [C, 10],
      [D, 10],
      [C, 12],
      [D, 12],
      [M, 12],
    ] as const) {
      await block(p, a, a + 1);
      await drainAll();
    }
    const seen: { connection_id: string; change_id: string; external_property_id: string }[] = [];
    let cur = start;
    let pages = 0;
    for (;;) {
      r = await call(keyA, `/api/v1/calendar-changes?cursor=${encodeURIComponent(cur)}&limit=1`);
      expect(r.status).toBe(200);
      seen.push(...(r.body.changes as typeof seen));
      cur = r.body.next_cursor as string;
      pages += 1;
      if (!r.body.has_more) break;
    }
    expect(pages).toBeGreaterThanOrEqual(4);
    expect(seen.map((c) => c.connection_id)).toEqual([conn.cam, conn.defne, conn.cam, conn.defne]);
    const ids = seen.map((c) => Number(c.change_id));
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    expect(seen.map((c) => c.external_property_id)).toEqual([
      "acc-cam",
      "acc-defne",
      "acc-cam",
      "acc-defne",
    ]);
    // Sonda yeni değişiklik yoksa boş ve aynı konum.
    r = await call(keyA, `/api/v1/calendar-changes?cursor=${encodeURIComponent(cur)}`);
    expect(r.body.changes).toEqual([]);
  });

  it("snapshot + akış = merkezi gerçek (aynı veri)", async () => {
    const s = (await snapshot(keyA, conn.cam!)).body;
    const days = new Set<string>();
    const fill = (b: Busy) => {
      for (let x = b.start_date; x < b.end_date; x = addDays(x, 1)) days.add(x);
    };
    for (const b of s.busy_dates as Busy[]) fill(b);
    const cur = (await call(keyA, "/api/v1/calendar-changes")).body.next_cursor as string;
    await block(C, 20, 25);
    await drainAll();
    await block(C, 30, 31);
    await drainAll();
    const r = await call(keyA, `/api/v1/calendar-changes?cursor=${encodeURIComponent(cur)}`);
    for (const c of r.body.changes as (Busy & { connection_id: string; busy_dates: Busy[] })[]) {
      if (c.connection_id !== conn.cam) continue;
      for (let x = c.start_date; x < c.end_date; x = addDays(x, 1)) days.delete(x);
      for (const b of c.busy_dates) fill(b);
    }
    const want = new Set<string>();
    for (const b of await truth(C, s.from as string, s.to as string)) {
      for (let x = b.start_date; x < b.end_date; x = addDays(x, 1)) want.add(x);
    }
    expect([...days].sort()).toEqual([...want].sort());
  });

  it("cursor izolasyonu: başka hesabın, bağlantı akışının veya değiştirilmiş cursor reddedilir", async () => {
    const a = (await call(keyA, "/api/v1/calendar-changes")).body.next_cursor as string;
    const b = (await call(keyB, "/api/v1/calendar-changes")).body.next_cursor as string;
    const bad = async (key: string, cur: string) => {
      const r = await call(key, `/api/v1/calendar-changes?cursor=${encodeURIComponent(cur)}`);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("invalid_cursor");
    };
    await bad(keyB, a);
    await bad(keyA, b);
    // B'nin istemci kimliğini A'nınkiyle değiştirme (MAC tutmaz).
    await bad(keyA, b.replace(clientB.replace(/-/g, ""), clientA.replace(/-/g, "")));
    const conCur = (await snapshot(keyA, conn.cam!)).body.cursor as string;
    await bad(keyA, conCur);
    const parts = a.split(".");
    await bad(keyA, [parts[0], parts[1], "1", parts[3], parts[4]].join("."));
    await bad(keyA, a.slice(0, -1) + (a.endsWith("0") ? "1" : "0"));
    await bad(keyA, "a1.zz");
    // Gelecekteki konum.
    const fut = (
      await admin.query(
        "select public.app_api_account_cursor_issue((select cursor_key from api_clients where id = $1), $1, $2) c",
        [clientA, (await lastChange()) + 1000],
      )
    ).rows[0].c as string;
    await bad(keyA, fut);
    // A ve B aynı villayı (Çam) izliyor: B yalnız kendi bağlantısını görür.
    await snapshot(keyB, B2);
    const bc = (await call(keyB, "/api/v1/calendar-changes")).body.next_cursor as string;
    await block(C, 40, 41);
    await drainAll();
    const rb = await call(keyB, `/api/v1/calendar-changes?cursor=${encodeURIComponent(bc)}`);
    const conns = (rb.body.changes as { connection_id: string }[]).map((c) => c.connection_id);
    expect(conns).toEqual([B2]);
  });

  it("süre dolumu: 30 günden eski veya saklama sınırının gerisindeki cursor 410", async () => {
    const issue = async (id: number, epoch: number) =>
      (
        await admin.query(
          `select x.p || '.' || public.app_api_cursor_mac(k.cursor_key, x.p) c
             from api_clients k,
                  (select 'a1.' || replace($1::text, '-', '') || '.' || $2::text || '.' || $3::text p) x
            where k.id = $1::uuid`,
          [clientA, id, epoch],
        )
      ).rows[0].c as string;
    const now = Math.floor(Date.now() / 1000);
    const last = await lastChange();
    let r = await call(
      keyA,
      `/api/v1/calendar-changes?cursor=${encodeURIComponent(await issue(last, now - 31 * 86400))}`,
    );
    expect(r.status).toBe(410);
    expect(r.body.error).toBe("cursor_expired");
    r = await call(
      keyA,
      `/api/v1/calendar-changes?cursor=${encodeURIComponent(await issue(last, now - 29 * 86400))}`,
    );
    expect(r.status).toBe(200);
    await admin.query("update api_sync_state set pruned_through_id = $1 where id = 1", [last]);
    try {
      r = await call(
        keyA,
        `/api/v1/calendar-changes?cursor=${encodeURIComponent(await issue(last - 1, now))}`,
      );
      expect(r.status).toBe(410);
    } finally {
      await admin.query("update api_sync_state set pruned_through_id = 0 where id = 1");
    }
  });

  it("kesilen, izni kaldırılan ve pasif villaların değişiklikleri gelmez", async () => {
    await snapshot(keyA, conn.mersin!);
    const cur = (await call(keyA, "/api/v1/calendar-changes")).body.next_cursor as string;
    // Defne: bağlantı kesildi. Mersin: izin kaldırıldı. Çam: pasif.
    await call(keyA, `/api/v1/calendar-connections/${conn.defne}`, "DELETE");
    const g = (
      await admin.query(
        "select id from api_access_grants where client_id = $1 and property_id = $2 and status = 'active'",
        [clientA, M],
      )
    ).rows[0].id as string;
    await revokeApiAccess(adminDb, adminId, g);
    await as(O, ws, (tx, ctx) => setPropertyStatus(tx, ctx, C, "passive"));
    for (const p of [C, D, M]) await block(p, 150, 151).catch(() => undefined);
    await drainAll();
    const r = await call(keyA, `/api/v1/calendar-changes?cursor=${encodeURIComponent(cur)}`);
    expect(r.status).toBe(200);
    const got = r.body.changes as { connection_id: string }[];
    expect(
      got.filter((c) => [conn.defne, conn.mersin, conn.cam].includes(c.connection_id)),
    ).toEqual([]);
    // Pasif villa yeniden etkin: tam pencere değişikliği gelir.
    await as(O, ws, (tx, ctx) => setPropertyStatus(tx, ctx, C, "active"));
    await drainAll();
    const r2 = await call(keyA, `/api/v1/calendar-changes?cursor=${encodeURIComponent(cur)}`);
    const cam = (
      r2.body.changes as { connection_id: string; start_date: string; end_date: string }[]
    ).filter((c) => c.connection_id === conn.cam);
    // Son değişiklik tam pencere (12 ay geri / 24 ay ileri) ve güncel gerçeği taşır.
    expect(cam.length).toBeGreaterThanOrEqual(1);
    expect(cam.at(-1)!.start_date).toBe(d(-366));
    expect(cam.at(-1)!.end_date).toBe(d(731));
    expect((cam.at(-1) as unknown as { busy_dates: Busy[] }).busy_dates).toEqual(
      await truth(C, d(-366), d(731)),
    );
  });

  it("parametre doğrulama", async () => {
    for (const q of ["?x=1", "?limit=0", "?limit=501", "?cursor=", "?cursor=a&cursor=b"]) {
      const r = await call(keyA, `/api/v1/calendar-changes${q}`);
      expect(r.status).toBe(400);
    }
  });
});
