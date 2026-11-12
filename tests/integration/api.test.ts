import { randomBytes } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { DB_CASING } from "@/db/casing";
import { pgErrorInfo } from "@/db/pg-error";
import * as schema from "@/db/schema";
import { type TenantContext, type Tx, withTenant } from "@/db/tenant";
import { addDays, istanbulToday } from "@/lib/reservation-meta";
import {
  createAccessCode,
  createApiClient,
  createApiKey,
  grantApiAccess,
  listApiClients,
  listApiGrants,
  listApiKeys,
  listApiUsage,
  revokeApiAccess,
  revokeApiKey,
  setApiClientActive,
} from "@/server/admin/api-clients";
import {
  availabilityEndpoint,
  meEndpoint,
  propertiesEndpoint,
  propertyEndpoint,
} from "@/server/api/endpoints";
import {
  grantPropertyAccess,
  listPropertyApiGrants,
  lookupAccessCode,
  revokePropertyAccess,
} from "@/server/api/grants";
import { type ApiContext, type ApiResult, handleApiRequest } from "@/server/api/handler";
import { hashApiKey } from "@/server/api/keys";
import { createProperty } from "@/server/properties/service";
import { cancelReservation, createReservation } from "@/server/reservations/service";
import { addWorkspaceMember, createWorkspace } from "@/server/workspaces/service";

import { createTestAdmin } from "./wa-admin";

/**
 * Acente okuma API'si — 1. aşama (drizzle/0051, 0052; src/server/api, src/server/admin/api-clients).
 * Gerçek PostgreSQL 17: API istekleri üretimdeki istek akışıyla (handleApiRequest + uç noktalar)
 * bağlamsız app_user bağlantısında, Super Admin servisi GERÇEK app_admin rolüyle, villa sayfası
 * işlemleri app_user + withTenant (FORCE RLS) ile çalışır.
 *
 * Doğrulananlar: geçerli/geçersiz/geri alınmış anahtar, pasif hesap; izinli villa listelenir,
 * izinsiz ve başka acentenin/işletmenin villası listelenmez ve 404; izin kaldırılınca bir sonraki
 * istekte etkisiz; anahtar başına dakikada 120 istek (veritabanında, ortak sayaç); müsaitlik mevcut
 * tarih kuralıyla ([giriş, çıkış), iptal hariç, harici takvim dahil, kaynak gizli); hiçbir yanıtta
 * misafir/özel/izin verilmeyen alan yok; tablolar uygulama rollerine kapalı; denetim kayıtları.
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 6 });
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

const TODAY = istanbulToday();
const d = (n: number) => addDays(TODAY, n);

// Misafir ve özel veriler: hiçbir API yanıtında geçmemeli.
const GUEST = {
  guestName: "Zeynep Gizlisoy",
  guestPhone: "+90 532 987 65 43",
  guestEmail: "zeynep.gizli@ornek.com",
  note: "Özel not: kapı şifresi 4321",
  totalAmount: "48.750",
  depositAmount: "9.999",
  currency: "TRY",
};
// Yalnız harf içeren ya da UUID/tarih içinde rastlantıyla oluşamayacak uzunlukta değerler.
const SECRET_STRINGS = [
  "Zeynep",
  "Gizlisoy",
  "zeynep.gizli",
  "+90",
  "532 987",
  "5329876543",
  "Özel not",
  "kapı şifresi",
  "48.750",
  "4875000",
  "999900",
  "Airbnb",
  "airbnb",
  "Booking",
  "Not available",
  "Kaş",
  "Antalya",
  "Gizli açıklama",
  "direct",
  "confirmed",
  "pending",
  "block",
  "reservation",
  "guest",
  "amount",
  "note",
  "source",
  "summary",
  "workspace",
  "Merkez İşletme",
  "Başka İşletme",
];

let O: U, M: U, S: U, X: U;
let ws: string, wsX: string;
let mavi: string, asya: string, kapali: string, villaX: string, bos: string;
let adminId: string, disabledAdmin: string;
let clientA: string, clientB: string, clientC: string;
let keyA: string, keyB: string, keyC1: string, keyC2: string;
let codeA: string;
const planCode = `api_${tag}`;

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
      description: "Gizli açıklama metni",
    }),
  );
}

let extN = 0;
async function externalEvent(property: string, a: string, b: string, active = true) {
  const src = uuidv7();
  await admin.query(
    `insert into external_calendar_sources (id, workspace_id, property_id, name, url, is_active)
     values ($1, $2, $3, $4, 'https://www.airbnb.com/calendar/ical/test.ics', $5)`,
    [src, ws, property, `Airbnb a${++extN}`, active],
  );
  await admin.query(
    "update external_calendar_sources set locked_until = now() + interval '1 day' where id = $1",
    [src],
  );
  const id = uuidv7();
  await admin.query(
    `insert into external_calendar_events (id, workspace_id, property_id, source_id, uid, start_date, end_date)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [id, ws, property, src, `uid-${id}`, a, b],
  );
  return src;
}

/** Üretimdeki istek akışı: route dosyalarının yaptığı eşlemenin aynısı. */
async function call(
  path: string,
  key: string | null,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const req = new Request(`https://app.kiraligim.test${path}`, {
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
  });
  const p = new URL(req.url).pathname.split("/").filter(Boolean); // api, v1, ...
  const rest = p.slice(2);
  let run: (ctx: ApiContext) => Promise<ApiResult>;
  if (rest.length === 1 && rest[0] === "me") run = meEndpoint;
  else if (rest.length === 1 && rest[0] === "properties") run = propertiesEndpoint;
  else if (rest.length === 2 && rest[0] === "properties")
    run = (c) => propertyEndpoint(c, rest[1]!);
  else if (rest.length === 3 && rest[2] === "availability")
    run = (c) => availabilityEndpoint(c, rest[1]!);
  else throw new Error(`bilinmeyen yol ${path}`);
  const res = await handleApiRequest(req, app, "test", run);
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
    headers: res.headers,
  };
}

const ids = (body: Record<string, unknown>) =>
  (body.data as { id: string }[]).map((r) => r.id).sort();

const ownerGrant = async (u: U, property: string, code: string) =>
  as(u, ws, async (tx) => {
    const look = await lookupAccessCode(tx, code);
    if (!look.ok) return look.reason;
    return grantPropertyAccess(tx, { propertyId: property, code, clientId: look.client.id });
  });

beforeAll(async () => {
  await admin.connect();
  O = await mkUser("apio");
  M = await mkUser("apim");
  S = await mkUser("apis");
  X = await mkUser("apix");
  ws = (await createWorkspace(app, { userId: O.id, name: "Merkez İşletme", slug: `api-${tag}` }))
    .id;
  wsX = (await createWorkspace(app, { userId: X.id, name: "Başka İşletme", slug: `apix-${tag}` }))
    .id;
  const planId = uuidv7();
  await admin.query(
    "insert into plans (id, code, name, max_properties, trial_days, is_active, is_default) values ($1, $2, 'API test', 20, 14, true, false)",
    [planId, planCode],
  );
  await admin.query(
    "update workspace_subscriptions set plan_id = $1 where workspace_id = any($2)",
    [planId, [ws, wsX]],
  );
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: M.id, role: "manager" }));
  await as(O, ws, (tx, ctx) => addWorkspaceMember(tx, ctx, { userId: S.id, role: "staff" }));
  mavi = await villa(O, ws, "Villa Mavi");
  asya = await villa(O, ws, "Villa Asya");
  kapali = await villa(O, ws, "Villa Kapalı");
  bos = await villa(O, ws, "Villa Boş");
  await admin.query("update properties set status = 'passive' where id = $1", [kapali]);
  villaX = await villa(X, wsX, "Başka Villa");

  adminId = await createTestAdmin(admin, "api");
  disabledAdmin = await createTestAdmin(admin, "apipasif");
  await admin.query("update admin_users set status = 'disabled' where id = $1", [disabledAdmin]);

  clientA = await createApiClient(adminDb, adminId, "  Acente Alfa  ");
  clientB = await createApiClient(adminDb, adminId, "Acente Beta");
  clientC = await createApiClient(adminDb, adminId, "Acente Gama");
  keyA = (await createApiKey(adminDb, adminId, clientA, "Canlı")).key;
  keyB = (await createApiKey(adminDb, adminId, clientB, "")).key;
  keyC1 = (await createApiKey(adminDb, adminId, clientC, "bir")).key;
  keyC2 = (await createApiKey(adminDb, adminId, clientC, "iki")).key;
  codeA = await createAccessCode(adminDb, adminId, clientA);
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

describe("kimlik doğrulama", () => {
  it("geçerli anahtar: /me yalnız hesap kimliği, adı ve sınırı döner", async () => {
    const r = await call("/api/v1/me", keyA);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      id: clientA,
      name: "Acente Alfa",
      rate_limit: { limit: 120, window_seconds: 60 },
    });
    expect(r.headers.get("x-ratelimit-limit")).toBe("120");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("başlık yok / biçim dışı / bilinmeyen anahtar → 401 (aynı gövde)", async () => {
    const unknown = `kg_live_abcdefgh_${randomBytes(32).toString("base64url")}`;
    for (const k of [null, "yanlis", keyA.slice(0, -1), unknown]) {
      const r = await call("/api/v1/me", k);
      expect(r.status).toBe(401);
      expect(r.body).toEqual({
        error: { code: "unauthorized", message: "Missing or invalid API key." },
      });
    }
    // Sorgu dizgisindeki anahtar kabul edilmez.
    const req = new Request(`https://app.kiraligim.test/api/v1/me?api_key=${keyA}`);
    expect((await handleApiRequest(req, app, "test", meEndpoint)).status).toBe(401);
  });

  it("anahtar veritabanında yalnız özetle durur", async () => {
    const rows = (
      await admin.query("select prefix, secret_hash from api_keys where client_id = $1", [clientA])
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].secret_hash).toBe(hashApiKey(keyA));
    expect(keyA).toContain(`kg_live_${rows[0].prefix}_`);
    const dump = JSON.stringify(
      (await admin.query("select * from api_keys")).rows.concat(
        (await admin.query("select * from api_clients")).rows,
      ),
    );
    expect(dump).not.toContain(keyA.slice(17));
    expect(dump).not.toContain(codeA);
  });

  it("geri alınmış anahtar bir sonraki istekte 401; aynı hesabın diğer anahtarı çalışır", async () => {
    const tmp = await createApiKey(adminDb, adminId, clientB, "geçici");
    expect((await call("/api/v1/me", tmp.key)).status).toBe(200);
    const keyId = (await admin.query("select id from api_keys where prefix = $1", [tmp.prefix]))
      .rows[0].id as string;
    await revokeApiKey(adminDb, adminId, keyId);
    expect((await call("/api/v1/me", tmp.key)).status).toBe(401);
    expect((await call("/api/v1/properties", tmp.key)).status).toBe(401);
    expect((await call("/api/v1/me", keyB)).status).toBe(200);
    await expect(revokeApiKey(adminDb, adminId, keyId)).rejects.toMatchObject({
      reason: "not_found",
    });
  });

  it("pasif hesap: 403; yeniden etkinleştirilince anahtar çalışır", async () => {
    await setApiClientActive(adminDb, adminId, clientB, false);
    const r = await call("/api/v1/properties", keyB);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({
      error: { code: "account_disabled", message: "This API account is disabled." },
    });
    expect(await setApiClientActive(adminDb, adminId, clientB, false)).toBe("unchanged");
    await setApiClientActive(adminDb, adminId, clientB, true);
    expect((await call("/api/v1/properties", keyB)).status).toBe(200);
  });
});

describe("villa izinleri", () => {
  it("izin yokken liste boş; villa ve müsaitlik 404", async () => {
    expect((await call("/api/v1/properties", keyA)).body).toEqual({ data: [], next_cursor: null });
    expect((await call(`/api/v1/properties/${mavi}`, keyA)).status).toBe(404);
    expect((await call(`/api/v1/properties/${mavi}/availability`, keyA)).status).toBe(404);
  });

  it("ev sahibi kodu girer, acente adını görür, onaylar → villa listelenir (yalnız id, ad)", async () => {
    const look = await as(O, ws, (tx) => lookupAccessCode(tx, codeA.toLowerCase()));
    expect(look).toEqual({ ok: true, client: { id: clientA, name: "Acente Alfa" } });
    // Yalnız arama izin oluşturmaz.
    expect(ids((await call("/api/v1/properties", keyA)).body)).toEqual([]);
    expect(await ownerGrant(O, mavi, codeA)).toBe("granted");
    expect(await ownerGrant(O, mavi, codeA)).toBe("exists");
    const r = await call("/api/v1/properties", keyA);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ data: [{ id: mavi, name: "Villa Mavi" }], next_cursor: null });
    expect((await call(`/api/v1/properties/${mavi}`, keyA)).body).toEqual({
      id: mavi,
      name: "Villa Mavi",
    });
    const grants = await as(S, ws, (tx) => listPropertyApiGrants(tx, mavi));
    expect(grants).toMatchObject([{ clientName: "Acente Alfa", grantedVia: "owner" }]);
  });

  it("başka acente aynı villayı göremez", async () => {
    expect(ids((await call("/api/v1/properties", keyB)).body)).toEqual([]);
    expect((await call(`/api/v1/properties/${mavi}`, keyB)).status).toBe(404);
    expect((await call(`/api/v1/properties/${mavi}/availability`, keyB)).status).toBe(404);
  });

  it("izinsiz villa, başka işletmenin villası, olmayan ve biçimsiz kimlik aynı 404", async () => {
    const bodies = new Set<string>();
    for (const id of [asya, villaX, uuidv7(), "abc", "' or 1=1 --"]) {
      for (const path of [
        `/api/v1/properties/${encodeURIComponent(id)}`,
        `/api/v1/properties/${encodeURIComponent(id)}/availability`,
      ]) {
        const r = await call(path, keyA);
        expect(r.status, `${path}`).toBe(404);
        bodies.add(JSON.stringify(r.body));
      }
    }
    expect([...bodies]).toEqual([
      JSON.stringify({ error: { code: "not_found", message: "Not found." } }),
    ]);
  });

  it("yönetici (manager) kodla izin verir; personel (staff) veremez ve kod sorgulayamaz", async () => {
    expect(await ownerGrant(M, asya, codeA)).toBe("granted");
    await expect(as(S, ws, (tx) => lookupAccessCode(tx, codeA))).rejects.toSatisfy(
      (e) => pgErrorInfo(e).code === "42501",
    );
    await expect(
      as(S, ws, (tx) =>
        grantPropertyAccess(tx, { propertyId: bos, code: codeA, clientId: clientA }),
      ),
    ).rejects.toSatisfy((e) => pgErrorInfo(e).code === "42501");
    expect(ids((await call("/api/v1/properties", keyA)).body)).toEqual([mavi, asya].sort());
  });

  it("başka işletme kendi oturumuyla bu villaya izin veremez / izni kaldıramaz", async () => {
    expect(
      await as(X, wsX, (tx) =>
        grantPropertyAccess(tx, { propertyId: bos, code: codeA, clientId: clientA }),
      ),
    ).toBe("not_found");
    const [g] = await as(O, ws, (tx) => listPropertyApiGrants(tx, asya));
    expect(await as(X, wsX, (tx) => revokePropertyAccess(tx, g!.id))).toBe("not_found");
    expect(await as(X, wsX, (tx) => listPropertyApiGrants(tx, asya))).toEqual([]);
  });

  it("yanlış/yenilenmiş kod ve pasif hesap kodu izin vermez; onayda kod yeniden doğrulanır", async () => {
    expect(await as(O, ws, (tx) => lookupAccessCode(tx, "KG-AAAA-BBBB"))).toEqual({
      ok: false,
      reason: "invalid_code",
    });
    expect(await as(O, ws, (tx) => lookupAccessCode(tx, "12345"))).toEqual({
      ok: false,
      reason: "format",
    });
    // Kod gösterildikten sonra yenilenirse onay reddedilir.
    const look = await as(O, ws, (tx) => lookupAccessCode(tx, codeA));
    expect(look.ok).toBe(true);
    const newCode = await createAccessCode(adminDb, adminId, clientA);
    expect(
      await as(O, ws, (tx) =>
        grantPropertyAccess(tx, { propertyId: bos, code: codeA, clientId: clientA }),
      ),
    ).toBe("invalid_code");
    // Kod başka acentenin kimliğiyle kullanılamaz.
    expect(
      await as(O, ws, (tx) =>
        grantPropertyAccess(tx, { propertyId: bos, code: newCode, clientId: clientB }),
      ),
    ).toBe("invalid_code");
    codeA = newCode;
    await setApiClientActive(adminDb, adminId, clientA, false);
    expect((await as(O, ws, (tx) => lookupAccessCode(tx, codeA))).ok).toBe(false);
    await setApiClientActive(adminDb, adminId, clientA, true);
    expect((await as(O, ws, (tx) => lookupAccessCode(tx, codeA))).ok).toBe(true);
    expect(ids((await call("/api/v1/properties", keyA)).body)).toEqual([mavi, asya].sort());
  });

  it("izin kaldırılınca bir sonraki istekte villa görünmez", async () => {
    const [g] = await as(O, ws, (tx) => listPropertyApiGrants(tx, asya));
    expect((await call(`/api/v1/properties/${asya}`, keyA)).status).toBe(200);
    await expect(as(S, ws, (tx) => revokePropertyAccess(tx, g!.id))).rejects.toSatisfy(
      (e) => pgErrorInfo(e).code === "42501",
    );
    expect(await as(O, ws, (tx) => revokePropertyAccess(tx, g!.id))).toBe("revoked");
    expect(await as(O, ws, (tx) => revokePropertyAccess(tx, g!.id))).toBe("not_found");
    expect((await call(`/api/v1/properties/${asya}`, keyA)).status).toBe(404);
    expect((await call(`/api/v1/properties/${asya}/availability`, keyA)).status).toBe(404);
    expect(ids((await call("/api/v1/properties", keyA)).body)).toEqual([mavi]);
    // Yeniden izin verilebilir (yeni kayıt).
    expect(await ownerGrant(O, asya, codeA)).toBe("granted");
    expect(ids((await call("/api/v1/properties", keyA)).body)).toEqual([mavi, asya].sort());
  });

  it("Super Admin izin verir/kaldırır; pasif villa ve pasif işletme API'de görünmez", async () => {
    await grantApiAccess(adminDb, adminId, clientB, kapali);
    await grantApiAccess(adminDb, adminId, clientB, villaX);
    await expect(grantApiAccess(adminDb, adminId, clientB, villaX)).rejects.toMatchObject({
      reason: "exists",
    });
    await expect(grantApiAccess(adminDb, adminId, clientB, uuidv7())).rejects.toMatchObject({
      reason: "not_found",
    });
    expect(ids((await call("/api/v1/properties", keyB)).body)).toEqual([villaX]);
    expect((await call(`/api/v1/properties/${kapali}`, keyB)).status).toBe(404);
    await admin.query("update workspaces set status = 'suspended' where id = $1", [wsX]);
    expect(ids((await call("/api/v1/properties", keyB)).body)).toEqual([]);
    await admin.query("update workspaces set status = 'active' where id = $1", [wsX]);
    const grants = await listApiGrants(adminDb, adminId, clientB);
    expect(grants.map((g) => [g.propertyName, g.status, g.grantedVia, g.propertyActive])).toEqual(
      expect.arrayContaining([
        ["Villa Kapalı", "active", "admin", false],
        ["Başka Villa", "active", "admin", true],
      ]),
    );
    const gx = grants.find((g) => g.propertyId === villaX)!;
    await revokeApiAccess(adminDb, adminId, gx.id);
    expect(ids((await call("/api/v1/properties", keyB)).body)).toEqual([]);
    await expect(revokeApiAccess(adminDb, adminId, gx.id)).rejects.toMatchObject({
      reason: "not_found",
    });
  });

  it("sayfalama: limit + cursor (kimliğe göre sıralı)", async () => {
    const all = ids((await call("/api/v1/properties", keyA)).body);
    const p1 = await call("/api/v1/properties?limit=1", keyA);
    expect(p1.body).toEqual({
      data: [{ id: all[0], name: expect.any(String) }],
      next_cursor: all[0],
    });
    const p2 = await call(`/api/v1/properties?limit=1&cursor=${all[0]}`, keyA);
    expect((p2.body.data as { id: string }[])[0]!.id).toBe(all[1]);
    const p3 = await call(`/api/v1/properties?limit=1&cursor=${all[1]}`, keyA);
    expect(p3.body).toEqual({ data: [], next_cursor: null });
    expect((await call("/api/v1/properties?limit=0", keyA)).status).toBe(400);
  });

  it("denetim kaydı: yalnız kimlikler (kod/anahtar yok)", async () => {
    const rows = (
      await admin.query(
        "select action, actor_user_id, metadata from audit_log where workspace_id = $1 and action like 'api.%' order by occurred_at",
        [ws],
      )
    ).rows;
    expect(rows.map((r) => r.action)).toEqual([
      "api.access_granted",
      "api.access_granted",
      "api.access_revoked",
      "api.access_granted",
      "api.access_granted",
    ]);
    expect(rows[0]).toMatchObject({
      actor_user_id: O.id,
      metadata: { property: mavi, client: clientA, via: "owner" },
    });
    expect(rows[2]).toMatchObject({ metadata: { property: asya, client: clientA, by: "owner" } });
    expect(rows.at(-1)).toMatchObject({ actor_user_id: null, metadata: { via: "admin" } });
    const adminRows = (
      await admin.query(
        "select action, metadata from admin_audit_log where admin_id = $1 and action like 'api.%'",
        [adminId],
      )
    ).rows;
    expect(new Set(adminRows.map((r) => r.action))).toEqual(
      new Set([
        "api.client_created",
        "api.key_created",
        "api.key_revoked",
        "api.access_code_created",
        "api.client_disabled",
        "api.client_enabled",
        "api.access_granted",
        "api.access_revoked",
      ]),
    );
    const dump = JSON.stringify(rows) + JSON.stringify(adminRows);
    expect(dump).not.toContain(codeA);
    expect(dump).not.toContain(keyA);
    expect(dump).not.toContain(hashApiKey(keyA));
  });
});

describe("müsaitlik", () => {
  beforeAll(async () => {
    const res = (inp: Record<string, unknown>) =>
      as(O, ws, (tx, ctx) =>
        createReservation(tx, ctx, {
          kind: "reservation",
          adults: "2",
          children: "0",
          source: "airbnb",
          ...GUEST,
          ...inp,
        } as never),
      );
    // [d10, d12) rezervasyon + [d12, d14) blok → bitişik: tek aralık [d10, d14)
    await res({ propertyId: mavi, checkIn: d(10), checkOut: d(12), status: "confirmed" });
    await as(O, ws, (tx, ctx) =>
      createReservation(tx, ctx, {
        kind: "block",
        propertyId: mavi,
        checkIn: d(12),
        checkOut: d(14),
        note: GUEST.note,
      } as never),
    );
    // Beklemedeki rezervasyon dolu sayılır.
    await res({ propertyId: mavi, checkIn: d(20), checkOut: d(23), status: "pending" });
    // İptal edilen sayılmaz.
    const cancelled = await res({ propertyId: mavi, checkIn: d(30), checkOut: d(33) });
    await as(O, ws, (tx, ctx) => cancelReservation(tx, ctx, cancelled));
    // Harici takvim (etkin) dahil; pasif kaynak hariç.
    await externalEvent(mavi, d(40), d(45));
    await externalEvent(mavi, d(50), d(52), false);
    // Pencere sınırını aşan uzun kayıt (kırpılır).
    await res({ propertyId: mavi, checkIn: d(85), checkOut: d(95) });
  });

  it("dolu aralıklar: [giriş, çıkış), birleştirilmiş, iptal ve pasif kaynak hariç, kaynak gizli", async () => {
    const r = await call(`/api/v1/properties/${mavi}/availability`, keyA);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      property_id: mavi,
      from: d(0),
      to: d(90),
      busy_dates: [
        { start_date: d(10), end_date: d(14) },
        { start_date: d(20), end_date: d(23) },
        { start_date: d(40), end_date: d(45) },
        { start_date: d(85), end_date: d(90) },
      ],
    });
  });

  it("çıkış günü dolu değildir: aynı gün giriş yapan yeni kayıt mevcut kurala göre kabul edilir", async () => {
    // API end_date = d(23) diyorsa d(23) girişli rezervasyon çakışmamalı (aynı [) kuralı).
    const id = await as(O, ws, (tx, ctx) =>
      createReservation(tx, ctx, {
        kind: "block",
        propertyId: mavi,
        checkIn: d(23),
        checkOut: d(24),
      } as never),
    );
    const r = await call(`/api/v1/properties/${mavi}/availability?from=${d(18)}&to=${d(26)}`, keyA);
    expect(r.body.busy_dates).toEqual([{ start_date: d(20), end_date: d(24) }]);
    await as(O, ws, (tx, ctx) => cancelReservation(tx, ctx, id));
  });

  it("pencere: kırpma, geçmiş (12 ay) ve gelecek (24 ay) sınırı, 400 hataları", async () => {
    const r = await call(`/api/v1/properties/${mavi}/availability?from=${d(11)}&to=${d(21)}`, keyA);
    expect(r.body.busy_dates).toEqual([
      { start_date: d(11), end_date: d(14) },
      { start_date: d(20), end_date: d(21) },
    ]);
    expect(
      (await call(`/api/v1/properties/${mavi}/availability?from=${d(-366)}&to=${d(-300)}`, keyA))
        .status,
    ).toBe(200);
    for (const q of [
      `from=${d(-367)}&to=${d(-300)}`,
      `from=${d(700)}&to=${d(732)}`,
      `from=${d(5)}&to=${d(5)}`,
      `from=${d(0)}&to=${d(367)}`,
      "from=2027-02-30",
      "start=2027-01-01",
    ]) {
      const bad = await call(`/api/v1/properties/${mavi}/availability?${q}`, keyA);
      expect(bad.status, q).toBe(400);
      expect((bad.body.error as { code: string }).code).toBe("invalid_request");
    }
  });

  it("veritabanı fonksiyonu da pencereyi denetler (uygulamayı atlayan çağrı)", async () => {
    await expect(
      appPool.query("select * from public.app_api_busy($1, $2, $3, $4)", [
        hashApiKey(keyA),
        mavi,
        d(0),
        d(800),
      ]),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      appPool.query("select * from public.app_api_busy($1, $2, $3, $4)", [
        hashApiKey(keyB),
        mavi,
        d(0),
        d(30),
      ]),
    ).rejects.toMatchObject({ code: "P0002" });
    await expect(
      appPool.query("select * from public.app_api_properties($1, null, 10)", ["0".repeat(64)]),
    ).rejects.toMatchObject({ code: "28000" });
  });

  it("boş villa: busy_dates boş dizi", async () => {
    await grantApiAccess(adminDb, adminId, clientA, bos);
    expect((await call(`/api/v1/properties/${bos}/availability`, keyA)).body).toMatchObject({
      property_id: bos,
      busy_dates: [],
    });
  });
});

describe("gizlilik: yalnız izin verilen alanlar", () => {
  it("hiçbir yanıtta misafir, fiyat, adres, açıklama, kaynak veya işletme bilgisi yok", async () => {
    const paths = [
      "/api/v1/me",
      "/api/v1/properties",
      `/api/v1/properties/${mavi}`,
      `/api/v1/properties/${mavi}/availability?from=${d(0)}&to=${d(120)}`,
      `/api/v1/properties/${asya}/availability`,
      `/api/v1/properties/${villaX}`,
    ];
    for (const p of paths) {
      const r = await call(p, keyA);
      const text = JSON.stringify(r.body);
      for (const s of SECRET_STRINGS) expect(text, `${p} → ${s}`).not.toContain(s);
      expect(text).not.toContain(ws);
      expect(text).not.toContain(O.id);
    }
  });

  it("alan listeleri tam olarak tanımlı olanlar", async () => {
    expect(Object.keys((await call("/api/v1/me", keyA)).body).sort()).toEqual([
      "id",
      "name",
      "rate_limit",
    ]);
    const list = (await call("/api/v1/properties", keyA)).body;
    expect(Object.keys(list).sort()).toEqual(["data", "next_cursor"]);
    for (const row of list.data as object[])
      expect(Object.keys(row).sort()).toEqual(["id", "name"]);
    expect(Object.keys((await call(`/api/v1/properties/${mavi}`, keyA)).body).sort()).toEqual([
      "id",
      "name",
    ]);
    const av = (await call(`/api/v1/properties/${mavi}/availability`, keyA)).body;
    expect(Object.keys(av).sort()).toEqual(["busy_dates", "from", "property_id", "to"]);
    for (const b of av.busy_dates as object[]) {
      expect(Object.keys(b).sort()).toEqual(["end_date", "start_date"]);
    }
  });

  it("API tabloları hiçbir uygulama rolüne doğrudan açık değil", async () => {
    for (const t of [
      "api_clients",
      "api_keys",
      "api_access_grants",
      "api_rate_windows",
      "api_usage_daily",
    ]) {
      await expect(appPool.query(`select * from ${t} limit 1`)).rejects.toMatchObject({
        code: "42501",
      });
      await expect(adminRolePool.query(`select * from ${t} limit 1`)).rejects.toMatchObject({
        code: "42501",
      });
    }
    // İç yardımcı ve yönetici fonksiyonları app_user'a kapalı; API fonksiyonları app_admin'e kapalı.
    await expect(
      appPool.query("select * from public.app_api_resolve_key($1)", [hashApiKey(keyA)]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      appPool.query("select * from public.app_api_admin_clients($1)", [adminId]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      adminRolePool.query("select * from public.app_api_begin($1)", [hashApiKey(keyA)]),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("pasif yönetici hiçbir Super Admin işlemi yapamaz", async () => {
    await expect(listApiClients(adminDb, disabledAdmin)).rejects.toSatisfy(
      (e) => pgErrorInfo(e).code === "42501",
    );
    await expect(createApiClient(adminDb, disabledAdmin, "X")).rejects.toSatisfy(
      (e) => pgErrorInfo(e).code === "42501",
    );
  });
});

describe("istek sınırı (anahtar başına dakikada 120)", () => {
  it("121. istek 429; aynı hesabın diğer anahtarı etkilenmez; pencere dolunca yeniden açılır", async () => {
    // Dakika sınırına çok yakınsa bir sonraki dakikayı bekle (sayaç dakika başında sıfırlanır).
    const sec = new Date().getSeconds();
    if (sec > 50) await new Promise((r) => setTimeout(r, (61 - sec) * 1000));
    for (let i = 0; i < 120; i++) {
      const r = await call("/api/v1/me", keyC1);
      expect(r.status).toBe(200);
      expect(r.headers.get("x-ratelimit-remaining")).toBe(String(119 - i));
    }
    const limited = await call("/api/v1/me", keyC1);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
      error: { code: "rate_limited", message: "Rate limit exceeded. Retry after the reset time." },
    });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(limited.headers.get("x-ratelimit-remaining")).toBe("0");
    expect((await call("/api/v1/properties", keyC1)).status).toBe(429);
    expect((await call("/api/v1/me", keyC2)).status).toBe(200);
    // Sayaç tek satırda ve sınırı aşmaz (ortak, kalıcı sayaç).
    const w = (
      await admin.query(
        "select w.count from api_rate_windows w join api_keys k on k.id = w.key_id where k.secret_hash = $1",
        [hashApiKey(keyC1)],
      )
    ).rows;
    expect(w).toEqual([{ count: 120 }]);
    // Pencereyi geçmişe al (yeni dakika): istek kabul edilir, eski pencere silinir.
    await admin.query(
      "update api_rate_windows set window_start = window_start - interval '2 minutes' where key_id = (select id from api_keys where secret_hash = $1)",
      [hashApiKey(keyC1)],
    );
    expect((await call("/api/v1/me", keyC1)).status).toBe(200);
    const after = (
      await admin.query(
        "select w.count from api_rate_windows w join api_keys k on k.id = w.key_id where k.secret_hash = $1",
        [hashApiKey(keyC1)],
      )
    ).rows;
    expect(after).toEqual([{ count: 1 }]);
  });

  it("eşzamanlı istekler sınırı aşamaz (atomik sayaç)", async () => {
    const k = (await createApiKey(adminDb, adminId, clientC, "eşzamanlı")).key;
    const sec = new Date().getSeconds();
    if (sec > 50) await new Promise((r) => setTimeout(r, (61 - sec) * 1000));
    const results = await Promise.all(
      Array.from({ length: 140 }, () =>
        appPool.query<{ outcome: string }>("select outcome from public.app_api_begin($1)", [
          hashApiKey(k),
        ]),
      ),
    );
    const ok = results.filter((r) => r.rows[0]!.outcome === "ok").length;
    expect(ok).toBe(120);
  });

  it("günlük kullanım: istek, sınır aşımı ve 4xx sayılır; Super Admin görür", async () => {
    const usage = await listApiUsage(adminDb, adminId, clientC);
    expect(usage[0]).toMatchObject({ day: TODAY });
    expect(usage[0]!.requests).toBe(120 + 1 + 1 + 120);
    expect(usage[0]!.rateLimited).toBe(2 + 20);
    const before = (await listApiUsage(adminDb, adminId, clientA))[0]!.errors;
    expect((await call(`/api/v1/properties/${villaX}`, keyA)).status).toBe(404);
    expect((await call("/api/v1/properties?limit=x", keyA)).status).toBe(400);
    expect((await listApiUsage(adminDb, adminId, clientA))[0]!.errors).toBe(before + 2);
    const list = await listApiClients(adminDb, adminId);
    expect(list.find((c) => c.id === clientC)).toMatchObject({
      name: "Acente Gama",
      status: "active",
      activeKeys: 3,
    });
  });

  it("hesap başına en fazla 5 etkin anahtar", async () => {
    await createApiKey(adminDb, adminId, clientC, "d");
    await createApiKey(adminDb, adminId, clientC, "e");
    await expect(createApiKey(adminDb, adminId, clientC, "f")).rejects.toMatchObject({
      reason: "limit",
    });
    const keys = await listApiKeys(adminDb, adminId, clientC);
    expect(keys.filter((k) => k.status === "active")).toHaveLength(5);
    expect(JSON.stringify(keys)).not.toContain("secret");
  });
});
