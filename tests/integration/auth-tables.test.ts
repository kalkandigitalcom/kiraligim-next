import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getTableColumns } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { runMigrations } from "@/db/migrate";
import { authSchema } from "@/db/schema/auth";

import { runBootstrap } from "./psql";

/**
 * 0003_auth_tables + 0004_auth_grants:
 * - veritabanındaki tablo/kolonlar Drizzle şemasıyla birebir (snake_case, tip, boşluk, kısıt);
 * - app_user yalnız tanımlı yetkilere sahip; PUBLIC / app_admin / app_worker hiçbir şeye sahip değil;
 * - RLS bu tablolarda bilinçli olarak kapalı;
 * - migration geçmişi 0000–0002 ile uyumlu; 0000–0002'si uygulanmış bir veritabanına
 *   (production'ın bugünkü durumu) yalnız 0003–0004 eklenir.
 */

const db = inject("testDb");
const migrationsFolder = path.resolve(__dirname, "../../drizzle");

const snake = (s: string) => s.replace(/([a-z\d])([A-Z])/g, "$1_$2").toLowerCase();

const TABLES = Object.values(authSchema) as PgTable[];
const TABLE_NAMES = TABLES.map((t) => getTableConfig(t).name).sort();

/** app_user'ın tablo başına beklenen yetkileri (0004_auth_grants). */
const EXPECTED_APP_USER: Record<string, string[]> = {
  accounts: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  rate_limits: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  sessions: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  users: ["INSERT", "SELECT", "UPDATE"],
  verifications: ["DELETE", "INSERT", "SELECT", "UPDATE"],
};

const PG_TYPE: Record<string, string> = {
  PgUUID: "uuid",
  PgText: "text",
  PgBoolean: "boolean",
  PgTimestamp: "timestamp with time zone",
  PgInteger: "integer",
  PgBigInt53: "bigint",
};

describe("kimlik tabloları: şema", () => {
  const admin = new Client({ connectionString: db.adminUrl });
  beforeAll(() => admin.connect());
  afterAll(() => admin.end());

  it("beş tablo public şemada, sahibi app_migrator", async () => {
    const r = await admin.query(
      "select tablename, tableowner from pg_tables where schemaname = 'public' and tablename = any($1) order by 1",
      [TABLE_NAMES],
    );
    expect(r.rows.map((x) => x.tablename)).toEqual(TABLE_NAMES);
    expect(new Set(r.rows.map((x) => x.tableowner))).toEqual(new Set(["app_migrator"]));
  });

  for (const table of TABLES) {
    const cfg = getTableConfig(table);
    it(`${cfg.name}: kolonlar snake_case ve Drizzle ile birebir (ad, tip, boşluk, varsayılan)`, async () => {
      const r = await admin.query(
        `select column_name, data_type, is_nullable, column_default
           from information_schema.columns
          where table_schema = 'public' and table_name = $1 order by column_name`,
        [cfg.name],
      );
      for (const row of r.rows) expect(row.column_name, "camelCase kolon").toMatch(/^[a-z0-9_]+$/);

      const expected = Object.entries(getTableColumns(table))
        .map(([key, col]) => ({
          column_name: snake(key),
          data_type: PG_TYPE[col.columnType],
          is_nullable: col.notNull ? "NO" : "YES",
          has_default: col.hasDefault,
        }))
        .sort((a, b) => a.column_name.localeCompare(b.column_name));
      expect(
        r.rows.map((x) => ({
          column_name: x.column_name,
          data_type: x.data_type,
          is_nullable: x.is_nullable,
          has_default: x.column_default !== null,
        })),
      ).toEqual(expected);
    });
  }

  it("kısıtlar: e-posta benzersiz ve küçük harf, belirteç benzersiz, yabancı anahtarlar kullanıcı silinince siler", async () => {
    const r = await admin.query(
      `select conrelid::regclass::text as tbl, conname, contype,
              confdeltype, pg_get_constraintdef(oid) as def
         from pg_constraint
        where connamespace = 'public'::regnamespace and conrelid::regclass::text = any($1)
          and contype in ('u', 'c', 'f')
        order by 1, 2`,
      [TABLE_NAMES],
    );
    const byName = Object.fromEntries(r.rows.map((x) => [x.conname, x]));
    expect(byName.users_email_key?.def).toBe("UNIQUE (email)");
    expect(byName.users_email_lowercase?.def).toBe("CHECK ((email = lower(email)))");
    expect(byName.sessions_token_key?.def).toBe("UNIQUE (token)");
    expect(byName.accounts_provider_account_key?.def).toBe("UNIQUE (provider_id, account_id)");
    expect(byName.rate_limits_key_key?.def).toBe("UNIQUE (key)");
    const fks = r.rows.filter((x) => x.contype === "f");
    expect(fks.map((x) => [x.tbl, x.confdeltype, x.def])).toEqual([
      ["accounts", "c", "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE"],
      ["sessions", "c", "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE"],
    ]);
  });

  it("indeksler var", async () => {
    const r = await admin.query(
      "select indexname from pg_indexes where schemaname = 'public' and indexname like any(array['%_idx'])",
    );
    expect(r.rows.map((x) => x.indexname)).toEqual(
      expect.arrayContaining([
        "accounts_user_id_idx",
        "sessions_user_id_idx",
        "verifications_identifier_idx",
        "rate_limits_last_request_idx",
      ]),
    );
  });

  it("RLS bu tablolarda bilinçli olarak KAPALI (Better Auth tenant bağlamı olmadan sorgular)", async () => {
    const r = await admin.query(
      `select relname, relrowsecurity, relforcerowsecurity from pg_class
        where relnamespace = 'public'::regnamespace and relname = any($1) order by 1`,
      [TABLE_NAMES],
    );
    for (const row of r.rows) {
      expect(row, row.relname).toMatchObject({ relrowsecurity: false, relforcerowsecurity: false });
    }
  });
});

describe("kimlik tabloları: yetkiler", () => {
  const admin = new Client({ connectionString: db.adminUrl });
  const app = new Pool({ connectionString: db.appUrl, max: 1 });
  beforeAll(() => admin.connect());
  afterAll(async () => {
    await admin.end();
    await app.end();
  });

  type Grant = { tbl: string; grantee: string; privilege: string };
  const grants = async (): Promise<Grant[]> =>
    (
      await admin.query<Grant>(
        `select c.relname as tbl,
                case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee,
                a.privilege_type as privilege
           from pg_class c, aclexplode(c.relacl) a
          where c.relnamespace = 'public'::regnamespace and c.relname = any($1)
          order by 1, 2, 3`,
        [TABLE_NAMES],
      )
    ).rows;

  it("PUBLIC, app_admin ve app_worker'ın hiçbir yetkisi yok", async () => {
    const g = await grants();
    expect(g.filter((x) => ["PUBLIC", "app_admin", "app_worker"].includes(x.grantee))).toEqual([]);
    expect(new Set(g.map((x) => x.grantee))).toEqual(new Set(["app_migrator", "app_user"]));
  });

  for (const [tbl, privileges] of Object.entries(EXPECTED_APP_USER)) {
    it(`${tbl}: app_user yalnız ${privileges.join(", ")}`, async () => {
      const g = (await grants()).filter((x) => x.tbl === tbl && x.grantee === "app_user");
      expect(g.map((x) => x.privilege)).toEqual(privileges);
    });
  }

  it("app_user users tablosundan silemez, hiçbir tabloyu boşaltamaz/değiştiremez/düşüremez", async () => {
    await expect(app.query("delete from users")).rejects.toThrow(/permission denied/);
    for (const t of TABLE_NAMES) {
      await expect(app.query(`truncate ${t}`), t).rejects.toThrow(/permission denied/);
      await expect(app.query(`alter table ${t} add column x int`), t).rejects.toThrow(
        /must be owner/,
      );
      await expect(app.query(`drop table ${t}`), t).rejects.toThrow(/must be owner/);
    }
  });

  it("app_user ile temel yazma/okuma çalışır; kısıtlar uygulanır", async () => {
    const id = crypto.randomUUID();
    const email = `test-${randomBytes(4).toString("hex")}@ornek.com`;
    await app.query("insert into users (id, name, email) values ($1, 'Test', $2)", [id, email]);
    await expect(
      app.query("insert into users (id, name, email) values ($1, 'X', $2)", [
        crypto.randomUUID(),
        email.toUpperCase(),
      ]),
    ).rejects.toThrow(/users_email_lowercase/);
    await expect(
      app.query("insert into users (id, name, email) values ($1, 'X', $2)", [
        crypto.randomUUID(),
        email,
      ]),
    ).rejects.toThrow(/users_email_key/);
    await app.query(
      "insert into sessions (id, expires_at, token, user_id) values ($1, now() + interval '1 day', $2, $3)",
      [crypto.randomUUID(), randomBytes(16).toString("hex"), id],
    );
    await app.query(
      "insert into accounts (id, account_id, provider_id, user_id, password) values ($1, $2, 'credential', $3, 'hash')",
      [crypto.randomUUID(), id, id],
    );
    await app.query("update users set name = 'Yeni' where id = $1", [id]);
    await app.query("delete from sessions where user_id = $1", [id]);

    // Kullanıcı silindiğinde (yalnız migrator/yönetici yapabilir) bağlı kayıtlar da silinir.
    const migrator = new Client({ connectionString: db.migratorUrl });
    await migrator.connect();
    try {
      await migrator.query("delete from users where id = $1", [id]);
      const left = await migrator.query(
        "select (select count(*) from accounts where user_id = $1)::int as a, (select count(*) from sessions where user_id = $1)::int as s",
        [id],
      );
      expect(left.rows[0]).toEqual({ a: 0, s: 0 });
    } finally {
      await migrator.end();
    }
  });
});

describe("migration geçmişi", () => {
  const journal = JSON.parse(
    fs.readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8"),
  ) as { entries: { idx: number; tag: string; when: number }[] };

  it("günlük sıralı ve zaman damgaları artan; 0000–0002 yerinde", () => {
    const tags = journal.entries.map((e) => e.tag);
    expect(tags.slice(0, 5)).toEqual([
      "0000_bootstrap",
      "0001_function_privileges",
      "0002_revoke_public_schema_usage",
      "0003_auth_tables",
      "0004_auth_grants",
    ]);
    journal.entries.forEach((e, i) => expect(e.idx).toBe(i));
    for (let i = 1; i < journal.entries.length; i++) {
      expect(journal.entries[i]!.when).toBeGreaterThan(journal.entries[i - 1]!.when);
    }
  });

  it("veritabanı kayıtları dosyalarla birebir (hash ve zaman damgası)", async () => {
    const admin = new Client({ connectionString: db.adminUrl });
    await admin.connect();
    try {
      const rows = (
        await admin.query<{ hash: string; created_at: string }>(
          "select hash, created_at from drizzle.__migrations order by created_at",
        )
      ).rows;
      expect(rows.map((r) => Number(r.created_at))).toEqual(journal.entries.map((e) => e.when));
      expect(rows.map((r) => r.hash)).toEqual(
        journal.entries.map((e) =>
          createHash("sha256")
            .update(fs.readFileSync(path.join(migrationsFolder, `${e.tag}.sql`)))
            .digest("hex"),
        ),
      );
    } finally {
      await admin.end();
    }
  });

  it("production'ın bugünkü durumu (0000–0002 uygulanmış) üzerine yalnız yeni migration'lar eklenir", async () => {
    const dbName = `lodging_${randomBytes(4).toString("hex")}_test`;
    const server = new Client({ connectionString: db.serverAdminUrl });
    await server.connect();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kiraligim-migrations-"));
    try {
      // Production'daki gibi: postgres'in oluşturduğu, içinde veri olmayan veritabanı + bootstrap.
      await server.query(`create database "${dbName}"`);
      const boot = runBootstrap({
        dbName,
        migratorPassword: db.migratorPassword,
        appPassword: db.appPassword,
      });
      expect(boot.status, boot.output).toBe(0);
      const url = new URL(db.migratorUrl);
      url.pathname = `/${dbName}`;

      // 1) Yalnız 0000–0002 (production'da bugün kayıtlı olanlar).
      fs.mkdirSync(path.join(tmp, "meta"));
      for (const e of journal.entries.slice(0, 3)) {
        fs.copyFileSync(
          path.join(migrationsFolder, `${e.tag}.sql`),
          path.join(tmp, `${e.tag}.sql`),
        );
      }
      fs.writeFileSync(
        path.join(tmp, "meta/_journal.json"),
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, 3) }),
      );
      await runMigrations({ url: url.toString(), appEnv: "test", migrationsFolder: tmp });

      const check = new Client({ connectionString: url.toString() });
      await check.connect();
      try {
        const before = await check.query(
          "select id, hash, created_at from drizzle.__migrations order by id",
        );
        expect(before.rowCount).toBe(3);
        expect(
          (await check.query("select to_regclass('public.users') as t")).rows[0]?.t,
        ).toBeNull();

        // 2) Yeni sürüm: tüm klasör. Yalnız 0003 ve 0004 uygulanmalı, öncekiler değişmemeli.
        await runMigrations({ url: url.toString(), appEnv: "test", migrationsFolder });
        const after = await check.query(
          "select id, hash, created_at from drizzle.__migrations order by id",
        );
        expect(after.rowCount).toBe(journal.entries.length);
        expect(after.rows.slice(0, 3)).toEqual(before.rows);
        expect((await check.query("select to_regclass('public.users') as t")).rows[0]?.t).toBe(
          "users",
        );

        // 3) Tekrar çalıştırmak hiçbir şey yapmaz.
        await runMigrations({ url: url.toString(), appEnv: "test", migrationsFolder });
        expect(
          (await check.query("select count(*)::int as n from drizzle.__migrations")).rows[0]?.n,
        ).toBe(journal.entries.length);
      } finally {
        await check.end();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      await server.query(`drop database if exists "${dbName}" with (force)`);
      await server.end();
    }
  });

  it("başarısız bir migration önceki durumu bozmaz (tek transaction)", async () => {
    const dbName = `lodging_${randomBytes(4).toString("hex")}_test`;
    const server = new Client({ connectionString: db.serverAdminUrl });
    await server.connect();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kiraligim-migrations-"));
    try {
      await server.query(`create database "${dbName}"`);
      expect(
        runBootstrap({ dbName, migratorPassword: db.migratorPassword, appPassword: db.appPassword })
          .status,
      ).toBe(0);
      const url = new URL(db.migratorUrl);
      url.pathname = `/${dbName}`;

      // 0000–0002 + 0003 + bozuk bir 0004.
      fs.mkdirSync(path.join(tmp, "meta"));
      for (const e of journal.entries.slice(0, 4)) {
        fs.copyFileSync(
          path.join(migrationsFolder, `${e.tag}.sql`),
          path.join(tmp, `${e.tag}.sql`),
        );
      }
      fs.writeFileSync(
        path.join(tmp, "0004_auth_grants.sql"),
        "GRANT SELECT ON TABLE yok_boyle_tablo TO app_user;",
      );
      fs.writeFileSync(
        path.join(tmp, "meta/_journal.json"),
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, 5) }),
      );
      await expect(
        runMigrations({ url: url.toString(), appEnv: "test", migrationsFolder: tmp }),
      ).rejects.toThrow();

      const check = new Client({ connectionString: url.toString() });
      await check.connect();
      try {
        // Hiçbiri uygulanmadı: ne kayıt ne tablo.
        const reg = await check.query(
          "select to_regclass('drizzle.__migrations') as m, to_regclass('public.users') as u",
        );
        const applied = reg.rows[0]?.m
          ? (await check.query("select count(*)::int as n from drizzle.__migrations")).rows[0]?.n
          : 0;
        expect(applied).toBe(0);
        expect(reg.rows[0]?.u).toBeNull();
      } finally {
        await check.end();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      await server.query(`drop database if exists "${dbName}" with (force)`);
      await server.end();
    }
  });
});
