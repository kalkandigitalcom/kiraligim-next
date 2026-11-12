import { randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { DB_CASING } from "@/db/casing";
import { pgErrorInfo } from "@/db/pg-error";
import * as schema from "@/db/schema";
import { type Tx, withTenant, withUser } from "@/db/tenant";
import {
  createProperty,
  getProperty,
  getPropertyUsage,
  listProperties,
  setPropertyStatus,
  updateProperty,
} from "@/server/properties/service";
import { addWorkspaceMember, createWorkspace } from "@/server/workspaces/service";

/**
 * Aşama 2.4b: mülkler (0009, 0010) — gerçek PostgreSQL. Uygulama işlemleri yalnız app_user ile;
 * yönetici bağlantısı kurulum ve doğrulama içindir.
 */
const db = inject("testDb");
const appPool = new Pool({ connectionString: db.appUrl, max: 6 });
const app = drizzle(appPool, { schema, casing: DB_CASING });
const admin = new Client({ connectionString: db.adminUrl });

const tag = randomBytes(3).toString("hex");
const slugOf = (s: string) => `${s}-${tag}`;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const pgMessage = (p: Promise<unknown>) =>
  p.then(
    () => "başarılı (hata bekleniyordu)",
    (err: unknown) => pgErrorInfo(err).message ?? String(err),
  );

type U = { id: string; name: string };
const mkUser = async (label: string): Promise<U> => {
  const u = { id: uuidv7(), name: `${label} Kullanıcı` };
  await admin.query("insert into users (id, name, email) values ($1, $2, $3)", [
    u.id,
    u.name,
    `${label}.${tag}@ornek.com`,
  ]);
  return u;
};
const mkWorkspace = async (owner: U, label: string) =>
  (await createWorkspace(app, { userId: owner.id, name: `${label} İşletme`, slug: slugOf(label) }))
    .id;

const asRawContext = <T>(userId: string, workspaceId: string, fn: (tx: Tx) => Promise<T>) =>
  withUser(app, userId, async (tx) => {
    await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
    return fn(tx);
  });

const valid = (over: Record<string, unknown> = {}) => ({
  name: "Deniz Villa",
  propertyType: "villa",
  description: "Denize 200 m.",
  maxGuests: "6",
  bedrooms: "3",
  bathrooms: "2",
  province: "Antalya",
  district: "Kaş",
  neighborhood: "Kalkan",
  mapLocation: "https://www.google.com/maps/@36.2651,29.4143,15z",
  distanceBeachKm: "1,5",
  ...over,
});

/** withTenant'ı atlayan ham ekleme (uygulama denetimi olmadan, yalnız veritabanı kuralları). */
const rawInsert = (tx: Tx, workspaceSql = sql`app_current_workspace_id()`, name = "Ham Mülk") =>
  tx.execute(sql`
    insert into properties (id, workspace_id, created_by, name, property_type, max_guests, bedrooms,
                            bathrooms, province, district)
    values (${uuidv7()}, ${workspaceSql}, app_current_user_id(), ${name}, 'ev', 2, 1, 1,
            'Muğla', 'Fethiye')`);

const countIn = async (workspaceId: string) =>
  (
    await admin.query("select count(*)::int n from properties where workspace_id = $1", [
      workspaceId,
    ])
  ).rows[0].n as number;

const waitUntilBlocked = async (pid: number) => {
  for (let i = 0; i < 100; i++) {
    const r = await admin.query(
      "select 1 from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'",
      [pid],
    );
    if (r.rowCount) return;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("Beklenen kilit beklemesi oluşmadı");
};

let O: U, M: U, S: U, B: U;
let wsA: string, wsB: string;
let propA: string, propB: string;

beforeAll(async () => {
  await admin.connect();
  [O, M, S, B] = (await Promise.all(["oya", "mert", "selin", "baris"].map(mkUser))) as [U, U, U, U];
  wsA = await mkWorkspace(O, "a");
  wsB = await mkWorkspace(B, "b");
  await withTenant(app, { userId: O.id, workspaceId: wsA }, async (tx, ctx) => {
    await addWorkspaceMember(tx, ctx, { userId: M.id, role: "manager" });
    await addWorkspaceMember(tx, ctx, { userId: S.id, role: "staff" });
  });
  propA = await withTenant(app, { userId: O.id, workspaceId: wsA }, (tx, ctx) =>
    createProperty(tx, ctx, valid()),
  );
  propB = await withTenant(app, { userId: B.id, workspaceId: wsB }, (tx, ctx) =>
    createProperty(tx, ctx, valid({ name: "Burak Ev", propertyType: "ev" })),
  );
});

afterAll(async () => {
  await admin.end();
  await appPool.end();
});

describe("oluşturma", () => {
  it("owner mülk ekler: UUID v7, oluşturan ve işletme bağlamdan, denetim kaydı (değersiz)", async () => {
    const r = (
      await admin.query(
        `select id, workspace_id, created_by, status, map_embed_url, distance_beach_km::text,
                distance_market_km, country_code from properties where id = $1`,
        [propA],
      )
    ).rows[0];
    expect(r).toMatchObject({
      workspace_id: wsA,
      created_by: O.id,
      status: "active",
      map_embed_url: "https://www.google.com/maps?q=36.265100,29.414300&z=16&output=embed",
      // Revizyon 2 (0026): numeric(8,3) — 1 m çözünürlük.
      distance_beach_km: "1.500",
      distance_market_km: null,
      country_code: "TR",
    });
    expect(r.id).toMatch(UUID_V7);
    const a = await admin.query(
      "select action, actor_user_id, metadata from audit_log where target_id = $1",
      [propA],
    );
    expect(a.rows).toEqual([
      { action: "property.created", actor_user_id: O.id, metadata: { type: "villa" } },
    ]);
  });

  it("manager mülk ekleyebilir", async () => {
    const W = await mkUser("wasif");
    const ws = await mkWorkspace(W, "w");
    const Man = await mkUser("mana");
    await withTenant(app, { userId: W.id, workspaceId: ws }, (tx, ctx) =>
      addWorkspaceMember(tx, ctx, { userId: Man.id, role: "manager" }),
    );
    const id = await withTenant(app, { userId: Man.id, workspaceId: ws }, (tx, ctx) =>
      createProperty(tx, ctx, valid({ name: "Yönetici Mülkü", propertyType: "apart" })),
    );
    expect(
      (await admin.query("select created_by from properties where id = $1", [id])).rows[0],
    ).toEqual({ created_by: Man.id });
  });

  it("geçersiz form: alan hataları; il listede olmalı; harita ve mesafe doğrulanır", async () => {
    const C = await mkUser("cem");
    const ws = await mkWorkspace(C, "c");
    const fieldsOf = async (input: Record<string, unknown>) => {
      const err = await withTenant(app, { userId: C.id, workspaceId: ws }, (tx, ctx) =>
        createProperty(tx, ctx, input),
      ).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "VALIDATION" });
      return Object.keys((err as { fieldErrors: object }).fieldErrors).sort();
    };
    expect(
      await fieldsOf(
        valid({ name: "A", maxGuests: "0", province: "Atlantis", distanceBeachKm: "yakın" }),
      ),
    ).toEqual(["distanceBeachKm", "maxGuests", "name", "province"]);
    expect(await fieldsOf(valid({ mapLocation: "https://maps.app.goo.gl/x1" }))).toEqual([
      "mapLocation",
    ]);
    expect(await fieldsOf(valid({ mapLocation: "<script>alert(1)</script>" }))).toEqual([
      "mapLocation",
    ]);
    expect(await countIn(ws)).toBe(0);
  });
});

describe("rol yetkileri", () => {
  it("staff görüntüler ama ekleyemez, düzenleyemez, durum değiştiremez", async () => {
    await withTenant(app, { userId: S.id, workspaceId: wsA }, async (tx, ctx) => {
      expect((await listProperties(tx)).map((p) => p.id)).toEqual([propA]);
      expect((await getProperty(tx, propA))?.name).toBe("Deniz Villa");
      await expect(createProperty(tx, ctx, valid())).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(updateProperty(tx, ctx, propA, valid({ name: "X" }))).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(setPropertyStatus(tx, ctx, propA, "passive")).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });
  });

  it("staff uygulama denetimi atlansa bile veritabanında engellenir", async () => {
    expect(
      await pgMessage(withTenant(app, { userId: S.id, workspaceId: wsA }, (tx) => rawInsert(tx))),
    ).toMatch(/row-level security|property_limit_reached/);
    const upd = await withTenant(app, { userId: S.id, workspaceId: wsA }, (tx) =>
      tx.execute(sql`update properties set name = 'Ele geçirildi', status = 'passive'`),
    );
    expect(upd.rowCount).toBe(0);
    expect(
      (await admin.query("select name, status from properties where id = $1", [propA])).rows[0],
    ).toEqual({ name: "Deniz Villa", status: "active" });
  });

  it("owner dahil kimse silemez (yetki yok)", async () => {
    expect(
      await pgMessage(
        withTenant(app, { userId: O.id, workspaceId: wsA }, (tx) =>
          tx.execute(sql`delete from properties where id = ${propA}`),
        ),
      ),
    ).toMatch(/permission denied/);
  });

  it("korunan kolonlar değiştirilemez: id, workspace_id, created_by, created_at", async () => {
    for (const stmt of [
      sql`update properties set workspace_id = ${wsB} where id = ${propA}`,
      sql`update properties set created_by = ${S.id} where id = ${propA}`,
      sql`update properties set id = ${uuidv7()} where id = ${propA}`,
      sql`update properties set created_at = now() - interval '1 year' where id = ${propA}`,
    ]) {
      expect(
        await pgMessage(
          withTenant(app, { userId: O.id, workspaceId: wsA }, (tx) => tx.execute(stmt)),
        ),
      ).toMatch(/permission denied/);
    }
  });

  it("başkası adına (created_by) mülk eklenemez", async () => {
    const C = await mkUser("cansu");
    const ws = await mkWorkspace(C, "cansu");
    expect(
      await pgMessage(
        withTenant(app, { userId: C.id, workspaceId: ws }, (tx) =>
          tx.execute(sql`
            insert into properties (id, workspace_id, created_by, name, property_type, max_guests,
                                    bedrooms, bathrooms, province, district)
            values (${uuidv7()}, ${ws}, ${O.id}, 'Sahte', 'ev', 2, 1, 1, 'Muğla', 'Fethiye')`),
        ),
      ),
    ).toMatch(/row-level security/);
  });
});

describe("tenant izolasyonu", () => {
  it("her işletme yalnız kendi mülklerini görür", async () => {
    const a = await withTenant(app, { userId: O.id, workspaceId: wsA }, (tx) => listProperties(tx));
    const b = await withTenant(app, { userId: B.id, workspaceId: wsB }, (tx) => listProperties(tx));
    expect(a.map((p) => p.id)).toEqual([propA]);
    expect(b.map((p) => p.id)).toEqual([propB]);
  });

  it("başka işletmenin mülkü kimliğiyle okunamaz, düzenlenemez, durumu değiştirilemez", async () => {
    await withTenant(app, { userId: O.id, workspaceId: wsA }, async (tx, ctx) => {
      expect(await getProperty(tx, propB)).toBeNull();
      await expect(
        updateProperty(tx, ctx, propB, valid({ name: "Çalındı" })),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(setPropertyStatus(tx, ctx, propB, "passive")).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      const raw = await tx.execute(sql`update properties set name = 'Çalındı' where id = ${propB}`);
      expect(raw.rowCount).toBe(0);
    });
    expect(
      (await admin.query("select name from properties where id = $1", [propB])).rows[0],
    ).toEqual({ name: "Burak Ev" });
  });

  it("bağlam elle kurulsa bile üye olmayan hiçbir şey göremez ve ekleyemez", async () => {
    const n = await asRawContext(O.id, wsB, async (tx) => (await listProperties(tx)).length);
    expect(n).toBe(0);
    expect(await pgMessage(asRawContext(O.id, wsB, (tx) => rawInsert(tx)))).toMatch(
      /property_subscription_missing|row-level security/,
    );
    expect(await countIn(wsB)).toBe(1);
  });

  it("kendi bağlamında başka işletmeye mülk eklenemez", async () => {
    const C = await mkUser("ceren");
    const ws = await mkWorkspace(C, "ceren");
    expect(
      await pgMessage(
        withTenant(app, { userId: C.id, workspaceId: ws }, (tx) =>
          rawInsert(tx, sql`${wsB}::uuid`),
        ),
      ),
    ).toMatch(/property_subscription_missing|row-level security/);
    expect(await countIn(wsB)).toBe(1);
  });

  it("bağlam yokken hiçbir mülk görünmez", async () => {
    const n = await withUser(app, O.id, async (tx) =>
      Number((await tx.execute(sql`select count(*)::int n from properties`)).rows[0]?.n),
    );
    expect(n).toBe(0);
  });

  it("askıdaki işletmede okuma ve yazma kapalı", async () => {
    const Z = await mkUser("zeki");
    const ws = await mkWorkspace(Z, "zeki");
    await withTenant(app, { userId: Z.id, workspaceId: ws }, (tx, ctx) =>
      createProperty(tx, ctx, valid()),
    );
    await admin.query("update workspaces set status = 'suspended' where id = $1", [ws]);
    await asRawContext(Z.id, ws, async (tx) => {
      expect((await listProperties(tx)).length).toBe(0);
      expect((await tx.execute(sql`update properties set name = 'X'`)).rowCount).toBe(0);
    });
  });
});

describe("paket limiti ve abonelik", () => {
  it("kullanım: 1 / 1; limit doluyken ekleme uygulamada ve veritabanında reddedilir", async () => {
    await withTenant(app, { userId: O.id, workspaceId: wsA }, async (tx, ctx) => {
      expect(await getPropertyUsage(tx)).toEqual({
        allowed: false,
        reason: "limit_reached",
        used: 1,
        limit: 1,
        planName: "Başlangıç",
      });
      await expect(createProperty(tx, ctx, valid())).rejects.toMatchObject({
        code: "LIMIT_REACHED",
      });
    });
    expect(
      await pgMessage(withTenant(app, { userId: O.id, workspaceId: wsA }, (tx) => rawInsert(tx))),
    ).toMatch(/property_limit_reached/);
    expect(await countIn(wsA)).toBe(1);
  });

  it("pasif mülk de limite dahil", async () => {
    await withTenant(app, { userId: O.id, workspaceId: wsA }, (tx, ctx) =>
      setPropertyStatus(tx, ctx, propA, "passive"),
    );
    expect(
      await pgMessage(withTenant(app, { userId: O.id, workspaceId: wsA }, (tx) => rawInsert(tx))),
    ).toMatch(/property_limit_reached/);
    await withTenant(app, { userId: O.id, workspaceId: wsA }, (tx, ctx) =>
      setPropertyStatus(tx, ctx, propA, "active"),
    );
  });

  it("deneme bitince: yeni mülk yok; mevcut mülk görüntülenir, düzenlenir, durumu değişir", async () => {
    const E = await mkUser("emre");
    const ws = await mkWorkspace(E, "emre");
    const id = await withTenant(app, { userId: E.id, workspaceId: ws }, (tx, ctx) =>
      createProperty(tx, ctx, valid()),
    );
    // Limiti 0 sayılmasın diye mülkü pasife alıp yeni bir işletme senaryosunu da deneriz.
    await admin.query(
      "update workspace_subscriptions set trial_ends_at = now() - interval '1 minute' where workspace_id = $1",
      [ws],
    );
    await withTenant(app, { userId: E.id, workspaceId: ws }, async (tx, ctx) => {
      expect(await getPropertyUsage(tx)).toMatchObject({
        allowed: false,
        reason: "subscription_inactive",
      });
      expect((await getProperty(tx, id))?.name).toBe("Deniz Villa");
      expect(
        await updateProperty(tx, ctx, id, valid({ name: "Deniz Villa 2", bathrooms: "3" })),
      ).toEqual({ changed: 2 });
      expect(await setPropertyStatus(tx, ctx, id, "passive")).toEqual({ changed: true });
    });
    // Mülkü olmayan, süresi dolmuş işletme: limit altında olsa da veritabanı reddeder.
    const F = await mkUser("filiz");
    const ws2 = await mkWorkspace(F, "filiz");
    await admin.query(
      "update workspace_subscriptions set trial_ends_at = now() - interval '1 minute' where workspace_id = $1",
      [ws2],
    );
    await expect(
      withTenant(app, { userId: F.id, workspaceId: ws2 }, (tx, ctx) =>
        createProperty(tx, ctx, valid()),
      ),
    ).rejects.toMatchObject({ code: "LIMIT_REACHED" });
    expect(
      await pgMessage(withTenant(app, { userId: F.id, workspaceId: ws2 }, (tx) => rawInsert(tx))),
    ).toMatch(/property_subscription_inactive/);
    expect(await countIn(ws2)).toBe(0);
  });

  it("mülk eklemek aboneliği değiştirmez; abonelik tablosu app_user'a kapalı kalır", async () => {
    const before = (
      await admin.query(
        "select status, trial_ends_at, updated_at from workspace_subscriptions where workspace_id = $1",
        [wsA],
      )
    ).rows[0];
    expect(
      await pgMessage(
        withTenant(app, { userId: O.id, workspaceId: wsA }, (tx) =>
          tx.execute(
            sql`update workspace_subscriptions set trial_ends_at = now() + interval '1 year'`,
          ),
        ),
      ),
    ).toMatch(/permission denied/);
    const after = (
      await admin.query(
        "select status, trial_ends_at, updated_at from workspace_subscriptions where workspace_id = $1",
        [wsA],
      )
    ).rows[0];
    expect(after).toEqual(before);
  });

  // İki owner/manager aynı anda son boş hakkı kullanmaya çalışır; hiçbir seviyede limit aşılmaz.
  for (const iso of ["read committed", "repeatable read", "serializable"] as const) {
    it(`eşzamanlı ekleme — ${iso}: en fazla 1 mülk`, async () => {
      const key = iso.split(" ")[0]!;
      const [u1, u2] = await Promise.all([mkUser(`es1${key}`), mkUser(`es2${key}`)]);
      const ws = await mkWorkspace(u1, `es-${key}`);
      await withTenant(app, { userId: u1.id, workspaceId: ws }, (tx, ctx) =>
        addWorkspaceMember(tx, ctx, { userId: u2.id, role: "manager" }),
      );
      const c1 = new Client({ connectionString: db.appUrl });
      const c2 = new Client({ connectionString: db.appUrl });
      await Promise.all([c1.connect(), c2.connect()]);
      const ins = (c: Client) =>
        c.query(
          `insert into properties (id, workspace_id, created_by, name, property_type, max_guests,
                                   bedrooms, bathrooms, province, district)
           values ($1, app_current_workspace_id(), app_current_user_id(), 'Yarış', 'ev', 2, 1, 1,
                   'Muğla', 'Fethiye')`,
          [uuidv7()],
        );
      const outcome = (p: Promise<unknown>) =>
        p.then(
          () => "ok",
          (e: { code?: string; message?: string }) => e.message ?? e.code ?? "error",
        );
      try {
        for (const [c, u] of [
          [c1, u1],
          [c2, u2],
        ] as const) {
          await c.query(`begin isolation level ${iso}`);
          await c.query(
            "select set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)",
            [u.id, ws],
          );
          await c.query("select count(*) from properties"); // snapshot burada alınır
        }
        const pid2 = (await c2.query("select pg_backend_pid() as pid")).rows[0].pid as number;
        const r1 = await outcome(ins(c1));
        const p2 = outcome(ins(c2));
        if (r1 === "ok") await waitUntilBlocked(pid2);
        const commit1 = await outcome(c1.query(r1 === "ok" ? "commit" : "rollback"));
        const r2 = await p2;
        const commit2 = await outcome(c2.query(r2 === "ok" ? "commit" : "rollback"));
        const n = await countIn(ws);
        expect(n).toBeLessThanOrEqual(1);
        if (iso === "repeatable read") {
          expect({ r1, r2, n }).toEqual({
            r1: "property_limit_isolation",
            r2: "property_limit_isolation",
            n: 0,
          });
        } else {
          expect({ r1, commit1, n }).toEqual({ r1: "ok", commit1: "ok", n: 1 });
          const second = r2 === "ok" ? commit2 : r2;
          expect(second).toMatch(
            iso === "read committed" ? /property_limit_reached/ : /could not serialize/,
          );
        }
      } finally {
        await Promise.all([c1.end(), c2.end()]);
      }
    });
  }
});

describe("düzenleme ve durum", () => {
  it("yalnız değişen alan adları denetim kaydına yazılır; değişiklik yoksa kayıt yok", async () => {
    await withTenant(app, { userId: M.id, workspaceId: wsA }, async (tx, ctx) => {
      expect(
        await updateProperty(
          tx,
          ctx,
          propA,
          valid({
            maxGuests: "8",
            mapLocation: "https://www.google.com/maps?q=36.3,29.5",
            distanceMarketKm: "0,3",
          }),
        ),
      ).toEqual({ changed: 3 });
      expect(
        await updateProperty(
          tx,
          ctx,
          propA,
          valid({
            maxGuests: "8",
            mapLocation: "https://www.google.com/maps?q=36.300000,29.500000&z=16&output=embed",
            distanceMarketKm: "0.30",
          }),
        ),
      ).toEqual({ changed: 0 });
    });
    const a = await admin.query(
      "select metadata from audit_log where target_id = $1 and action = 'property.updated'",
      [propA],
    );
    expect(a.rows).toEqual([{ metadata: { fields: ["max_guests", "map", "distances"] } }]);
    // Değerler (harita adresi, mesafe) denetim kaydında yok.
    expect(JSON.stringify(a.rows)).not.toMatch(/google|36\.3|0\.3/);
  });

  it("durum değişikliği denetlenir; aynı duruma geçiş kayıt üretmez", async () => {
    const C = await mkUser("ceyda");
    const ws = await mkWorkspace(C, "ceyda");
    const id = await withTenant(app, { userId: C.id, workspaceId: ws }, (tx, ctx) =>
      createProperty(tx, ctx, valid()),
    );
    await withTenant(app, { userId: C.id, workspaceId: ws }, async (tx, ctx) => {
      expect(await setPropertyStatus(tx, ctx, id, "passive")).toEqual({ changed: true });
      expect(await setPropertyStatus(tx, ctx, id, "passive")).toEqual({ changed: false });
      await expect(setPropertyStatus(tx, ctx, id, "silindi")).rejects.toMatchObject({
        code: "VALIDATION",
      });
    });
    const a = await admin.query(
      "select metadata from audit_log where target_id = $1 and action = 'property.status_changed'",
      [id],
    );
    expect(a.rows).toEqual([{ metadata: { from: "active", to: "passive" } }]);
  });

  it("harita adresi ve mesafeler veritabanı kısıtıyla da korunur", async () => {
    const upd = (q: ReturnType<typeof sql>) =>
      pgMessage(withTenant(app, { userId: O.id, workspaceId: wsA }, (tx) => tx.execute(q)));
    for (const bad of [
      "https://evil.example/maps/embed?pb=!1m2",
      "https://www.google.com/maps/embed?pb=!1m2&x=<script>",
      "javascript:alert(1)",
    ]) {
      expect(
        await upd(sql`update properties set map_embed_url = ${bad} where id = ${propA}`),
        bad,
      ).toMatch(/properties_map_embed_url/);
    }
    expect(await upd(sql`update properties set distance_beach_km = 0 where id = ${propA}`)).toMatch(
      /properties_distances/,
    );
    expect(
      await upd(
        sql`update properties set house_rule_keys = '{"Kötü Anahtar"}' where id = ${propA}`,
      ),
    ).toMatch(/properties_house_rule_keys/);
  });

  it("kullanıcı silinince mülk kalır, oluşturan NULL olur", async () => {
    const T = await mkUser("tunc");
    const ws = await mkWorkspace(T, "tunc");
    const K = await mkUser("kaan");
    await withTenant(app, { userId: T.id, workspaceId: ws }, (tx, ctx) =>
      addWorkspaceMember(tx, ctx, { userId: K.id, role: "manager" }),
    );
    const id = await withTenant(app, { userId: K.id, workspaceId: ws }, (tx, ctx) =>
      createProperty(tx, ctx, valid()),
    );
    await admin.query("delete from users where id = $1", [K.id]);
    expect(
      (await admin.query("select created_by from properties where id = $1", [id])).rows[0],
    ).toEqual({ created_by: null });
  });
});

describe("yetkiler, politikalar, fonksiyon", () => {
  it("RLS ENABLE + FORCE; politikalar beklenen roller ve komutlarla; DELETE politikası yok", async () => {
    const f = await admin.query(
      "select relrowsecurity r, relforcerowsecurity f from pg_class where relname = 'properties'",
    );
    expect(f.rows[0]).toEqual({ r: true, f: true });
    const p = await admin.query(
      "select policyname, cmd, roles::text[] as roles from pg_policies where tablename = 'properties' order by 1",
    );
    expect(p.rows.map((x) => [x.policyname, x.cmd, x.roles])).toEqual([
      // 0052: acente API'si fonksiyonları için app_migrator'a dar SELECT (app.api_fn).
      ["properties_api_fn", "SELECT", ["app_migrator"]],
      // 0029 (3.1): iCal dışa aktarma fonksiyonu için app_migrator'a dar SELECT (app.ical_export).
      ["properties_ical_export_read", "SELECT", ["app_migrator"]],
      ["properties_insert", "INSERT", ["app_user"]],
      // 0024: public villa okuma fonksiyonları için app_migrator'a dar SELECT (yalnız app.public_read açıkken).
      ["properties_public_read", "SELECT", ["app_migrator"]],
      ["properties_select", "SELECT", ["app_user"]],
      ["properties_update", "UPDATE", ["app_user"]],
      // 0036 (A2): WhatsApp takvim önerisi worker'ı için app_migrator'a dar SELECT (app.wa_calendar).
      ["properties_wa_calendar_read", "SELECT", ["app_migrator"]],
    ]);
  });

  it("tablo ve kolon yetkileri: yalnız app_user; DELETE yok; korunan kolonlar güncellenemez", async () => {
    const t = await admin.query(`
      select case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as rol, a.privilege_type
        from pg_class c, aclexplode(c.relacl) a
       where c.relname = 'properties' and a.grantee <> c.relowner order by 1, 2`);
    expect(t.rows).toEqual([{ rol: "app_user", privilege_type: "SELECT" }]);
    const cols = await admin.query(`
      select a.attname, x.privilege_type, x.grantee::regrole::text as rol
        from pg_attribute a, aclexplode(a.attacl) x
       where a.attrelid = 'properties'::regclass and a.attacl is not null
       order by 2, 1`);
    const byPriv = (p: string) =>
      cols.rows.filter((r) => r.privilege_type === p).map((r) => r.attname as string);
    expect(new Set(cols.rows.map((r) => r.rol))).toEqual(new Set(["app_user"]));
    expect(byPriv("INSERT")).not.toContain("created_at");
    expect(byPriv("INSERT")).toEqual(
      expect.arrayContaining(["id", "workspace_id", "created_by", "name", "status"]),
    );
    for (const c of ["id", "workspace_id", "created_by", "created_at", "updated_at"]) {
      expect(byPriv("UPDATE")).not.toContain(c);
    }
    expect(byPriv("UPDATE")).toEqual(
      expect.arrayContaining([
        "name",
        "status",
        "map_embed_url",
        "distance_beach_km",
        "house_rule_keys",
        "price_includes",
      ]),
    );
    expect(byPriv("INSERT")).toEqual(
      expect.arrayContaining(["map_embed_url", "distance_airport_dlm_km"]),
    );
    // Olanaklar gibi: kurallar ve dahil olanlar yeni mülkte yazılmaz (varsayılan boş).
    expect(byPriv("INSERT")).not.toContain("house_rule_keys");
  });

  it("limit tetikleyicisi: SECURITY INVOKER, sabit search_path, EXECUTE kimsede yok", async () => {
    const r = await admin.query(`
      select prosecdef, pg_get_userbyid(proowner) owner, proconfig, proacl
        from pg_proc where proname = 'app_properties_enforce_limit'`);
    expect(r.rows[0]).toMatchObject({
      prosecdef: false,
      owner: "app_migrator",
      proconfig: ["search_path=pg_catalog, pg_temp"],
    });
    // Yalnız sahibinin (app_migrator) varsayılan EXECUTE'u; app_user ve PUBLIC'e verilmemiş.
    expect(String(r.rows[0].proacl)).toBe("{app_migrator=X/app_migrator}");
    const t = await admin.query(`
      select pg_get_triggerdef(oid) def from pg_trigger
       where tgrelid = 'properties'::regclass and tgname = 'properties_enforce_limit'`);
    expect(t.rows[0].def).toMatch(/BEFORE INSERT ON public\.properties FOR EACH ROW/);
  });
});

describe("ek alanlar: belge no, biçimlendirilmiş açıklama, YouTube, havuzlar (0013, 0014)", () => {
  let X: U, wsX: string;
  beforeAll(async () => {
    X = await mkUser("detay");
    wsX = await mkWorkspace(X, "detay");
  });
  const asX = <T>(
    fn: (tx: Tx, ctx: Parameters<Parameters<typeof withTenant>[2]>[1]) => Promise<T>,
  ) => withTenant(app, { userId: X.id, workspaceId: wsX }, fn);
  const full = {
    tourismLicenseNo: " 07-2024/1234 ",
    description:
      '<p><b>Havuzlu</b> villa <i>denize</i> <u>yakın</u>. <a href="https://ornek.com" onclick="x()">Site</a><script>alert(1)</script></p>',
    youtubeUrl: "https://youtu.be/dQw4w9WgXcQ",
    poolSwimming: "yes",
    poolSwimmingDepth: "1,50",
    poolSwimmingWidth: "4",
    poolSwimmingLength: "8,25",
    poolSwimmingProtected: "yes",
    poolIndoor: "no",
    poolIndoorDepth: "3",
    poolKids: "yes",
    poolKidsDepth: "0,40",
    poolKidsWidth: "2",
    poolKidsLength: "3",
  };
  let id: string;

  it("oluşturma: yeni alanlar temizlenmiş/normalleştirilmiş olarak kaydedilir ve geri okunur", async () => {
    id = await asX((tx, ctx) => createProperty(tx, ctx, valid(full)));
    const r = (
      await admin.query(
        `select description, description_html, tourism_license_no, youtube_video_ids,
                pool_swimming, pool_swimming_depth, pool_swimming_width, pool_swimming_length,
                pool_swimming_protected, pool_indoor, pool_indoor_depth, pool_kids,
                pool_kids_depth, pool_kids_width, pool_kids_length
           from properties where id = $1`,
        [id],
      )
    ).rows[0];
    expect(r).toEqual({
      description: "Havuzlu villa denize yakın. Site",
      description_html:
        '<p><strong>Havuzlu</strong> villa <em>denize</em> <u>yakın</u>. <a href="https://ornek.com/" target="_blank" rel="noopener noreferrer nofollow">Site</a></p>',
      tourism_license_no: "07-2024/1234",
      youtube_video_ids: ["dQw4w9WgXcQ"],
      pool_swimming: true,
      pool_swimming_depth: "1.50",
      pool_swimming_width: "4.00",
      pool_swimming_length: "8.25",
      pool_swimming_protected: true,
      pool_indoor: false,
      pool_indoor_depth: null,
      pool_kids: true,
      pool_kids_depth: "0.40",
      pool_kids_width: "2.00",
      pool_kids_length: "3.00",
    });
    const p = await asX((tx) => getProperty(tx, id));
    expect(p).toMatchObject({
      tourismLicenseNo: "07-2024/1234",
      youtubeVideoIds: ["dQw4w9WgXcQ"],
      pools: {
        swimming: { present: true, depth: 1.5, width: 4, length: 8.25 },
        indoor: { present: false, depth: null, width: null, length: null },
        kids: { present: true, depth: 0.4, width: 2, length: 3 },
        swimmingProtected: true,
      },
    });
    expect(p?.descriptionHtml).toBe(r.description_html);
  });

  it("düzenleme: alanlar güncellenir / temizlenir; denetim kaydında yalnız alan adları", async () => {
    const res = await asX((tx, ctx) =>
      updateProperty(
        tx,
        ctx,
        id,
        valid({
          ...full,
          tourismLicenseNo: "",
          youtubeUrl: "https://www.youtube.com/watch?v=a_b-C1d2E3f",
          poolSwimming: "no",
          poolKids: "yes",
        }),
      ),
    );
    expect(res).toEqual({ changed: 3 });
    const p = await asX((tx) => getProperty(tx, id));
    expect(p).toMatchObject({
      tourismLicenseNo: null,
      youtubeVideoIds: ["a_b-C1d2E3f"],
      pools: {
        swimming: { present: false, depth: null, width: null, length: null },
        swimmingProtected: false,
      },
    });
    const audit = (
      await admin.query(
        "select metadata from audit_log where target_id = $1 and action = 'property.updated' order by occurred_at desc limit 1",
        [id],
      )
    ).rows[0].metadata;
    expect(audit).toEqual({ fields: ["tourism_license_no", "youtube_videos", "pools"] });
    expect(JSON.stringify(audit)).not.toMatch(/07-2024|a_b-C1d2E3f|1\.5/);
    // Değişiklik yoksa güncelleme yok.
    const same = await asX((tx, ctx) =>
      updateProperty(
        tx,
        ctx,
        id,
        valid({
          ...full,
          tourismLicenseNo: "",
          youtubeUrl: "https://youtu.be/a_b-C1d2E3f",
          poolSwimming: "no",
        }),
      ),
    );
    expect(same).toEqual({ changed: 0 });
  });

  it("geçersiz değerler: uygulama alan hatası verir, kayıt değişmez", async () => {
    await expect(
      asX((tx, ctx) =>
        updateProperty(
          tx,
          ctx,
          id,
          valid({ youtubeUrl: "https://vimeo.com/1", poolIndoor: "yes" }),
        ),
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      fieldErrors: {
        youtubeUrl: ["Geçerli bir YouTube video bağlantısı girin."],
        poolIndoorDepth: ["Derinlik gerekli."],
        poolIndoorWidth: ["Genişlik gerekli."],
        poolIndoorLength: ["Uzunluk gerekli."],
      },
    });
  });

  it("eski kayıtlar: düz metin açıklama korunur, düzenleyiciye kaçışlı HTML olarak gelir", async () => {
    const legacyId = uuidv7();
    const Y = await mkUser("eski");
    const wsY = await mkWorkspace(Y, "eski");
    await admin.query(
      `insert into properties (id, workspace_id, created_by, name, property_type, description,
                               max_guests, bedrooms, bathrooms, province, district)
       values ($1, $2, $3, 'Eski', 'ev', $4, 2, 1, 1, 'Muğla', 'Fethiye')`,
      [legacyId, wsY, Y.id, "Bahçeli <ev> & şömine\nİkinci satır"],
    );
    const p = await withTenant(app, { userId: Y.id, workspaceId: wsY }, (tx) =>
      getProperty(tx, legacyId),
    );
    expect(p).toMatchObject({
      description: "Bahçeli <ev> & şömine\nİkinci satır",
      descriptionHtml: "<p>Bahçeli &lt;ev&gt; &amp; şömine<br />İkinci satır</p>",
      tourismLicenseNo: null,
      youtubeVideoIds: [],
      pools: { swimming: { present: false }, swimmingProtected: false },
    });
    const raw = (
      await admin.query("select description, description_html from properties where id = $1", [
        legacyId,
      ])
    ).rows[0];
    expect(raw).toEqual({
      description: "Bahçeli <ev> & şömine\nİkinci satır",
      description_html: null,
    });
  });

  it("veritabanı kısıtları (son savunma hattı)", async () => {
    const bad = (set: string) =>
      pgMessage(
        asX((tx) => tx.execute(sql.raw(`update properties set ${set} where id = '${id}'`))),
      );
    expect(await bad("pool_indoor = true")).toMatch(/properties_pool_indoor/);
    expect(await bad("pool_indoor = true, pool_indoor_depth = 1, pool_indoor_width = 2")).toMatch(
      /properties_pool_indoor/,
    );
    expect(
      await bad(
        "pool_indoor = true, pool_indoor_depth = 11, pool_indoor_width = 2, pool_indoor_length = 3",
      ),
    ).toMatch(/properties_pool_indoor/);
    expect(await bad("pool_kids = false")).toMatch(/properties_pool_kids/);
    expect(await bad("pool_swimming_protected = true")).toMatch(
      /properties_pool_swimming_protected/,
    );
    expect(await bad("youtube_video_ids = array['kisa']")).toMatch(/properties_youtube_video_ids/);
    expect(await bad("youtube_video_ids = array['dQw4w9WgXcQ', null]")).toMatch(
      /properties_youtube_video_ids/,
    );
    expect(await bad(`youtube_video_ids = array_fill('dQw4w9WgXcQ'::text, array[11])`)).toMatch(
      /properties_youtube_video_ids/,
    );
    expect(await bad("tourism_license_no = '<b>1</b>'")).toMatch(
      /properties_tourism_license_format/,
    );
    expect(await bad("tourism_license_no = ''")).toMatch(/properties_tourism_license_format/);
    expect(await bad(`description_html = repeat('a', 20001)`)).toMatch(
      /properties_description_html_length/,
    );
  });

  it("yetkiler: yeni kolonlar app_user için eklenebilir/güncellenebilir; staff ve başka işletme yazamaz", async () => {
    const cols = await admin.query(`
      select a.attname, x.privilege_type from pg_attribute a, aclexplode(a.attacl) x
       where a.attrelid = 'properties'::regclass and x.grantee = 'app_user'::regrole
         and a.attname in ('description_html', 'tourism_license_no', 'youtube_video_ids',
                           'pool_swimming', 'pool_kids_length', 'pool_swimming_protected')
       order by 1, 2`);
    expect(cols.rows).toHaveLength(12);
    // staff (wsA) düzenleyemez — uygulama ve RLS
    await expect(
      withTenant(app, { userId: S.id, workspaceId: wsA }, (tx, ctx) =>
        updateProperty(tx, ctx, propA, valid({ tourismLicenseNo: "1" })),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const upd = await withTenant(app, { userId: S.id, workspaceId: wsA }, (tx) =>
      tx.execute(sql`update properties set tourism_license_no = 'X1' where id = ${propA}`),
    );
    expect(upd.rowCount).toBe(0);
    // Başka işletmenin mülkü görünmez/güncellenmez.
    const other = await asX((tx) =>
      tx.execute(sql`update properties set tourism_license_no = 'X1' where id = ${propB}`),
    );
    expect(other.rowCount).toBe(0);
  });
});
