import { randomBytes } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { runBootstrap } from "./psql";

const db = inject("testDb");

/**
 * scripts/db-bootstrap.sql:
 * - parolaları yalnız ortam değişkeninden alır, zayıf parolayı reddeder;
 * - var olan bir veritabanındaki veriyi silmez, yalnız sahipliği devreder.
 * Roller küme genelindedir; bu yüzden geçerli çalıştırmalar global kurulumdaki parolaları kullanır.
 */
describe("db-bootstrap.sql", () => {
  const extraDb = `lodging_${randomBytes(4).toString("hex")}_test`;
  const server = new Client({ connectionString: db.serverAdminUrl });

  beforeAll(async () => {
    await server.connect();
  });
  afterAll(async () => {
    await server.query(`drop database if exists "${extraDb}" with (force)`);
    await server.end();
  });

  it("parola ortam değişkeni yoksa durur", () => {
    const res = runBootstrap({ dbName: extraDb });
    expect(res.status).not.toBe(0);
    expect(res.output).toContain("KG_MIGRATOR_PASSWORD");
  });

  it("zayıf, kısa veya özel karakterli parolayı reddeder", () => {
    const strong = "a".repeat(40);
    for (const [m, a] of [
      ["kisa", strong],
      [strong, strong],
      ["x".repeat(40) + "'; drop role postgres; --", strong],
    ] as const) {
      const res = runBootstrap({ dbName: extraDb, migratorPassword: m, appPassword: a });
      expect(res.status).not.toBe(0);
      expect(res.output).toContain("parolalar en az 32");
    }
  });

  it("geçersiz veritabanı adını reddeder", () => {
    const res = runBootstrap({
      dbName: "kiraligim",
      migratorPassword: db.migratorPassword,
      appPassword: db.appPassword,
    });
    expect(res.status).not.toBe(0);
    expect(res.output).toContain("_dev, _prod veya _test");
  });

  it("parolalar komut satırına hiç yazılmaz", () => {
    const res = runBootstrap({
      dbName: extraDb,
      migratorPassword: db.migratorPassword,
      appPassword: db.appPassword,
    });
    const args = res.args.join(" ");
    expect(args).not.toContain(db.migratorPassword);
    expect(args).not.toContain(db.appPassword);
    expect(res.output).not.toContain(db.migratorPassword);
    expect(res.output).not.toContain(db.appPassword);
  });

  it("var olan veritabanındaki veriyi korur, sahipliği app_migrator'a devreder", async () => {
    const existing = `lodging_${randomBytes(4).toString("hex")}_test`;
    try {
      // Canlıdaki durumun benzeri: postgres'in oluşturduğu, içinde veri olan veritabanı.
      await server.query(`create database "${existing}"`);
      const pre = new Client({ connectionString: withDb(db.serverAdminUrl, existing) });
      await pre.connect();
      await pre.query("create table onceki (id int); insert into onceki values (1), (2)");

      const res = runBootstrap({
        dbName: existing,
        migratorPassword: db.migratorPassword,
        appPassword: db.appPassword,
      });
      expect(res.status, res.output).toBe(0);

      const rows = await pre.query("select count(*)::int as n from onceki");
      expect(rows.rows[0].n).toBe(2);
      const owner = await pre.query(
        "select pg_get_userbyid(datdba) as db_owner, (select nspowner::regrole::text from pg_namespace where nspname = 'public') as schema_owner from pg_database where datname = current_database()",
      );
      expect(owner.rows[0]).toEqual({ db_owner: "app_migrator", schema_owner: "app_migrator" });
      await pre.end();
    } finally {
      await server.query(`drop database if exists "${existing}" with (force)`);
    }
  });

  it("tekrar çalıştırılabilir (idempotent)", () => {
    for (let i = 0; i < 2; i++) {
      const res = runBootstrap({
        dbName: db.dbName,
        migratorPassword: db.migratorPassword,
        appPassword: db.appPassword,
      });
      expect(res.status, res.output).toBe(0);
    }
  });
});

function withDb(url: string, name: string) {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}
