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
 * Opsiyon Aşama 3e — 0073'ün YALNIZ yeni opsiyon (kesinleştirme) fonksiyonları eklediğinin katalog
 * kanıtı ve geri alma.
 *
 * Ayrı, geçici bir veritabanında: migration'lar 0072'ye kadar → S1 (3d şeması, production'daki);
 * 0073 → S2. S1'deki HER nesne (mevcut rezervasyon fonksiyonları, tablolar, sütunlar, politikalar)
 * S2'de birebir durur; eklenen nesneler yalnız dört app_option_* fonksiyonu (SECURITY DEFINER, sahibi
 * app_migrator, sabit search_path, yalnız app_user). docs/rollback-0073.sql S1'i (0072 şemasını)
 * birebir geri getirir; yeniden migration S2'yi.
 */
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? "";
const dbName = `opt3e_${randomBytes(4).toString("hex")}_test`;
// Roller (app_migrator, app_user) veritabanına değil KÜMEYE aittir: db-bootstrap.sql parolalarını
// küme genelinde yeniler. Ana test kurulumunun parolaları kullanılmazsa diğer test dosyalarının
// bağlantıları parola doğrulamasında reddedilir (CI: scram-sha-256).
const { migratorPassword, appPassword } = inject("testDb");
const folder = path.resolve(__dirname, "../../drizzle");
const rollback = path.resolve(__dirname, "../../docs/rollback-0073.sql");
let tmp: string;
/** 0073'e kadar (Aşama 3e'nin son migration'ı): sonraki aşamalar bu dosyanın kanıtını değiştirmez. */
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opt3e-"));
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

const NEW_FUNCTIONS = {
  app_option_claim_approved_conversions: "app_user",
  app_option_convert_owner: "app_user",
  app_option_convert_begin: "app_user",
  app_option_convert_finish: "app_user",
} as const;

let S1: Set<string>;
let S2: Set<string>;

beforeAll(async () => {
  const res = runBootstrap({ dbName, migratorPassword, appPassword });
  if (res.status !== 0) throw new Error(`db-bootstrap.sql başarısız:\n${res.output}`);
  tmp = truncatedFolder(72);
  tmp3e = truncatedFolder(73);
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

describe("Aşama 3e (0073): yalnız yeni opsiyon fonksiyonları", () => {
  it("0072 şemasındaki HER nesne birebir aynı (rezervasyon fonksiyonları, tablolar, sütunlar, politikalar değişmez)", () => {
    expect(minus(S1, S2)).toEqual([]);
  });

  it("eklenen her nesne yeni bir opsiyon fonksiyonu; tablo / sütun / kısıt / indeks / politika / tetikleyici yok", () => {
    const added = minus(S2, S1);
    expect(added.every((s) => s.startsWith("F|app_option_"))).toBe(true);
    expect(added.map((s) => s.split("(")[0]!.slice(2)).sort()).toEqual(
      Object.keys(NEW_FUNCTIONS).sort(),
    );
    for (const s of added) {
      const [, , definer, owner, config] = s.split("|");
      expect(definer).toBe("true");
      expect(owner).toBe("app_migrator");
      expect(config).toBe('{"search_path=pg_catalog, pg_temp"}');
    }
  });

  it("yetkiler: yeni fonksiyonlar yalnız app_user (bakım görevi); PUBLIC ve app_admin yok", async () => {
    for (const [fn, role] of Object.entries(NEW_FUNCTIONS)) {
      const acl = (
        await query(
          `select coalesce(proacl::text, '') a from pg_proc where proname = '${fn}' and pronamespace = 'public'::regnamespace`,
        )
      )[0].a as string;
      const grantees = [...acl.matchAll(/([a-z_]*)=X/g)]
        .map((m) => m[1])
        .filter((g) => g !== "app_migrator");
      expect(grantees, fn).toEqual([role]);
    }
  });

  it("rezervasyon fonksiyonları ve tabloları 0073'te değişmez (gövde md5 dahil)", () => {
    const touched = [...S2]
      .filter((s) => !S1.has(s))
      .filter((s) => /reservation|propert|external|ical|api_|webhook/i.test(s.split("(")[0]!));
    expect(touched.filter((s) => !s.startsWith("F|app_option_"))).toEqual([]);
  });
});

describe("Aşama 3e: geri alma ve yeniden migration", () => {
  it("geri alma 0072 şemasını birebir getirir (iki kez de); yeniden migration 0073'ü", async () => {
    expect(await migrationCount()).toBe(74);
    expect(runRollback()).toBe("ok");
    expect(await migrationCount()).toBe(73);
    expect(minus(S1, await snapshot())).toEqual([]);
    expect(minus(await snapshot(), S1)).toEqual([]);
    expect(runRollback()).toBe("ok");
    expect(minus(await snapshot(), S1)).toEqual([]);
    await runMigrations({ url: migratorUrl(), appEnv: "test", migrationsFolder: tmp3e });
    const S3 = await snapshot();
    expect(minus(S2, S3)).toEqual([]);
    expect(minus(S3, S2)).toEqual([]);
    expect(await migrationCount()).toBe(74);
  });

  it("0073 geri alınmadan 0072 geri alınamaz", () => {
    expect(runRollbackFile(path.resolve(__dirname, "../../docs/rollback-0072.sql"))).toMatch(
      /rollback_0072_blocked/,
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
