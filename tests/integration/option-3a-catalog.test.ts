import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/db/migrate";
import { runBootstrap } from "./psql";

/**
 * Opsiyon Aşama 3a — mevcut sistemin değişmediğinin KATALOG kanıtı ve geri alma (0066–0070).
 *
 * Ayrı, geçici bir veritabanında:
 *   1. migration'lar 0065'e kadar uygulanır → katalog görüntüsü S0 (production'daki 88ae8c1 şeması);
 *   2. 0066–0069 uygulanır → S1. S0'daki HER nesne (fonksiyon gövdesi, yetkisi, sahibi, tablo,
 *      sütun, kısıt, indeks, politika, tetikleyici, tablo yetkisi) S1'de birebir durur; tek
 *      istisna onaylanan A2 opsiyon nesneleridir (iptal nedeni kısıtı, üç A2 tetikleyici
 *      fonksiyonu). S1'e eklenen her şey bir opsiyon nesnesidir;
 *   3. docs/rollback-0066-0069.sql → S0 ile BİREBİR aynı; ikinci kez çalıştırılınca da aynı;
 *   4. yeniden migration → S1 ile birebir aynı; opsiyon kaydı varken geri alma engellenir.
 */
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? "";
const dbName = `opt3a_${randomBytes(4).toString("hex")}_test`;
const migratorPassword = randomBytes(24).toString("hex");
const appPassword = randomBytes(24).toString("hex");
const folder = path.resolve(__dirname, "../../drizzle");
const rollback3a = path.resolve(__dirname, "../../docs/rollback-0066-0069.sql");
const rollbackFk = path.resolve(__dirname, "../../docs/rollback-0070.sql");
let tmp: string;
/** 0070'e kadar (Aşama 3a'nın son migration'ı): sonraki aşamalar bu dosyanın kanıtını değiştirmez. */
let tmp3a: string;

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

/** 0065'e kadar kesilmiş migration klasörü (production'daki son sürüm). */
function truncatedFolder(lastIdx: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opt3a-"));
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

/** Şemanın karşılaştırılabilir görüntüsü (oid ve zaman bilgisi içermez). */
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

function runRollback(file: string): string {
  try {
    execFileSync("psql", [migratorUrl(), "-X", "-v", "ON_ERROR_STOP=1", "-1", "-q", "-f", file], {
      stdio: "pipe",
    });
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

let S0: Set<string>;
let S1: Set<string>;

beforeAll(async () => {
  const res = runBootstrap({ dbName, migratorPassword, appPassword });
  if (res.status !== 0) throw new Error(`db-bootstrap.sql başarısız:\n${res.output}`);
  tmp = truncatedFolder(65);
  tmp3a = truncatedFolder(70);
  await runMigrations({ url: migratorUrl(), appEnv: "test", migrationsFolder: tmp });
  S0 = await snapshot();
  await runMigrations({ url: migratorUrl(), appEnv: "test", migrationsFolder: tmp3a });
  S1 = await snapshot();
}, 180_000);

afterAll(async () => {
  const c = new Client({ connectionString: ADMIN_URL });
  await c.connect();
  await c.query(`drop database if exists "${dbName}" with (force)`);
  await c.end();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  if (tmp3a) fs.rmSync(tmp3a, { recursive: true, force: true });
});

describe("Aşama 3a: mevcut şema değişmez (katalog kanıtı)", () => {
  it("0065 şemasındaki her nesne aynen kalır; yalnız onaylanan A2 opsiyon nesneleri değişir", () => {
    const changed = minus(S0, S1);
    const allowed = [
      /^F\|app_reservation_options_guard\(\)\|/,
      /^F\|app_reservation_options_history\(\)\|/,
      /^F\|app_reservation_option_events_guard\(\)\|/,
      /^K\|reservation_options\|reservation_options_end_state\|/,
      // 0070: iki A2 opsiyon tablosunun grup anahtarı bileşikten yalnız group_id'ye
      /^K\|reservation_options\|reservation_options_group_fk\|/,
      /^K\|wa_option_shadow_decisions\|wa_option_shadow_decisions_group_fk\|/,
    ];
    const unexpected = changed.filter((s) => !allowed.some((r) => r.test(s)));
    expect(unexpected).toEqual([]);
    expect(changed).toHaveLength(6);
    // 0070 sonrası iki anahtar yalnız grup kimliğine bağlı (ON DELETE RESTRICT aynı).
    const fk = [...S1].filter(
      (x) =>
        /_group_fk\|/.test(x) && /^K\|(reservation_options|wa_option_shadow_decisions)\|/.test(x),
    );
    expect(fk).toEqual([
      "K|reservation_options|reservation_options_group_fk|FOREIGN KEY (group_id) REFERENCES wa_groups(id) ON DELETE RESTRICT",
      "K|wa_option_shadow_decisions|wa_option_shadow_decisions_group_fk|FOREIGN KEY (group_id) REFERENCES wa_groups(id) ON DELETE RESTRICT",
    ]);
  });

  it("eklenen her nesne bir opsiyon nesnesidir (mevcut tablolara yalnız 'option' politikaları)", () => {
    const added = minus(S1, S0);
    expect(added.length).toBeGreaterThan(50);
    const notOption = added.filter((s) => !/option/.test(s.split("|").slice(0, 3).join("|")));
    expect(notOption).toEqual([]);
    // Mevcut tablolara eklenen tek şey üç politika (yalnız app.option_fn ve "option.%" eylemleri).
    const onExisting = added.filter((s) =>
      /^P\|(admin_users|admin_audit_log|audit_log|reservations|external_calendar_events|wa_groups|wa_inbound_messages|wa_message_reactions|workspaces|properties)\|/.test(
        s,
      ),
    );
    expect(onExisting.map((s) => s.split("|").slice(0, 3).join("|"))).toEqual([
      "P|admin_audit_log|admin_audit_log_option_fn",
      "P|admin_users|admin_users_option_fn",
      "P|audit_log|audit_log_option_fn",
    ]);
    for (const s of onExisting) expect(s).toMatch(/app\.option_fn/);
  });

  it("korunan fonksiyonlar birebir aynı: worker, ayrıştırıcı kuyruğu, tepki, otomatik işlem, doluluk, iCal, API, webhook", () => {
    const fns = (set: Set<string>) =>
      [...set].filter((s) =>
        /^F\|app_(wa_(?!option)|api_|ical|public_villa|reservation(?!_option))/.test(s),
      );
    expect(fns(S1)).toEqual(fns(S0));
    expect(fns(S0).length).toBeGreaterThan(40);
  });
});

describe("Aşama 3a: geri alma ve yeniden migration", () => {
  it("geri alma 0065 şemasını birebir geri getirir; ikinci çalıştırma da aynı; yeniden migration 0069 şemasını", async () => {
    expect(await migrationCount()).toBe(71);
    // Sıra: önce 0070, sonra 0066–0069. 0070 önce geri alınmadan 3a geri alınamaz.
    expect(runRollback(rollback3a)).toMatch(/rollback_0066_0069_blocked/);
    expect(runRollback(rollbackFk)).toBe("ok");
    expect(await migrationCount()).toBe(70);
    const fk0 = (set: Set<string>) => [...set].filter((x) => /_group_fk\|/.test(x)).sort();
    expect(fk0(await snapshot())).toEqual(fk0(S0).concat().sort());
    expect(runRollback(rollback3a)).toBe("ok");
    expect(minus(S0, await snapshot())).toEqual([]);
    expect(minus(await snapshot(), S0)).toEqual([]);
    expect(await migrationCount()).toBe(66);
    expect(runRollback(rollbackFk)).toBe("ok");
    expect(runRollback(rollback3a)).toBe("ok");
    expect(minus(await snapshot(), S0)).toEqual([]);
    expect(minus(S0, await snapshot())).toEqual([]);
    await runMigrations({ url: migratorUrl(), appEnv: "test", migrationsFolder: tmp3a });
    const S3 = await snapshot();
    expect(minus(S1, S3)).toEqual([]);
    expect(minus(S3, S1)).toEqual([]);
    expect(await migrationCount()).toBe(71);
  });

  it("opsiyon kaydı varken geri alma hiçbir şey yapmadan durur", async () => {
    const ws = (await query("select id from workspaces limit 1"))[0];
    if (!ws) {
      // Boş veritabanı: işletme / villa oluşturmadan kısıtı aşmak için tetikleyicisiz ekleme.
      await query(`
        set session_replication_role = replica;
        insert into reservation_options (id, workspace_id, property_id, source, check_in, check_out)
        values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'panel', '2027-01-01', '2027-01-03');`);
    }
    const before = await snapshot();
    expect(runRollback(rollbackFk)).toBe("ok");
    expect(runRollback(rollback3a)).toMatch(/rollback_0066_0069_blocked/);
    expect(await migrationCount()).toBe(70);
    await runMigrations({ url: migratorUrl(), appEnv: "test", migrationsFolder: tmp3a });
    expect(minus(before, await snapshot())).toEqual([]);
    expect(await migrationCount()).toBe(71);
  });
});
