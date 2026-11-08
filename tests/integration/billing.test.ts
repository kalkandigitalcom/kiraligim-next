import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { DB_CASING } from "@/db/casing";
import { runMigrations } from "@/db/migrate";
import { pgErrorInfo } from "@/db/pg-error";
import * as schema from "@/db/schema";
import { type Tx, withTenant, withUser } from "@/db/tenant";
import { evaluatePropertyAllowance, getEntitlements } from "@/server/billing/entitlements";
import { addWorkspaceMember, createWorkspace } from "@/server/workspaces/service";

import { runBootstrap } from "./psql";

/**
 * Aşama 2.4a: paketler ve abonelikler (0007, 0008) — gerçek PostgreSQL, yalnız app_user ile
 * uygulama işlemleri; yönetici bağlantısı yalnız kurulum ve doğrulama için.
 */
const db = inject("testDb");
const migrationsFolder = path.resolve(__dirname, "../../drizzle");
const appPool = new Pool({ connectionString: db.appUrl, max: 4 });
const app = drizzle(appPool, { schema, casing: DB_CASING });
const admin = new Client({ connectionString: db.adminUrl });

const tag = randomBytes(3).toString("hex");
const slugOf = (s: string) => `${s}-${tag}`;
const DEFAULT_PLAN_ID = "01971a00-0000-7000-8000-000000000001";
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

/** withTenant'ı atlayarak bağlamı elle kurar (uygulama hatası / doğrudan SQL senaryosu). */
const asRawContext = <T>(userId: string, workspaceId: string, fn: (tx: Tx) => Promise<T>) =>
  withUser(app, userId, async (tx) => {
    await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
    return fn(tx);
  });

const subsOf = async (workspaceId: string) =>
  (
    await admin.query(
      "select id, plan_id, status, trial_ends_at, current_period_end, created_at from workspace_subscriptions where workspace_id = $1",
      [workspaceId],
    )
  ).rows;

let A: U, B: U, S: U;
let wsA: string, wsB: string;

beforeAll(async () => {
  await admin.connect();
  [A, B, S] = (await Promise.all(["ayse", "burak", "selin"].map(mkUser))) as [U, U, U];
  wsA = (await createWorkspace(app, { userId: A.id, name: "Ayşe Evleri", slug: slugOf("a") })).id;
  wsB = (await createWorkspace(app, { userId: B.id, name: "Burak Evleri", slug: slugOf("b") })).id;
  await withTenant(app, { userId: A.id, workspaceId: wsA }, (tx, ctx) =>
    addWorkspaceMember(tx, ctx, { userId: S.id, role: "staff" }),
  );
});

afterAll(async () => {
  await admin.end();
  await appPool.end();
});

describe("paket kataloğu", () => {
  it("Başlangıç paketi: 1 mülk, 14 gün deneme, aktif ve tek varsayılan", async () => {
    const r = await admin.query(
      "select id, code, name, max_properties, trial_days, is_active, is_default from plans order by code",
    );
    expect(r.rows).toEqual([
      {
        id: DEFAULT_PLAN_ID,
        code: "baslangic",
        name: "Başlangıç",
        max_properties: 1,
        trial_days: 14,
        is_active: true,
        is_default: true,
      },
    ]);
  });

  it("ikinci bir varsayılan paket tanımlanamaz; pasif paket varsayılan olamaz", async () => {
    await expect(
      admin.query(
        "insert into plans (id, code, name, max_properties, trial_days, is_default) values ($1, 'ikinci', 'İkinci', 3, 14, true)",
        [uuidv7()],
      ),
    ).rejects.toThrow(/plans_single_default_idx/);
    await expect(
      admin.query(
        "insert into plans (id, code, name, max_properties, trial_days, is_active, is_default) values ($1, 'pasif', 'Pasif', 3, 14, false, true)",
        [uuidv7()],
      ),
    ).rejects.toThrow(/plans_default_is_active/);
  });

  it("app_user paketleri okuyabilir ama değiştiremez", async () => {
    const r = await appPool.query("select code from plans");
    expect(r.rows.map((x) => x.code)).toContain("baslangic");
    for (const stmt of [
      "update plans set max_properties = 999",
      "delete from plans",
      `insert into plans (id, code, name, max_properties, trial_days) values ('${uuidv7()}', 'sahte', 'Sahte', 99, 90)`,
    ]) {
      await expect(appPool.query(stmt), stmt).rejects.toThrow(/permission denied/);
    }
  });
});

describe("otomatik deneme aboneliği", () => {
  it("işletme oluşturulunca aynı transaction'da 14 günlük deneme aboneliği açılır", async () => {
    const subs = await subsOf(wsA);
    expect(subs).toHaveLength(1);
    const s = subs[0];
    expect(s.id).toMatch(UUID_V7);
    expect(s.plan_id).toBe(DEFAULT_PLAN_ID);
    expect(s.status).toBe("trialing");
    expect(s.current_period_end).toBeNull();
    // Deneme bitişi = oluşturma anı + 14 gün (aynı transaction'daki now()).
    const ws = (await admin.query("select created_at from workspaces where id = $1", [wsA]))
      .rows[0];
    expect(new Date(s.trial_ends_at).getTime() - new Date(ws.created_at).getTime()).toBe(
      14 * 24 * 60 * 60 * 1000,
    );
  });

  it("varsayılan paket yoksa işletme, owner üyeliği ve denetim kaydı da oluşmaz", async () => {
    const C = await mkUser("cem");
    const slug = slugOf("paketsiz");
    await admin.query("update plans set is_default = false where id = $1", [DEFAULT_PLAN_ID]);
    try {
      expect(
        await pgMessage(createWorkspace(app, { userId: C.id, name: "Paketsiz Ev", slug })),
      ).toMatch(/default_plan_missing/);
    } finally {
      await admin.query("update plans set is_default = true where id = $1", [DEFAULT_PLAN_ID]);
    }
    const left = await admin.query(
      `select (select count(*)::int from workspaces where slug = $1) as w,
              (select count(*)::int from workspace_members where user_id = $2) as m,
              (select count(*)::int from audit_log where actor_user_id = $2) as a`,
      [slug, C.id],
    );
    expect(left.rows[0]).toEqual({ w: 0, m: 0, a: 0 });
  });

  it("abonelik yazılamazsa işletme de geri alınır (tek transaction)", async () => {
    const C = await mkUser("can");
    const slug = slugOf("geri-al");
    const fn = `fail_sub_${tag}`;
    await admin.query(
      `create function ${fn}() returns trigger language plpgsql as $$ begin raise exception 'test_hatasi'; end $$`,
    );
    await admin.query(
      `create trigger ${fn} before insert on workspace_subscriptions for each row execute function ${fn}()`,
    );
    try {
      expect(
        await pgMessage(createWorkspace(app, { userId: C.id, name: "Geri Alınan", slug })),
      ).toMatch(/test_hatasi/);
    } finally {
      await admin.query(`drop trigger ${fn} on workspace_subscriptions; drop function ${fn}()`);
    }
    expect((await admin.query("select 1 from workspaces where slug = $1", [slug])).rowCount).toBe(
      0,
    );
  });

  it("bir işletmenin ikinci aboneliği olamaz", async () => {
    await expect(
      admin.query(
        "insert into workspace_subscriptions (id, workspace_id, plan_id, status, trial_ends_at) values ($1, $2, $3, 'trialing', now())",
        [uuidv7(), wsA, DEFAULT_PLAN_ID],
      ),
    ).rejects.toThrow(/workspace_subscriptions_workspace_id_key/);
  });

  it("deneme durumunda bitiş tarihi zorunlu", async () => {
    const W = await mkUser("veli");
    const ws = (await createWorkspace(app, { userId: W.id, name: "Veli Ev", slug: slugOf("v") }))
      .id;
    await expect(
      admin.query(
        "update workspace_subscriptions set trial_ends_at = null where workspace_id = $1",
        [ws],
      ),
    ).rejects.toThrow(/workspace_subscriptions_trial_end_required/);
  });
});

describe("abonelik izolasyonu (RLS)", () => {
  it("üye yalnız kendi işletmesinin aboneliğini görür; staff dahil", async () => {
    for (const [user, ws] of [
      [A, wsA],
      [S, wsA],
      [B, wsB],
    ] as const) {
      const rows = await withTenant(
        app,
        { userId: user.id, workspaceId: ws },
        async (tx) =>
          (
            await tx.execute<{ workspace_id: string }>(
              sql`select workspace_id from workspace_subscriptions`,
            )
          ).rows,
      );
      expect(rows).toEqual([{ workspace_id: ws }]);
    }
  });

  it("bağlam yokken veya üye olmayan kullanıcı bağlamı elle kursa bile hiçbir satır görünmez", async () => {
    const none = await withUser(
      app,
      A.id,
      async (tx) => (await tx.execute(sql`select 1 from workspace_subscriptions`)).rowCount,
    );
    expect(none).toBe(0);
    const foreign = await asRawContext(
      A.id,
      wsB,
      async (tx) => (await tx.execute(sql`select 1 from workspace_subscriptions`)).rowCount,
    );
    expect(foreign).toBe(0);
  });

  it("askıdaki işletmenin aboneliği görünmez", async () => {
    const Z = await mkUser("zeynep");
    const ws = (await createWorkspace(app, { userId: Z.id, name: "Askı Ev", slug: slugOf("z") }))
      .id;
    await admin.query("update workspaces set status = 'suspended' where id = $1", [ws]);
    const n = await asRawContext(
      Z.id,
      ws,
      async (tx) => (await tx.execute(sql`select 1 from workspace_subscriptions`)).rowCount,
    );
    expect(n).toBe(0);
  });

  it("owner dahil app_user abonelik ekleyemez, değiştiremez, silemez", async () => {
    for (const stmt of [
      sql`update workspace_subscriptions set status = 'active', current_period_end = null`,
      sql`update workspace_subscriptions set trial_ends_at = now() + interval '10 years'`,
      sql`delete from workspace_subscriptions`,
      sql`insert into workspace_subscriptions (id, workspace_id, plan_id, status, current_period_end) values (${uuidv7()}, ${wsA}, ${DEFAULT_PLAN_ID}, 'active', null)`,
    ]) {
      expect(
        await pgMessage(
          withTenant(app, { userId: A.id, workspaceId: wsA }, (tx) => tx.execute(stmt)),
        ),
      ).toMatch(/permission denied/);
    }
    expect((await subsOf(wsA))[0].status).toBe("trialing");
  });

  it("app_migrator yalnız 'trialing' ekleyebilir; abonelikleri okuyamaz", async () => {
    const mig = new Client({ connectionString: db.migratorUrl });
    await mig.connect();
    try {
      expect((await mig.query("select 1 from workspace_subscriptions")).rowCount).toBe(0);
      await expect(
        mig.query(
          "insert into workspace_subscriptions (id, workspace_id, plan_id, status) values ($1, $2, $3, 'active')",
          [uuidv7(), wsB, DEFAULT_PLAN_ID],
        ),
      ).rejects.toThrow(/row-level security/);
    } finally {
      await mig.end();
    }
  });
});

describe("geçerlilik ve yetkinlikler", () => {
  it("app_subscription_is_current kuralları", async () => {
    const r = await appPool.query(`
      select
        app_subscription_is_current('trialing', now() + interval '1 day', null) as deneme_suruyor,
        app_subscription_is_current('trialing', now() - interval '1 second', null) as deneme_bitti,
        app_subscription_is_current('trialing', null, null) as deneme_tarihsiz,
        app_subscription_is_current('active', null, null) as aktif_suresiz,
        app_subscription_is_current('active', null, now() + interval '1 day') as aktif_donem,
        app_subscription_is_current('active', null, now() - interval '1 day') as aktif_bitmis,
        app_subscription_is_current('expired', now() + interval '1 day', null) as expired,
        app_subscription_is_current('canceled', null, now() + interval '1 day') as canceled`);
    expect(r.rows[0]).toEqual({
      deneme_suruyor: true,
      deneme_bitti: false,
      deneme_tarihsiz: false,
      aktif_suresiz: true,
      aktif_donem: true,
      aktif_bitmis: false,
      expired: false,
      canceled: false,
    });
  });

  it("deneme sürerken: Başlangıç, 14 gün kaldı, 1 mülk eklenebilir", async () => {
    const ent = await withTenant(app, { userId: A.id, workspaceId: wsA }, (tx) =>
      getEntitlements(tx),
    );
    expect(ent).toMatchObject({
      planCode: "baslangic",
      planName: "Başlangıç",
      maxProperties: 1,
      status: "trialing",
      effectiveStatus: "trialing",
      isCurrent: true,
      trialDaysLeft: 14,
    });
    expect(evaluatePropertyAllowance(ent, 0)).toEqual({ allowed: true, used: 0, limit: 1 });
    expect(evaluatePropertyAllowance(ent, 1)).toMatchObject({
      allowed: false,
      reason: "limit_reached",
    });
  });

  it("deneme bitince: süresi doldu görünür, yeni mülk eklenemez", async () => {
    const E = await mkUser("emre");
    const ws = (await createWorkspace(app, { userId: E.id, name: "Emre Ev", slug: slugOf("e") }))
      .id;
    await admin.query(
      "update workspace_subscriptions set trial_ends_at = now() - interval '1 minute' where workspace_id = $1",
      [ws],
    );
    const ent = await withTenant(app, { userId: E.id, workspaceId: ws }, (tx) =>
      getEntitlements(tx),
    );
    expect(ent).toMatchObject({
      status: "trialing",
      effectiveStatus: "expired",
      isCurrent: false,
      trialDaysLeft: null,
    });
    expect(evaluatePropertyAllowance(ent, 0)).toMatchObject({
      allowed: false,
      reason: "subscription_inactive",
    });
  });

  it("başka işletmenin bağlamı elle kurulsa da yetkinlik okunamaz", async () => {
    const ent = await asRawContext(A.id, wsB, (tx) => getEntitlements(tx));
    expect(ent).toBeNull();
    expect(evaluatePropertyAllowance(ent, 0)).toMatchObject({
      allowed: false,
      reason: "no_subscription",
    });
  });
});

describe("yetkiler ve politikalar", () => {
  it("tablo yetkileri: app_user yalnız SELECT; PUBLIC, app_admin, app_worker hiçbir şey", async () => {
    const r = await admin.query(`
      select c.relname, case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as rol,
             a.privilege_type
        from pg_class c, aclexplode(c.relacl) a
       where c.relname in ('plans', 'workspace_subscriptions') and a.grantee <> c.relowner
       order by 1, 2, 3`);
    expect(r.rows).toEqual([
      { relname: "plans", rol: "app_user", privilege_type: "SELECT" },
      { relname: "workspace_subscriptions", rol: "app_user", privilege_type: "SELECT" },
    ]);
    const cols = await admin.query(`
      select count(*)::int n from pg_attribute
       where attrelid in ('plans'::regclass, 'workspace_subscriptions'::regclass) and attacl is not null`);
    expect(cols.rows[0].n).toBe(0);
  });

  it("abonelik politikaları beklenen roller ve komutlarla; plans'ta RLS bilinçli olarak yok", async () => {
    const p = await admin.query(`
      select tablename, policyname, cmd, roles::text[] as roles from pg_policies
       where tablename in ('plans', 'workspace_subscriptions') order by 1, 2`);
    expect(p.rows.map((x) => [x.tablename, x.policyname, x.cmd, x.roles])).toEqual([
      [
        "workspace_subscriptions",
        "subscriptions_migrator_trial_insert",
        "INSERT",
        ["app_migrator"],
      ],
      // 0024: public villa okuma fonksiyonları için app_migrator'a dar SELECT (yalnız app.public_read açıkken).
      ["workspace_subscriptions", "subscriptions_public_read", "SELECT", ["app_migrator"]],
      ["workspace_subscriptions", "subscriptions_select", "SELECT", ["app_user"]],
    ]);
    const f = await admin.query(
      "select relname, relrowsecurity r, relforcerowsecurity f from pg_class where relname in ('plans','workspace_subscriptions') order by 1",
    );
    expect(f.rows).toEqual([
      { relname: "plans", r: false, f: false },
      { relname: "workspace_subscriptions", r: true, f: true },
    ]);
  });

  it("deneme tetikleyicisi workspaces üzerinde AFTER INSERT olarak tanımlı", async () => {
    const t = await admin.query(`
      select tgname, pg_get_triggerdef(oid) as def from pg_trigger
       where tgrelid = 'workspaces'::regclass and not tgisinternal order by 1`);
    const trial = t.rows.find((x) => x.tgname === "workspaces_start_trial");
    expect(trial?.def).toMatch(
      /AFTER INSERT ON public\.workspaces FOR EACH ROW EXECUTE FUNCTION app_workspace_start_trial\(\)/,
    );
  });
});

describe("migration: mevcut işletmeler için backfill", () => {
  it("0006 durumundaki veritabanında her işletmeye tek deneme aboneliği; FORCE RLS korunur", async () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8"),
    ) as { entries: { tag: string }[] };
    const upTo = journal.entries.findIndex((e) => e.tag === "0006_tenancy_security") + 1;
    expect(upTo).toBe(7);

    const dbName = `lodging_${randomBytes(4).toString("hex")}_test`;
    const server = new Client({ connectionString: db.serverAdminUrl });
    await server.connect();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kiraligim-migrations-"));
    try {
      await server.query(`create database "${dbName}"`);
      const boot = runBootstrap({
        dbName,
        migratorPassword: db.migratorPassword,
        appPassword: db.appPassword,
      });
      expect(boot.status, boot.output).toBe(0);
      const migUrl = new URL(db.migratorUrl);
      migUrl.pathname = `/${dbName}`;
      const suUrl = new URL(db.serverAdminUrl);
      suUrl.pathname = `/${dbName}`;

      // 1) Production'ın bugünkü durumu: 0000–0006.
      fs.mkdirSync(path.join(tmp, "meta"));
      for (const e of journal.entries.slice(0, upTo)) {
        fs.copyFileSync(
          path.join(migrationsFolder, `${e.tag}.sql`),
          path.join(tmp, `${e.tag}.sql`),
        );
      }
      fs.writeFileSync(
        path.join(tmp, "meta/_journal.json"),
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo) }),
      );
      await runMigrations({ url: migUrl.toString(), appEnv: "test", migrationsFolder: tmp });

      // Mevcut veri: iki aktif, bir askıdaki işletme.
      const su = new Client({ connectionString: suUrl.toString() });
      await su.connect();
      try {
        const owner = uuidv7();
        await su.query(
          "insert into users (id, name, email) values ($1, 'Eski', 'eski@ornek.com')",
          [owner],
        );
        const wsIds = [uuidv7(), uuidv7(), uuidv7()];
        for (const [i, id] of wsIds.entries()) {
          await su.query(
            "insert into workspaces (id, name, slug, created_by, status) values ($1, $2, $3, $4, $5)",
            [id, `Eski ${i}`, `eski-${i}`, owner, i === 2 ? "suspended" : "active"],
          );
          await su.query(
            "insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')",
            [uuidv7(), id, owner],
          );
        }

        // 2) Yeni sürüm: 0007 + 0008.
        const before = Date.now();
        await runMigrations({ url: migUrl.toString(), appEnv: "test", migrationsFolder });

        const subs = (
          await su.query(
            "select workspace_id, plan_id, status, trial_ends_at, id from workspace_subscriptions order by workspace_id",
          )
        ).rows;
        expect(subs.map((s) => s.workspace_id).sort()).toEqual([...wsIds].sort());
        for (const s of subs) {
          expect(s).toMatchObject({ plan_id: DEFAULT_PLAN_ID, status: "trialing" });
          expect(s.id).toMatch(UUID_V7);
          // Deneme migration anından başlar (geriye dönük kısalmaz).
          expect(new Date(s.trial_ends_at).getTime()).toBeGreaterThanOrEqual(
            before + 14 * 24 * 60 * 60 * 1000 - 60_000,
          );
        }
        // Mevcut veri değişmedi; FORCE RLS geri kondu.
        expect(
          (await su.query("select count(*)::int n from workspaces where status = 'suspended'"))
            .rows[0].n,
        ).toBe(1);
        const flags = await su.query(
          "select relname, relrowsecurity r, relforcerowsecurity f from pg_class where relname in ('workspaces','workspace_subscriptions') order by 1",
        );
        expect(flags.rows).toEqual([
          { relname: "workspace_subscriptions", r: true, f: true },
          { relname: "workspaces", r: true, f: true },
        ]);
        expect((await su.query("select count(*)::int n from drizzle.__migrations")).rows[0].n).toBe(
          journal.entries.length,
        );

        // 3) Tekrar çalıştırmak hiçbir şey yapmaz (çift abonelik yok).
        await runMigrations({ url: migUrl.toString(), appEnv: "test", migrationsFolder });
        expect(
          (await su.query("select count(*)::int n from workspace_subscriptions")).rows[0].n,
        ).toBe(3);
      } finally {
        await su.end();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      await server.query(`drop database if exists "${dbName}" with (force)`);
      await server.end();
    }
  });
});
