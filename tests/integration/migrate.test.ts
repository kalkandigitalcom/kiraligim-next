import path from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { runMigrations } from "@/db/migrate";

const db = inject("testDb");
const migrationsFolder = path.resolve(__dirname, "../../drizzle");

describe("migration ve roller", () => {
  const app = new Client({ connectionString: db.appUrl });
  const admin = new Client({ connectionString: db.adminUrl });

  beforeAll(async () => {
    await app.connect();
    await admin.connect();
  });
  afterAll(async () => {
    await app.end();
    await admin.end();
  });

  it("btree_gist kurulu ve migration kaydı tutuluyor", async () => {
    const ext = await admin.query("select 1 from pg_extension where extname = 'btree_gist'");
    expect(ext.rowCount).toBe(1);
    const applied = await admin.query("select count(*)::int as n from drizzle.__migrations");
    expect(applied.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it("tekrar çalıştırmak hiçbir şeyi değiştirmez", async () => {
    const before = await admin.query("select count(*)::int as n from drizzle.__migrations");
    await runMigrations({ url: db.migratorUrl, appEnv: "test", migrationsFolder });
    const after = await admin.query("select count(*)::int as n from drizzle.__migrations");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("yanlış ortamın veritabanına migration uygulanmaz", async () => {
    await expect(
      runMigrations({ url: db.migratorUrl, appEnv: "production", migrationsFolder }),
    ).rejects.toThrow(/_prod/);
  });

  it("uygulama rolü ayrıcalıksız", async () => {
    const r = await admin.query(
      "select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin from pg_roles where rolname like 'app_%' order by rolname",
    );
    for (const row of r.rows) {
      expect(row).toMatchObject({
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
      });
    }
    const login = Object.fromEntries(r.rows.map((x) => [x.rolname, x.rolcanlogin]));
    expect(login).toEqual({
      app_admin: false,
      app_migrator: true,
      app_user: true,
      app_worker: false,
    });
  });

  it("uygulama rolü tablo oluşturamaz", async () => {
    await expect(app.query("create table public.hack (id int)")).rejects.toThrow(
      /permission denied/,
    );
  });

  it("veritabanının sahibi app_migrator", async () => {
    const r = await admin.query(
      "select pg_get_userbyid(datdba) as owner from pg_database where datname = current_database()",
    );
    expect(r.rows[0].owner).toBe("app_migrator");
  });
});
