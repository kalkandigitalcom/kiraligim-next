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
import {
  createApiClient,
  createApiKey,
  grantApiAccess,
  listApiConnections,
  listApiGrants,
  revokeApiAccess,
  setApiClientActive,
} from "@/server/admin/api-clients";
import {
  connectEndpoint,
  connectionEndpoint,
  connectionsEndpoint,
  disconnectEndpoint,
  propertiesEndpoint,
} from "@/server/api/endpoints";
import { listPropertyApiConnections, listPropertyApiGrants } from "@/server/api/grants";
import { type ApiContext, type ApiResult, handleApiRequest } from "@/server/api/handler";
import { hashApiKey } from "@/server/api/keys";
import { createProperty, setPropertyStatus } from "@/server/properties/service";
import { addWorkspaceMember, createWorkspace } from "@/server/workspaces/service";

import { createTestAdmin } from "./wa-admin";

/**
 * API 2. aşama, 2. adım — takvim bağlantıları (drizzle/0055, 0056; src/server/api/connections.ts).
 * Gerçek PostgreSQL 17: API istekleri üretimdeki akışla (handleApiRequest + uç noktalar) bağlamsız
 * app_user ile, Super Admin GERÇEK app_admin rolüyle, villa sayfası app_user + withTenant ile.
 *
 * Doğrulananlar: etkin izinli villa otomatik active bağlantı; aynı istek idempotent; aynı villa
 * ve aynı acente villa kimliği için tek etkin bağlantı (eşzamanlı istekler dahil); izinsiz /
 * başka acentenin / pasif villa bağlanamaz; listeleme, detay ve silme yalnız kendi bağlantısı;
 * villa/işletme/hesap pasifken "paused" (saklanmaz); izin kaldırılınca (ev sahibi / Super Admin)
 * bağlantı aynı transaction'da "revoked"; yeniden bağlanma yeni satır; 1. aşama uç noktaları ve
 * api_calendar_dirty değişmez; tablo uygulama rollerine kapalı; denetim kayıtları.
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 12 });
const app = drizzle(appPool, { schema, casing: DB_CASING });
const adminRolePool = new Pool({ connectionString: db.adminUrl, max: 3 });
adminRolePool.on("connect", (c) => void c.query("set role app_admin"));
const adminDb = drizzle(adminRolePool, { schema, casing: DB_CASING });
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

let O: U, S: U, X: U;
let ws: string, wsX: string;
let mavi: string, asya: string, kapali: string, sari: string, villaX: string;
let adminId: string;
let clientA: string, clientB: string;
let keyA: string, keyB: string;
const planCode = `apic_${tag}`;

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

type Res = { status: number; body: Record<string, unknown>; headers: Headers };
/** Üretimdeki route eşlemesinin aynısı (src/app/api/v1/calendar-connections/…). */
async function call(
  method: "GET" | "POST" | "DELETE",
  path: string,
  key: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Res> {
  const init: RequestInit = {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
  };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const req = new Request(`https://app.kiraligim.test${path}`, init);
  const rest = new URL(req.url).pathname.split("/").filter(Boolean).slice(2);
  let run: (ctx: ApiContext) => Promise<ApiResult>;
  if (rest[0] === "properties") run = propertiesEndpoint;
  else if (rest.length === 1 && method === "GET") run = connectionsEndpoint;
  else if (rest.length === 1 && method === "POST") run = connectEndpoint;
  else if (rest.length === 2 && method === "GET") run = (c) => connectionEndpoint(c, rest[1]!);
  else if (rest.length === 2 && method === "DELETE") run = (c) => disconnectEndpoint(c, rest[1]!);
  else throw new Error(`yol yok ${method} ${path}`);
  const res = await handleApiRequest(req, app, "test", run);
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
    headers: res.headers,
  };
}
const connect = (key: string, property: string, external: string) =>
  call("POST", "/api/v1/calendar-connections", key, {
    property_id: property,
    external_property_id: external,
  });
const list = async (key: string, q = "") =>
  (await call("GET", `/api/v1/calendar-connections${q}`, key)).body.data as Record<
    string,
    unknown
  >[];
const errCode = (r: Res) => (r.body.error as { code: string }).code;
const dbRow = async (id: string) =>
  (
    await admin.query(
      "select status, end_reason, ended_at is not null ended from api_calendar_connections where id = $1",
      [id],
    )
  ).rows[0];
const dirtyCount = async () =>
  Number((await admin.query("select count(*) n from api_calendar_dirty")).rows[0].n);

beforeAll(async () => {
  await admin.connect();
  O = await mkUser("apco");
  S = await mkUser("apcs");
  X = await mkUser("apcx");
  ws = (await createWorkspace(app, { userId: O.id, name: "Bağlantı", slug: `apc-${tag}` })).id;
  wsX = (await createWorkspace(app, { userId: X.id, name: "Başka", slug: `apcx-${tag}` })).id;
  const planId = uuidv7();
  await admin.query(
    "insert into plans (id, code, name, max_properties, trial_days, is_active, is_default) values ($1, $2, 'Bağlantı', 20, 14, true, false)",
    [planId, planCode],
  );
  await admin.query(
    "update workspace_subscriptions set plan_id = $1 where workspace_id = any($2)",
    [planId, [ws, wsX]],
  );
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: S.id, role: "staff" }));
  mavi = await villa(O, ws, "Villa Mavi");
  asya = await villa(O, ws, "Villa Asya");
  kapali = await villa(O, ws, "Villa Kapalı");
  sari = await villa(O, ws, "Villa Sarı");
  villaX = await villa(X, wsX, "Başka Villa");

  adminId = await createTestAdmin(admin, "apic");
  clientA = await createApiClient(adminDb, adminId, "Acente Alfa");
  clientB = await createApiClient(adminDb, adminId, "Acente Beta");
  keyA = (await createApiKey(adminDb, adminId, clientA, "")).key;
  keyB = (await createApiKey(adminDb, adminId, clientB, "")).key;
  // A: mavi, asya, kapali, sari; B: villaX + mavi (hepsi Super Admin)
  for (const p of [mavi, asya, kapali, sari]) await grantApiAccess(adminDb, adminId, clientA, p);
  await grantApiAccess(adminDb, adminId, clientB, villaX);
  await grantApiAccess(adminDb, adminId, clientB, mavi);
  await as(O, ws, (tx, ctx) => setPropertyStatus(tx, ctx, kapali, "passive"));
});

afterAll(async () => {
  await admin.query(
    "update workspace_subscriptions set plan_id = (select id from plans where is_default) where workspace_id = any($1)",
    [[ws, wsX]],
  );
  await admin.query("delete from plans where code = $1", [planCode]);
  await admin.end();
  await adminRolePool.end();
  await appPool.end();
});

let connMavi: string;

describe("bağlantı kurma", () => {
  it("etkin izinli villa: 201 ve doğrudan active; yalnız tanımlı alanlar", async () => {
    const r = await connect(keyA, mavi, "VILLA-001");
    expect(r.status).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual([
      "created_at",
      "ended_at",
      "external_property_id",
      "id",
      "last_synced_at",
      "property_id",
      "status",
    ]);
    expect(r.body).toMatchObject({
      property_id: mavi,
      external_property_id: "VILLA-001",
      status: "active",
      ended_at: null,
      last_synced_at: null,
    });
    connMavi = r.body.id as string;
    expect(await dbRow(connMavi)).toEqual({ status: "active", end_reason: null, ended: false });
  });

  it("aynı istek tekrar: 200 ve aynı bağlantı (idempotent); büyük/küçük harf ayrı kimliktir", async () => {
    const r = await connect(keyA, mavi.toUpperCase(), "VILLA-001");
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(connMavi);
    const lower = await connect(keyA, mavi, "villa-001");
    expect(lower.status).toBe(409);
    expect(errCode(lower)).toBe("already_connected");
  });

  it("aynı villa başka acente kimliğiyle: 409 already_connected", async () => {
    const r = await connect(keyA, mavi, "VILLA-999");
    expect(r.status).toBe(409);
    expect(r.body).toEqual({
      error: {
        code: "already_connected",
        message: "This property is already connected with a different external_property_id.",
      },
    });
  });

  it("aynı acente kimliği başka villada: 409 external_id_in_use", async () => {
    const r = await connect(keyA, asya, "VILLA-001");
    expect(r.status).toBe(409);
    expect(errCode(r)).toBe("external_id_in_use");
  });

  it("farklı acente aynı villayı ve aynı kimliği bağlayabilir (tekillik acente içinde)", async () => {
    const r = await connect(keyB, mavi, "VILLA-001");
    expect(r.status).toBe(201);
  });

  it("izinsiz, başka işletmenin, olmayan ve pasif villa: aynı 404", async () => {
    const bodies = new Set<string>();
    for (const p of [villaX, uuidv7(), kapali]) {
      const r = await connect(keyA, p, `EXT-${p.slice(0, 6)}`);
      expect(r.status, p).toBe(404);
      bodies.add(JSON.stringify(r.body));
    }
    expect([...bodies]).toEqual([
      JSON.stringify({ error: { code: "not_found", message: "Not found." } }),
    ]);
  });

  it("gövde doğrulama: 400 / 413 / 415; hiçbir satır oluşmaz", async () => {
    const before = Number(
      (await admin.query("select count(*) n from api_calendar_connections")).rows[0].n,
    );
    const bad: [unknown, string][] = [
      [{}, "invalid_request"],
      [{ property_id: asya }, "invalid_request"],
      [{ property_id: "x", external_property_id: "A" }, "invalid_request"],
      [{ property_id: asya, external_property_id: "" }, "invalid_request"],
      [{ property_id: asya, external_property_id: " A" }, "invalid_request"],
      [{ property_id: asya, external_property_id: "A " }, "invalid_request"],
      [{ property_id: asya, external_property_id: "Ş" }, "invalid_request"],
      [{ property_id: asya, external_property_id: "A\nB" }, "invalid_request"],
      [{ property_id: asya, external_property_id: "A".repeat(101) }, "invalid_request"],
      [{ property_id: asya, external_property_id: 12 }, "invalid_request"],
      [{ property_id: asya, external_property_id: "A", extra: 1 }, "invalid_request"],
      ["[]", "invalid_request"],
      ["{bozuk", "invalid_request"],
      [
        { property_id: asya, external_property_id: "A", pad: "x".repeat(5000) },
        "payload_too_large",
      ],
    ];
    for (const [b, code] of bad) {
      const r = await call("POST", "/api/v1/calendar-connections", keyA, b);
      expect([JSON.stringify(b).slice(0, 60), r.status, errCode(r)]).toEqual([
        JSON.stringify(b).slice(0, 60),
        code === "payload_too_large" ? 413 : 400,
        code,
      ]);
    }
    const noType = await call(
      "POST",
      "/api/v1/calendar-connections",
      keyA,
      JSON.stringify({ property_id: asya, external_property_id: "A" }),
      { "content-type": "text/plain" },
    );
    expect([noType.status, errCode(noType)]).toEqual([415, "unsupported_media_type"]);
    // 100 karakterlik kimlik ve boşluk içeren kimlik geçerlidir.
    expect((await connect(keyA, asya, `A ${"b".repeat(98)}`)).status).toBe(201);
    expect(
      Number((await admin.query("select count(*) n from api_calendar_connections")).rows[0].n),
    ).toBe(before + 1);
  });
});

describe("listeleme ve detay", () => {
  it("yalnız kendi bağlantıları; sayfalama; detay başka acenteye 404", async () => {
    const a = await list(keyA);
    expect(a.map((x) => x.property_id).sort()).toEqual([mavi, asya].sort());
    const b = await list(keyB);
    expect(b.map((x) => x.property_id)).toEqual([mavi]);
    expect(b[0]!.id).not.toBe(connMavi);
    const p1 = await call("GET", "/api/v1/calendar-connections?limit=1", keyA);
    expect((p1.body.data as unknown[]).length).toBe(1);
    expect(p1.body.next_cursor).toBe((p1.body.data as { id: string }[])[0]!.id);
    const p2 = await call(
      "GET",
      `/api/v1/calendar-connections?limit=1&cursor=${p1.body.next_cursor as string}`,
      keyA,
    );
    expect((p2.body.data as { id: string }[])[0]!.id).not.toBe(p1.body.next_cursor);
    expect((await call("GET", "/api/v1/calendar-connections?status=x", keyA)).status).toBe(400);
    expect(
      (await call("GET", `/api/v1/calendar-connections/${connMavi}`, keyA)).body,
    ).toMatchObject({
      id: connMavi,
      status: "active",
    });
    for (const id of [connMavi, uuidv7(), "abc"]) {
      expect((await call("GET", `/api/v1/calendar-connections/${id}`, keyB)).status).toBe(404);
    }
    expect((await call("DELETE", `/api/v1/calendar-connections/${connMavi}`, keyB)).status).toBe(
      404,
    );
    expect((await dbRow(connMavi)).status).toBe("active");
  });
});

describe("paused (saklanmaz)", () => {
  it("villa pasif → paused; veritabanında active kalır; yeniden etkin → active", async () => {
    await as(O, ws, (tx, ctx) => setPropertyStatus(tx, ctx, mavi, "passive"));
    expect((await call("GET", `/api/v1/calendar-connections/${connMavi}`, keyA)).body.status).toBe(
      "paused",
    );
    expect((await list(keyA)).find((x) => x.id === connMavi)?.status).toBe("paused");
    expect((await dbRow(connMavi)).status).toBe("active");
    // Pasif villaya yeni bağlantı kurulamaz; mevcut bağlantıyla aynı istek de 404.
    expect((await connect(keyA, mavi, "VILLA-001")).status).toBe(404);
    // 1. aşama: pasif villa listelenmez (değişmedi).
    const props = (await call("GET", "/api/v1/properties", keyA)).body.data as { id: string }[];
    expect(props.map((x) => x.id)).not.toContain(mavi);
    await as(O, ws, (tx, ctx) => setPropertyStatus(tx, ctx, mavi, "active"));
    expect((await call("GET", `/api/v1/calendar-connections/${connMavi}`, keyA)).body.status).toBe(
      "active",
    );
  });

  it("işletme askıda → paused; ev sahibi ekranında duraklatıldı", async () => {
    await admin.query("update workspaces set status = 'suspended' where id = $1", [ws]);
    expect((await call("GET", `/api/v1/calendar-connections/${connMavi}`, keyA)).body.status).toBe(
      "paused",
    );
    await admin.query("update workspaces set status = 'active' where id = $1", [ws]);
    expect((await call("GET", `/api/v1/calendar-connections/${connMavi}`, keyA)).body.status).toBe(
      "active",
    );
    await as(O, ws, (tx, ctx) => setPropertyStatus(tx, ctx, mavi, "passive"));
    const own = await as(S, ws, (tx) => listPropertyApiConnections(tx, mavi));
    expect(own.map((x) => [x.clientName, x.paused]).sort()).toEqual([
      ["Acente Alfa", true],
      ["Acente Beta", true],
    ]);
    await as(O, ws, (tx, ctx) => setPropertyStatus(tx, ctx, mavi, "active"));
  });
});

describe("bağlantıyı kesme ve yeniden bağlama", () => {
  it("acente keser: disconnected; tekrar DELETE aynı sonuç; yeniden bağlanma yeni satır", async () => {
    const r = await call("DELETE", `/api/v1/calendar-connections/${connMavi}`, keyA);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: connMavi, status: "disconnected" });
    expect(r.body.ended_at).not.toBeNull();
    const again = await call("DELETE", `/api/v1/calendar-connections/${connMavi}`, keyA);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(r.body);
    expect(await dbRow(connMavi)).toEqual({
      status: "disconnected",
      end_reason: "agency",
      ended: true,
    });
    expect((await list(keyA)).map((x) => x.id)).not.toContain(connMavi);
    expect((await list(keyA, "?status=all")).find((x) => x.id === connMavi)?.status).toBe(
      "disconnected",
    );
    // Aynı villa ve aynı kimlikle yeniden: yeni bağlantı.
    const re = await connect(keyA, mavi, "VILLA-001");
    expect(re.status).toBe(201);
    expect(re.body.id).not.toBe(connMavi);
    connMavi = re.body.id as string;
  });

  it("Super Admin izni kaldırır: bağlantı revoked; yeniden bağlanamaz; yeni izinle yeni bağlantı", async () => {
    const [g] = (await as(O, ws, (tx) => listPropertyApiGrants(tx, mavi))).filter(
      (x) => x.clientName === "Acente Alfa",
    );
    // İşletme tarafı (sahip dahil) kaldıramaz; bağlantı etkilenmez.
    for (const u of [O, S]) {
      await expect(
        as(u, ws, (tx) =>
          tx.execute(sql`select public.app_api_revoke_property_grant(${g!.id}::uuid)`),
        ),
      ).rejects.toSatisfy((e) => pgErrorInfo(e).code === "42883");
    }
    expect((await dbRow(connMavi)).status).toBe("active");
    await revokeApiAccess(adminDb, adminId, g!.id);
    expect(await dbRow(connMavi)).toEqual({
      status: "revoked",
      end_reason: "grant_revoked",
      ended: true,
    });
    expect((await call("GET", `/api/v1/calendar-connections/${connMavi}`, keyA)).body.status).toBe(
      "revoked",
    );
    expect((await connect(keyA, mavi, "VILLA-001")).status).toBe(404);
    // Başka acentenin bağlantısı etkilenmez.
    expect((await list(keyB)).map((x) => x.status)).toEqual(["active"]);
    await grantApiAccess(adminDb, adminId, clientA, mavi);
    const re = await connect(keyA, mavi, "VILLA-001");
    expect(re.status).toBe(201);
    connMavi = re.body.id as string;
  });

  it("Super Admin izni kaldırır: bağlantı revoked; yönetim ekranında görünür", async () => {
    const g = (await listApiGrants(adminDb, adminId, clientB)).find(
      (x) => x.propertyId === mavi && x.status === "active",
    )!;
    const [cB] = await list(keyB);
    await revokeApiAccess(adminDb, adminId, g.id);
    expect(await dbRow(cB!.id as string)).toMatchObject({ status: "revoked" });
    const rows = await listApiConnections(adminDb, adminId, clientB);
    expect(rows.map((x) => [x.propertyName, x.externalPropertyId, x.status])).toEqual([
      ["Villa Mavi", "VILLA-001", "revoked"],
    ]);
    expect((await listApiConnections(adminDb, adminId, clientA)).length).toBeGreaterThan(0);
  });

  it("hesap pasif: API 403; yeniden etkin: bağlantılar active", async () => {
    await setApiClientActive(adminDb, adminId, clientA, false);
    expect((await call("GET", "/api/v1/calendar-connections", keyA)).status).toBe(403);
    expect(
      (await as(O, ws, (tx) => listPropertyApiConnections(tx, mavi))).find(
        (x) => x.clientName === "Acente Alfa",
      )?.paused,
    ).toBe(true);
    await setApiClientActive(adminDb, adminId, clientA, true);
    expect((await call("GET", `/api/v1/calendar-connections/${connMavi}`, keyA)).body.status).toBe(
      "active",
    );
  });
});

describe("eşzamanlılık", () => {
  it("aynı istek 10 kez paralel: tek satır, biri 201 diğerleri 200 aynı kimlik", async () => {
    const rs = await Promise.all(Array.from({ length: 10 }, () => connect(keyA, sari, "SARI-1")));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(9);
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    const n = (
      await admin.query(
        "select count(*)::int n from api_calendar_connections where client_id = $1 and property_id = $2",
        [clientA, sari],
      )
    ).rows[0].n;
    expect(n).toBe(1);
    await call("DELETE", `/api/v1/calendar-connections/${rs[0]!.body.id as string}`, keyA);
  });

  it("aynı villa farklı kimliklerle paralel: tek etkin bağlantı, diğerleri 409", async () => {
    const rs = await Promise.all(
      Array.from({ length: 8 }, (_, i) => connect(keyA, sari, `SARI-P${i}`)),
    );
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      rs.filter((r) => r.status === 409).every((r) => errCode(r) === "already_connected"),
    ).toBe(true);
    const active = (
      await admin.query(
        "select count(*)::int n from api_calendar_connections where client_id = $1 and property_id = $2 and status = 'active'",
        [clientA, sari],
      )
    ).rows[0].n;
    expect(active).toBe(1);
  });

  it("bağlantı ile izin kaldırma yarışı: hiçbir zaman etkin bağlantı + kaldırılmış izin kalmaz", async () => {
    for (let i = 0; i < 5; i++) {
      await call(
        "DELETE",
        `/api/v1/calendar-connections/${((await list(keyA)).find((x) => x.property_id === sari)?.id as string) ?? uuidv7()}`,
        keyA,
      );
      if (i > 0) await grantApiAccess(adminDb, adminId, clientA, sari);
      const [g] = (await as(O, ws, (tx) => listPropertyApiGrants(tx, sari))).filter(
        (x) => x.clientName === "Acente Alfa",
      );
      await Promise.all([
        connect(keyA, sari, `RACE-${i}`),
        revokeApiAccess(adminDb, adminId, g!.id),
      ]);
      const bad = (
        await admin.query(
          `select count(*)::int n from api_calendar_connections c join api_access_grants g on g.id = c.grant_id
            where c.status = 'active' and g.status <> 'active'`,
        )
      ).rows[0].n;
      expect(bad).toBe(0);
    }
  });
});

describe("uyumluluk ve güvenlik", () => {
  it("1. aşama /properties değişmedi; bağlantı işlemleri api_calendar_dirty'ye yazmaz", async () => {
    const before = await dirtyCount();
    const r = await connect(keyA, asya, "ASYA-X");
    expect([200, 201, 409]).toContain(r.status);
    await call("GET", "/api/v1/calendar-connections", keyA);
    expect(await dirtyCount()).toBe(before);
    const props = await call("GET", "/api/v1/properties", keyA);
    expect(Object.keys(props.body).sort()).toEqual(["data", "next_cursor"]);
    for (const row of props.body.data as object[])
      expect(Object.keys(row).sort()).toEqual(["id", "name"]);
  });

  it("yöntem: koleksiyonda PUT/DELETE, tekilde POST 405 (Allow başlığıyla)", async () => {
    const { PUT } = await import("@/app/api/v1/calendar-connections/route");
    const one = await import("@/app/api/v1/calendar-connections/[id]/route");
    const r1 = await PUT();
    expect([r1.status, r1.headers.get("allow")]).toEqual([405, "GET, POST"]);
    const r2 = await one.POST();
    expect([r2.status, r2.headers.get("allow")]).toEqual([405, "GET, DELETE"]);
  });

  it("tablo uygulama rollerine kapalı; RLS + FORCE; fonksiyon yetkileri", async () => {
    expect(
      (
        await admin.query(
          "select relrowsecurity r, relforcerowsecurity f from pg_class where relname = 'api_calendar_connections'",
        )
      ).rows[0],
    ).toEqual({ r: true, f: true });
    for (const role of ["app_user", "app_admin", "app_worker"]) {
      const ok = (
        await admin.query(
          "select has_table_privilege($1, 'api_calendar_connections', 'select,insert,update,delete') ok",
          [role],
        )
      ).rows[0].ok;
      expect([role, ok]).toEqual([role, false]);
    }
    await expect(appPool.query("select * from api_calendar_connections")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(
      appPool.query("select * from public.app_api_connection_rows($1)", [clientA]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      appPool.query("select * from public.app_api_admin_connections($1, $2)", [adminId, clientA]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      adminRolePool.query("select * from public.app_api_connections($1, null, 10, true)", [
        hashApiKey(keyA),
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    // Geçersiz anahtar özetiyle doğrudan çağrı: 28000.
    await expect(
      appPool.query("select * from public.app_api_connect($1, $2, 'X')", ["0".repeat(64), asya]),
    ).rejects.toMatchObject({ code: "28000" });
  });

  it("denetim kaydı: bağlantı ve sonlanma, acente villa kimliği yazılmadan", async () => {
    const rows = (
      await admin.query(
        "select action, metadata from audit_log where workspace_id = $1 and action like 'api.calendar_%' order by occurred_at",
        [ws],
      )
    ).rows;
    expect(rows.some((x) => x.action === "api.calendar_connected")).toBe(true);
    expect(
      new Set(
        rows.filter((x) => x.action === "api.calendar_disconnected").map((x) => x.metadata.by),
      ),
    ).toEqual(new Set(["agency", "admin"]));
    expect(JSON.stringify(rows)).not.toContain("VILLA-001");
  });
});
