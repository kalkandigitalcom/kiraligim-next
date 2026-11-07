import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inject } from "vitest";

import { withTenantContextUnchecked } from "@/db/tenant";

const db = inject("testDb");
const A = "0190a6e0-0000-7000-8000-00000000000a";
const B = "0190a6e0-0000-7000-8000-00000000000b";

/**
 * RLS iskeletinin doğru çalıştığını, geçici bir tabloyla kanıtlar.
 * Gerçek tenant tabloları Faz 2'de aynı politika kalıbını kullanacak.
 */
describe("withTenant + RLS", () => {
  const migratorPool = new Pool({ connectionString: db.migratorUrl, max: 1 });
  // max: 1 → her sorgu aynı bağlantıyı kullanır; ayarın sızıp sızmadığını test edebiliriz.
  const appPool = new Pool({ connectionString: db.appUrl, max: 1 });
  const migrator = drizzle(migratorPool);
  const app = drizzle(appPool);

  beforeAll(async () => {
    await migratorPool.query(`
      create table public.rls_probe (workspace_id uuid not null, note text not null);
      alter table public.rls_probe enable row level security;
      alter table public.rls_probe force row level security;
      create policy tenant_isolation on public.rls_probe
        using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
        with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
      grant select, insert on public.rls_probe to app_user;
    `);
    await withTenantContextUnchecked(migrator, A, (tx) =>
      tx.execute(sql`insert into rls_probe values (${A}, 'a1'), (${A}, 'a2')`),
    );
    await withTenantContextUnchecked(migrator, B, (tx) =>
      tx.execute(sql`insert into rls_probe values (${B}, 'b1')`),
    );
  });

  afterAll(async () => {
    await migratorPool.query("drop table if exists public.rls_probe");
    await appPool.end();
    await migratorPool.end();
  });

  it("her workspace yalnız kendi satırlarını görür", async () => {
    const a = await withTenantContextUnchecked(app, A, (tx) =>
      tx.execute(sql`select note from rls_probe order by note`),
    );
    const b = await withTenantContextUnchecked(app, B, (tx) =>
      tx.execute(sql`select note from rls_probe order by note`),
    );
    expect(a.rows.map((r) => r.note)).toEqual(["a1", "a2"]);
    expect(b.rows.map((r) => r.note)).toEqual(["b1"]);
  });

  it("tenant bağlamı olmadan hiçbir satır görünmez", async () => {
    const r = await appPool.query("select count(*)::int as n from rls_probe");
    expect(r.rows[0].n).toBe(0);
  });

  it("başka workspace adına satır yazılamaz", async () => {
    await expect(
      withTenantContextUnchecked(app, A, (tx) =>
        tx.execute(sql`insert into rls_probe values (${B}, 'saldırı')`),
      ),
    ).rejects.toThrow();
  });

  it("ayar transaction bitince bağlantıda kalmaz", async () => {
    await withTenantContextUnchecked(app, A, async (tx) => tx.execute(sql`select 1`));
    const r = await appPool.query("select current_setting('app.workspace_id', true) as v");
    expect(r.rows[0].v ?? "").toBe("");
  });

  it("geçersiz workspace kimliğini reddeder", async () => {
    await expect(withTenantContextUnchecked(app, "1 or 1=1", async () => 1)).rejects.toThrow(
      /UUID/,
    );
  });
});
