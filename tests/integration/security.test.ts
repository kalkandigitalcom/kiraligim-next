import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { inspectDbRole } from "@/db/role-check";
import { withTenant } from "@/db/tenant";

const db = inject("testDb");
const A = "0190a6e0-0000-7000-8000-0000000000a1";
const B = "0190a6e0-0000-7000-8000-0000000000b2";

/**
 * Canlı kurulumdan önce doğrulanması gereken güvenlik varsayımları:
 * tablo sahipliği, RLS ve FORCE ROW LEVEL SECURITY davranışı, rol ayrımı.
 */
describe("rol ayrımı, tablo sahipliği ve RLS", () => {
  const migratorPool = new Pool({ connectionString: db.migratorUrl, max: 1 });
  const appPool = new Pool({ connectionString: db.appUrl, max: 1 });
  const adminPool = new Pool({ connectionString: db.adminUrl, max: 1 });
  const migrator = drizzle(migratorPool);
  const app = drizzle(appPool);

  const count = async (pool: Pool) =>
    (await pool.query<{ n: number }>("select count(*)::int as n from sec_probe")).rows[0]?.n;

  beforeAll(async () => {
    // Migration'ların yapacağı gibi: tabloyu app_migrator oluşturur, RLS açılır ama henüz FORCE yok.
    await migratorPool.query(`
      create table public.sec_probe (workspace_id uuid not null, note text not null);
      alter table public.sec_probe enable row level security;
      create policy tenant_isolation on public.sec_probe
        using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
        with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
      grant select, insert, update, delete on public.sec_probe to app_user;
      insert into public.sec_probe values ('${A}', 'a1'), ('${B}', 'b1');
      create function public.sec_probe_fn() returns int language sql as 'select 1';
    `);
  });

  afterAll(async () => {
    await migratorPool.query(
      "drop table if exists public.sec_probe; drop function if exists public.sec_probe_fn()",
    );
    await Promise.all([migratorPool.end(), appPool.end(), adminPool.end()]);
  });

  it("tabloların sahibi app_migrator", async () => {
    const r = await adminPool.query(
      "select tableowner from pg_tables where schemaname = 'public' and tablename = 'sec_probe'",
    );
    expect(r.rows[0]?.tableowner).toBe("app_migrator");
  });

  it("FORCE olmadan tablo sahibi RLS'ten muaftır (bu yüzden FORCE zorunlu)", async () => {
    expect(await count(migratorPool)).toBe(2);
  });

  it("app_user FORCE olmadan da RLS'e tabidir", async () => {
    expect(await count(appPool)).toBe(0);
    const a = await withTenant(app, A, (tx) => tx.execute(sql`select note from sec_probe`));
    expect(a.rows.map((r) => r.note)).toEqual(["a1"]);
  });

  it("FORCE ROW LEVEL SECURITY sonrası tablo sahibi de RLS'e tabidir", async () => {
    await migratorPool.query("alter table public.sec_probe force row level security");
    expect(await count(migratorPool)).toBe(0);
    const b = await withTenant(migrator, B, (tx) => tx.execute(sql`select note from sec_probe`));
    expect(b.rows.map((r) => r.note)).toEqual(["b1"]);
    const err = await withTenant(migrator, A, (tx) =>
      tx.execute(sql`insert into sec_probe values (${B}, 'x')`),
    ).catch((e: unknown) => e);
    expect(String((err as { cause?: unknown }).cause ?? err)).toMatch(/row-level security/);
  });

  it("süper kullanıcı FORCE olsa bile RLS'i atlar (uygulama asla süper kullanıcıyla bağlanmamalı)", async () => {
    const r = await adminPool.query<{ n: number }>("select count(*)::int as n from sec_probe");
    expect(r.rows[0]?.n).toBe(2);
  });

  it("app_user RLS'i kapatamaz, FORCE'u kaldıramaz, politikaya dokunamaz", async () => {
    for (const stmt of [
      "alter table public.sec_probe disable row level security",
      "alter table public.sec_probe no force row level security",
      "drop policy tenant_isolation on public.sec_probe",
      "create policy herkes on public.sec_probe using (true)",
      "alter table public.sec_probe owner to app_user",
    ]) {
      await expect(appPool.query(stmt), stmt).rejects.toThrow(/must be owner|permission denied/);
    }
  });

  it("app_user başka role geçemez, yetki dağıtamaz, şemayı bozamaz", async () => {
    await expect(appPool.query("set role app_migrator")).rejects.toThrow(/permission denied/);
    // Yetki seçeneği olmayan GRANT hata değil uyarı verir; önemli olan hiçbir yetkinin verilmemesi.
    await appPool.query("grant select on public.sec_probe to public").catch(() => undefined);
    const acl = await adminPool.query<{ acl: string }>(
      "select relacl::text as acl from pg_class where relname = 'sec_probe'",
    );
    expect(acl.rows[0]?.acl).not.toMatch(/(^|[{,])=r/);
    await expect(appPool.query("truncate public.sec_probe")).rejects.toThrow(/permission denied/);
    await expect(appPool.query("drop table public.sec_probe")).rejects.toThrow(/must be owner/);
    await expect(appPool.query("create table public.x (id int)")).rejects.toThrow(
      /permission denied/,
    );
    await expect(appPool.query("create schema hack")).rejects.toThrow(/permission denied/);
  });

  it("app_user migration kayıtlarını okuyamaz", async () => {
    await expect(appPool.query("select * from drizzle.__migrations")).rejects.toThrow(
      /permission denied/,
    );
  });

  it("app_migrator'ın fonksiyonları açıkça izin verilmeden çalıştırılamaz", async () => {
    await expect(appPool.query("select public.sec_probe_fn()")).rejects.toThrow(
      /permission denied/,
    );
  });

  it("app_migrator süper kullanıcı değildir ve RLS'i atlayamaz", async () => {
    const r = await adminPool.query(
      "select rolsuper, rolbypassrls from pg_roles where rolname = 'app_migrator'",
    );
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});

describe("inspectDbRole", () => {
  const pools = {
    app: new Pool({ connectionString: db.appUrl, max: 1 }),
    migrator: new Pool({ connectionString: db.migratorUrl, max: 1 }),
    admin: new Pool({ connectionString: db.adminUrl, max: 1 }),
  };
  afterAll(() => Promise.all(Object.values(pools).map((p) => p.end())));

  it("app_user güvenli", async () => {
    await expect(inspectDbRole(pools.app)).resolves.toEqual({
      role: "app_user",
      safe: true,
      findings: [],
    });
  });

  it("app_migrator uygulama bağlantısı için güvensiz", async () => {
    const r = await inspectDbRole(pools.migrator);
    expect(r.safe).toBe(false);
    expect(r.findings).toEqual(
      expect.arrayContaining(["owns_database", "owns_schema", "can_create_in_schema"]),
    );
  });

  it("süper kullanıcı güvensiz", async () => {
    const r = await inspectDbRole(pools.admin);
    expect(r.safe).toBe(false);
    expect(r.findings).toEqual(expect.arrayContaining(["superuser", "bypassrls"]));
  });
});
