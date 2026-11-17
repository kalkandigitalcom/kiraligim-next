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
 * Opsiyon — 0075 (Faz A: varsayılan süre) katalog kanıtı, veri koruması ve geri alma.
 *
 * Ayrı, geçici bir veritabanında: migration'lar 0074'e kadar + production türü veri → S1 / D1;
 * 0075 → S2. 0075 YALNIZ planlanan nesneleri değiştirir: app_wa_option_apply gövdesi (imza,
 * SECURITY DEFINER, sahip, search_path ve yetkiler aynı), üç yeni fonksiyon (Super Admin: app_admin;
 * işletme sahibi: app_user), option_automation_global'e iki sütun ve bir kısıt, üç kısıtın değer
 * listesi ('clarify', 'system_default' eklenir). Worker, ağ geçidi, rezervasyon, API, iCal,
 * webhook ve diğer TÜM fonksiyon / tablo / indeks / politika / tetikleyiciler birebir aynı; mevcut
 * veri değişmez. docs/rollback-0075.sql S1'i ve veriyi birebir geri getirir; geri alınamayacak
 * (clarify / system_default) kayıt varsa durur.
 */
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? "";
const dbName = `opt075_${randomBytes(4).toString("hex")}_test`;
// Roller (app_migrator, app_user) veritabanına değil KÜMEYE aittir: db-bootstrap.sql parolalarını
// küme genelinde yeniler. Ana test kurulumunun parolaları kullanılmazsa diğer test dosyalarının
// bağlantıları parola doğrulamasında reddedilir (CI: scram-sha-256).
const { migratorPassword, appPassword } = inject("testDb");
const folder = path.resolve(__dirname, "../../drizzle");
const rollback = path.resolve(__dirname, "../../docs/rollback-0075.sql");
let tmp: string;
/** 0075'e kadar: sonraki aşamalar bu dosyanın kanıtını değiştirmez. */
let tmp75: string;

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opt075-"));
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

/**
 * Production'daki türden mevcut veri (0074 şemasında): işletme varsayılanlı açık opsiyon, süresiz
 * Super Admin onayı bekleyen oluşturma ve onaylanmış iptal. Fikstür üst kayıtsız eklenir
 * (session_replication_role = replica: yalnız bu ayrı veritabanında, yalnız veri kanıtı için).
 */
const IDS = {
  ws: "0190a1b2-0000-7000-8000-000000000001",
  prop: "0190a1b2-0000-7000-8000-000000000002",
  group: "0190a1b2-0000-7000-8000-000000000003",
  opt: "0190a1b2-0000-7000-8000-000000000004",
  op1: "0190a1b2-0000-7000-8000-000000000005",
  op2: "0190a1b2-0000-7000-8000-000000000006",
  op3: "0190a1b2-0000-7000-8000-000000000007",
};
async function seedLegacy() {
  await query(`
    set session_replication_role = replica;
    insert into reservation_options (id, workspace_id, property_id, source, group_id, origin_wa_message_id,
                                     check_in, check_out, expires_at, expiry_source)
    values ('${IDS.opt}', '${IDS.ws}', '${IDS.prop}', 'whatsapp', '${IDS.group}', 'WA1',
            '2026-12-20', '2026-12-23', '2026-11-19 12:48:42+00', 'workspace_default');
    insert into option_operations (id, workspace_id, kind, mode, status, source, group_id, wa_message_id,
                                   item_no, property_id, check_in, check_out, reasons)
    values ('${IDS.op1}', '${IDS.ws}', 'create', 'needs_approval', 'pending', 'whatsapp', '${IDS.group}',
            'WA2', 0, '${IDS.prop}', '2027-10-17', '2027-10-21', '{date_unclear,duration_missing}'),
           ('${IDS.op2}', '${IDS.ws}', 'convert', 'needs_approval', 'pending', 'whatsapp', '${IDS.group}',
            'WA3', 0, '${IDS.prop}', '2026-12-20', '2026-12-23', '{date_missing,guest_info_missing}');
    insert into option_operations (id, workspace_id, kind, mode, status, source, group_id, wa_message_id,
                                   item_no, property_id, expires_in_minutes, expiry_source, applied_at)
    values ('${IDS.op3}', '${IDS.ws}', 'create', 'auto', 'applied', 'whatsapp', '${IDS.group}', 'WA4', 0,
            '${IDS.prop}', 2880, 'message', '2026-11-17 13:03:04+00');
    set session_replication_role = origin;`);
}
const dataView = async () =>
  (
    await query(`
      select 'O|' || o::text s from reservation_options o
      union all select 'P|' || p::text from option_operations p
      union all select 'W|' || w::text from workspace_option_settings w
      union all select 'E|' || e::text from reservation_option_events e
      order by 1`)
  ).map((r) => r.s as string);

const APPLY = "app_wa_option_apply(p_message uuid, p_items jsonb)";
const NEW_FUNCTIONS = [
  "app_option_admin_default_duration(p_admin uuid)",
  "app_option_admin_set_default_duration(p_admin uuid, p_minutes integer)",
  "app_option_owner_set_default(p_minutes integer)",
];

let S1: Set<string>;
let S2: Set<string>;
let D1: string[];

beforeAll(async () => {
  const res = runBootstrap({ dbName, migratorPassword, appPassword });
  if (res.status !== 0) throw new Error(`db-bootstrap.sql başarısız:\n${res.output}`);
  tmp = truncatedFolder(74);
  tmp75 = truncatedFolder(75);
  await runMigrations({ url: migratorUrl(), appEnv: "test", migrationsFolder: tmp });
  await seedLegacy();
  S1 = await snapshot();
  D1 = await dataView();
  await runMigrations({ url: migratorUrl(), appEnv: "test", migrationsFolder: tmp75 });
  S2 = await snapshot();
}, 180_000);

afterAll(async () => {
  const c = new Client({ connectionString: ADMIN_URL });
  await c.connect();
  await c.query(`drop database if exists "${dbName}" with (force)`);
  await c.end();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  if (tmp75) fs.rmSync(tmp75, { recursive: true, force: true });
});

const kindOf = (x: string) => x.split("|")[0];
const fnName = (x: string) => x.split("|")[1];

describe("0075: değişen nesneler tam olarak planlananlar", () => {
  it("fonksiyonlar: yalnız app_wa_option_apply gövdesi değişir + üç yeni fonksiyon; başka fonksiyon değişmez", () => {
    const removed = minus(S1, S2).filter((x) => kindOf(x) === "F");
    const added = minus(S2, S1).filter((x) => kindOf(x) === "F");
    expect(removed.map(fnName)).toEqual([APPLY]);
    expect(added.map(fnName).sort()).toEqual([APPLY, ...NEW_FUNCTIONS].sort());
    // app_wa_option_apply: yalnız gövde (md5) değişir; SECURITY DEFINER, sahip, search_path, yetkiler aynı.
    const meta = (x: string) => x.split("|").slice(0, -1).join("|");
    expect(meta(added.find((x) => fnName(x) === APPLY)!)).toBe(meta(removed[0]!));
    for (const f of NEW_FUNCTIONS) {
      const [, , definer, owner, config, acl] = added.find((x) => fnName(x) === f)!.split("|");
      expect(definer).toBe("true");
      expect(owner).toBe("app_migrator");
      expect(config).toBe('{"search_path=pg_catalog, pg_temp"}');
      const grantees = [...acl!.matchAll(/([a-z_]*)=X/g)]
        .map((m) => m[1])
        .filter((g) => g !== "app_migrator");
      expect(grantees).toEqual(f.startsWith("app_option_owner_") ? ["app_user"] : ["app_admin"]);
    }
  });

  it("tablolar: yalnız iki yeni sütun ve dört kısıt; tablo, indeks, politika, tetikleyici değişmez", () => {
    const removed = minus(S1, S2).filter((x) => kindOf(x) !== "F");
    const added = minus(S2, S1).filter((x) => kindOf(x) !== "F");
    expect(removed.map((x) => x.split("|").slice(0, 3).join("|"))).toEqual([
      "K|option_operations|option_operations_mode_check",
      "K|option_operations|option_operations_values",
      "K|reservation_options|reservation_options_expiry",
    ]);
    expect(added.map((x) => x.split("|").slice(0, 3).join("|"))).toEqual([
      "C|option_automation_global|default_duration_minutes",
      "C|option_automation_global|default_duration_updated_at",
      "K|option_automation_global|option_automation_global_default_duration",
      "K|option_operations|option_operations_mode_check",
      "K|option_operations|option_operations_values",
      "K|reservation_options|reservation_options_expiry",
    ]);
    const s2 = [...S2].join("\n");
    expect(s2).toMatch(
      /C\|option_automation_global\|default_duration_minutes\|integer\|true\|1440/,
    );
    expect(s2).toMatch(
      /option_operations_mode_check\|CHECK \(\(mode = ANY \(ARRAY\['auto'::text, 'needs_approval'::text, 'clarify'::text\]\)\)\)/,
    );
    // Kısıt metinleri yalnız yeni değerleri ekler (eski değerlerin hepsi durur).
    const k1 = removed.find((x) => x.includes("option_operations_values"))!;
    const k2 = added.find((x) => x.includes("option_operations_values"))!;
    expect(k2.replace(", 'system_default'::text", "")).toBe(k1);
    const e1 = removed.find((x) => x.includes("reservation_options_expiry"))!;
    const e2 = added.find((x) => x.includes("reservation_options_expiry"))!;
    expect(e2.replace(", 'system_default'::text", "")).toBe(e1);
  });

  it("mevcut veri birebir korunur (opsiyon bitişleri, bekleyen işlemler, olaylar); sistem varsayılanı 24 saat", async () => {
    expect(await dataView()).toEqual(D1);
    expect(
      await query(
        "select enabled, default_duration_minutes, default_duration_updated_at from option_automation_global",
      ),
    ).toEqual([
      { enabled: false, default_duration_minutes: 1440, default_duration_updated_at: null },
    ]);
  });

  it("ağ geçidi rolü yeni fonksiyonları çağıramaz", async () => {
    const exists = (await query("select to_regrole('app_wa_gateway') is not null e"))[0].e;
    if (!exists) return;
    for (const f of [
      "app_option_admin_default_duration(uuid)",
      "app_option_admin_set_default_duration(uuid, integer)",
      "app_option_owner_set_default(integer)",
    ]) {
      expect(
        (
          await query(`select has_function_privilege('app_wa_gateway', 'public.${f}', 'EXECUTE') p`)
        )[0].p,
      ).toBe(false);
    }
  });
});

describe("0075: geri alma ve yeniden migration", () => {
  it("açıklama bekleyen / sistem varsayılanlı kayıt varken geri alma DURUR, veri değişmez", async () => {
    await query(`
      set session_replication_role = replica;
      insert into option_operations (id, workspace_id, kind, mode, status, source, group_id, wa_message_id,
                                     item_no, property_id, reasons)
      values ('0190a1b2-0000-7000-8000-0000000000aa', '${IDS.ws}', 'create', 'clarify', 'pending', 'whatsapp',
              '${IDS.group}', 'WA9', 0, '${IDS.prop}', '{villa_unclear}');
      set session_replication_role = origin;`);
    expect(runRollback()).toMatch(/rollback_0075_blocked/);
    expect(await migrationCount()).toBe(76);
    await query(`
      set session_replication_role = replica;
      delete from option_operations where id = '0190a1b2-0000-7000-8000-0000000000aa';
      set session_replication_role = origin;`);
  });

  it("geri alma 0074 şemasını ve verisini birebir getirir (iki kez de); yeniden migration 0075'i", async () => {
    expect(await migrationCount()).toBe(76);
    expect(runRollback()).toBe("ok");
    expect(await migrationCount()).toBe(75);
    expect(minus(S1, await snapshot())).toEqual([]);
    expect(minus(await snapshot(), S1)).toEqual([]);
    expect(await dataView()).toEqual(D1);
    expect(runRollback()).toBe("ok");
    expect(minus(await snapshot(), S1)).toEqual([]);
    await runMigrations({ url: migratorUrl(), appEnv: "test", migrationsFolder: tmp75 });
    const S3 = await snapshot();
    expect(minus(S2, S3)).toEqual([]);
    expect(minus(S3, S2)).toEqual([]);
    expect(await migrationCount()).toBe(76);
    expect(await dataView()).toEqual(D1);
  });

  it("0075 geri alınmadan 0074 geri alınamaz", () => {
    expect(runRollbackFile(path.resolve(__dirname, "../../docs/rollback-0074.sql"))).toMatch(
      /rollback_0074_blocked/,
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
