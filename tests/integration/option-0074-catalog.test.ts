import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { runMigrations } from "../../src/db/migrate";
import { runBootstrap } from "./psql";

/**
 * Opsiyon — 0074 (tek ve ortak opsiyon sistemi) katalog kanıtı ve geri alma.
 *
 * Ayrı, geçici bir veritabanında: migration'lar 0073'e kadar → S1 (production şeması); 0074 → S2.
 * 0074 YALNIZ app_option_automation_since(uuid) fonksiyonunun gövdesini değiştirir: adı, imzası,
 * SECURITY DEFINER, sahibi, sabit search_path ve yetkileri aynı; başka hiçbir fonksiyon, tablo,
 * sütun, kısıt, indeks, politika veya tetikleyici değişmez, yeni nesne eklenmez.
 * docs/rollback-0074.sql S1'i (0067 gövdesini) birebir geri getirir; yeniden migration S2'yi.
 */
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? "";
const dbName = `opt3s_${randomBytes(4).toString("hex")}_test`;
// Roller (app_migrator, app_user) veritabanına değil KÜMEYE aittir: db-bootstrap.sql parolalarını
// küme genelinde yeniler. Ana test kurulumunun parolaları kullanılmazsa diğer test dosyalarının
// bağlantıları parola doğrulamasında reddedilir (CI: scram-sha-256).
const { migratorPassword, appPassword } = inject("testDb");
const folder = path.resolve(__dirname, "../../drizzle");
const rollback = path.resolve(__dirname, "../../docs/rollback-0074.sql");
let tmp: string;
/** 0074'e kadar: sonraki aşamalar bu dosyanın kanıtını değiştirmez. */
let tmp3e: string;

const withDb = (url: string, db: string, user?: { name: string; password: string }) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
};
const migratorUrl = () =>
  withDb(ADMIN_URL, dbName, { name: "app_migrator", password: migratorPassword });
const superUrl = () => withDb(ADMIN_URL, dbName);

function truncatedFolder(lastIdx: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opt3s-"));
  fs.mkdirSync(path.join(dir, "meta"));
  const journal = JSON.parse(fs.readFileSync(path.join(folder, "meta/_journal.json"), "utf8"));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= lastIdx);
  fs.writeFileSync(path.join(dir, "meta/_journal.json"), JSON.stringify(journal));
  for (const e of journal.entries as { tag: string }[]) {
    fs.copyFileSync(path.join(folder, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  }
  return dir;
}

async function query(sql: string) {
  const c = new Client({ connectionString: superUrl() });
  await c.connect();
  try {
    return (await c.query(sql)).rows;
  } finally {
    await c.end();
  }
}

async function snapshot(): Promise<Set<string>> {
  const rows = await query(`
    select 'F|' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|'
           || p.prosecdef || '|' || pg_get_userbyid(p.proowner) || '|' || coalesce(p.proconfig::text, '')
           || '|' || coalesce(p.proacl::text, '') || '|' || md5(p.prosrc) as s
      from pg_proc p where p.pronamespace = 'public'::regnamespace
    union all
    select 'T|' || c.relname || '|' || c.relkind::text || '|' || c.relrowsecurity || '|' || c.relforcerowsecurity
           || '|' || coalesce(c.relacl::text, '') || '|' || pg_get_userbyid(c.relowner)
      from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v', 'S')
    union all
    select 'C|' || c.relname || '|' || a.attname || '|' || format_type(a.atttypid, a.atttypmod)
           || '|' || a.attnotnull || '|' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
      from pg_attribute a join pg_class c on c.oid = a.attrelid
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and a.attnum > 0
       and not a.attisdropped
    union all
    select 'K|' || conrelid::regclass::text || '|' || conname || '|' || pg_get_constraintdef(oid)
      from pg_constraint where connamespace = 'public'::regnamespace
    union all
    select 'I|' || indexname || '|' || indexdef from pg_indexes where schemaname = 'public'
    union all
    select 'P|' || tablename || '|' || policyname || '|' || permissive || '|' || roles::text || '|' || cmd
           || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '')
      from pg_policies where schemaname = 'public'
    union all
    select 'G|' || c.relname || '|' || t.tgname || '|' || pg_get_triggerdef(t.oid)
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where c.relnamespace = 'public'::regnamespace and not t.tgisinternal`);
  return new Set(rows.map((r) => r.s as string));
}
const minus = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x)).sort();

function runRollback(): string {
  try {
    execFileSync(
      "psql",
      [migratorUrl(), "-X", "-v", "ON_ERROR_STOP=1", "-1", "-q", "-f", rollback],
      { stdio: "pipe" },
    );
    return "ok";
  } catch (e) {
    const err = e as { stderr?: Buffer };
    return (
      String(err.stderr ?? "")
        .trim()
        .split("\n")[0] ?? "error"
    );
  }
}

const migrationCount = async () =>
  Number((await query("select count(*)::int n from drizzle.__migrations"))[0].n);

const CHANGED = "app_option_automation_since(p_group uuid)";

let S1: Set<string>;
let S2: Set<string>;

beforeAll(async () => {
  const res = runBootstrap({ dbName, migratorPassword, appPassword });
  if (res.status !== 0) throw new Error(`db-bootstrap.sql başarısız:\n${res.output}`);
  tmp = truncatedFolder(73);
  tmp3e = truncatedFolder(74);
  await runMigrations({ url: migratorUrl(), appEnv: "test", migrationsFolder: tmp });
  S1 = await snapshot();
  await runMigrations({ url: migratorUrl(), appEnv: "test", migrationsFolder: tmp3e });
  S2 = await snapshot();
}, 180_000);

afterAll(async () => {
  const c = new Client({ connectionString: ADMIN_URL });
  await c.connect();
  await c.query(`drop database if exists "${dbName}" with (force)`);
  await c.end();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  if (tmp3e) fs.rmSync(tmp3e, { recursive: true, force: true });
});

describe("0074: yalnız app_option_automation_since gövdesi", () => {
  it("değişen tek nesne app_option_automation_since; başka hiçbir nesne değişmez, yeni nesne yok", () => {
    const removed = minus(S1, S2);
    const added = minus(S2, S1);
    expect(removed).toHaveLength(1);
    expect(added).toHaveLength(1);
    expect(removed[0]!.startsWith(`F|${CHANGED}|`)).toBe(true);
    expect(added[0]!.startsWith(`F|${CHANGED}|`)).toBe(true);
    // Yalnız gövde (md5) değişir: SECURITY DEFINER, sahibi, search_path ve yetkiler aynı.
    const meta = (x: string) => x.split("|").slice(0, -1).join("|");
    expect(meta(added[0]!)).toBe(meta(removed[0]!));
    const [, , definer, owner, config, acl] = added[0]!.split("|");
    expect(definer).toBe("true");
    expect(owner).toBe("app_migrator");
    expect(config).toBe('{"search_path=pg_catalog, pg_temp"}');
    const grantees = [...acl!.matchAll(/([a-z_]*)=X/g)]
      .map((m) => m[1])
      .filter((g) => g !== "app_migrator");
    expect(grantees).toEqual(["app_user"]);
  });

  it("yeni gövde işletme / grup ayar tablolarını okumaz; global, grup bağlantısı ve işletme durumunu okur", async () => {
    const src = (
      await query(
        "select prosrc from pg_proc where proname = 'app_option_automation_since' and pronamespace = 'public'::regnamespace",
      )
    )[0].prosrc as string;
    expect(src).not.toMatch(/workspace_option_settings|wa_group_option_settings/);
    expect(src).toMatch(/option_automation_global/);
    expect(src).toMatch(/g\.status = 'linked'/);
    expect(src).toMatch(/w\.status = 'active'/);
    expect(src).toMatch(/o\.enabled/);
  });
});

describe("0074: geri alma ve yeniden migration", () => {
  it("geri alma 0073 şemasını birebir getirir (iki kez de); yeniden migration 0074'ü", async () => {
    expect(await migrationCount()).toBe(75);
    expect(runRollback()).toBe("ok");
    expect(await migrationCount()).toBe(74);
    expect(minus(S1, await snapshot())).toEqual([]);
    expect(minus(await snapshot(), S1)).toEqual([]);
    expect(runRollback()).toBe("ok");
    expect(minus(await snapshot(), S1)).toEqual([]);
    await runMigrations({ url: migratorUrl(), appEnv: "test", migrationsFolder: tmp3e });
    const S3 = await snapshot();
    expect(minus(S2, S3)).toEqual([]);
    expect(minus(S3, S2)).toEqual([]);
    expect(await migrationCount()).toBe(75);
  });

  it("0074 geri alınmadan 0073 geri alınamaz", () => {
    expect(runRollbackFile(path.resolve(__dirname, "../../docs/rollback-0073.sql"))).toMatch(
      /rollback_0073_blocked/,
    );
  });
});

function runRollbackFile(file: string): string {
  try {
    execFileSync("psql", [migratorUrl(), "-X", "-v", "ON_ERROR_STOP=1", "-1", "-q", "-f", file], {
      stdio: "pipe",
    });
    return "ok";
  } catch (e) {
    const err = e as { stderr?: Buffer };
    return String(err.stderr ?? "").trim();
  }
}
