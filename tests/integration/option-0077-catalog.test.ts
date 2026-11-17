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
 * Opsiyon Faz B — 0077 (uzatma / tarih değişikliği) katalog kanıtı, veri koruması ve geri alma.
 *
 * Ayrı, geçici bir veritabanında: migration'lar 0076'ya kadar + production türü veri (açık
 * opsiyonlar, bekleyen / açıklama bekleyen / uygulanmış işlemler, işletme ayar satırı) → S1 / D1;
 * 0077 → S2. 0077 YALNIZ: app_wa_option_apply ve üç opsiyon tetikleyici fonksiyonunun gövdesi
 * (imza, SECURITY DEFINER, sahip, search_path, yetkiler aynı); iki yeni boş sütun
 * (reservation_options.replaces_option_id, reservation_option_events.expires_at), bağlantının
 * FK'sı ve tekil indeksi; üç kısıtın değer listeleri (+ extend / reschedule, + date_changed).
 * Mevcut satırlar değişmez. Politika, tetikleyici, başka fonksiyon değişmez.
 * docs/rollback-0077.sql S1'i birebir geri getirir; tekrar çalıştırılabilir; Faz B verisi varsa
 * hiçbir şey değiştirmeden durur; 0077 geri alınmadan 0076 geri alınamaz.
 */
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? "";
const dbName = `opt077_${randomBytes(4).toString("hex")}_test`;
// Roller (app_migrator, app_user) veritabanına değil KÜMEYE aittir: db-bootstrap.sql parolalarını
// küme genelinde yeniler. Ana test kurulumunun parolaları kullanılmazsa diğer test dosyalarının
// bağlantıları parola doğrulamasında reddedilir (CI: scram-sha-256).
const { migratorPassword, appPassword } = inject("testDb");
const folder = path.resolve(__dirname, "../../drizzle");
const rollback = path.resolve(__dirname, "../../docs/rollback-0077.sql");
let tmp: string;
/** 0077'ye kadar: sonraki aşamalar bu dosyanın kanıtını değiştirmez. */
let tmp77: string;

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opt077-"));
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
 * Production'daki türden mevcut veri (0074–0076 türleri): işletme varsayılanlı açık opsiyon, süresiz
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
  opt2: "0190a1b2-0000-7000-8000-000000000008",
  op4: "0190a1b2-0000-7000-8000-000000000009",
  op5: "0190a1b2-0000-7000-8000-00000000000a",
  opt3: "0190a1b2-0000-7000-8000-00000000000b",
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
    -- 0075 sonrası türler: sistem varsayılanlı opsiyon, açıklama bekleyen işlem, işletme ayarı.
    insert into reservation_options (id, workspace_id, property_id, source, group_id, origin_wa_message_id,
                                     check_in, check_out, expires_at, expiry_source)
    values ('${IDS.opt2}', '${IDS.ws}', '${IDS.prop}', 'whatsapp', '${IDS.group}', 'WA5',
            '2027-01-10', '2027-01-12', '2026-11-20 10:00:00+00', 'system_default');
    insert into option_operations (id, workspace_id, kind, mode, status, source, group_id, wa_message_id,
                                   item_no, property_id, check_in, check_out, reasons, expires_in_minutes,
                                   expiry_source)
    values ('${IDS.op4}', '${IDS.ws}', 'create', 'clarify', 'pending', 'whatsapp', '${IDS.group}', 'WA6',
            0, '${IDS.prop}', '2026-12-01', '2026-12-03', '{villa_unclear}', 1440, 'system_default');
    insert into workspace_option_settings (workspace_id, default_duration_minutes, duration_choices)
    values ('${IDS.ws}', 2880, '{1440,2880}');
    set session_replication_role = origin;`);
}
const dataView = async () =>
  (
    await query(`
      select 'O|' || (to_jsonb(o) - 'replaces_option_id')::text s from reservation_options o
      union all select 'P|' || to_jsonb(p)::text from option_operations p
      union all select 'W|' || to_jsonb(w)::text from workspace_option_settings w
      union all select 'E|' || (to_jsonb(e) - 'expires_at')::text from reservation_option_events e
      order by 1`)
  ).map((r) => r.s as string);

const CHANGED_FUNCTIONS = [
  "app_wa_option_apply(p_message uuid, p_items jsonb)",
  "app_reservation_options_guard()",
  "app_reservation_options_history()",
  "app_reservation_option_events_guard()",
].sort();
const LINKS = "app_option_admin_option_links(p_admin uuid, p_option uuid)";

let S1: Set<string>;
let S2: Set<string>;
let D1: string[];

beforeAll(async () => {
  const res = runBootstrap({ dbName, migratorPassword, appPassword });
  if (res.status !== 0) throw new Error(`db-bootstrap.sql başarısız:\n${res.output}`);
  tmp = truncatedFolder(76);
  tmp77 = truncatedFolder(77);
  await runMigrations({ url: migratorUrl(), appEnv: "test", migrationsFolder: tmp });
  await seedLegacy();
  S1 = await snapshot();
  D1 = await dataView();
  await runMigrations({ url: migratorUrl(), appEnv: "test", migrationsFolder: tmp77 });
  S2 = await snapshot();
}, 180_000);

afterAll(async () => {
  const c = new Client({ connectionString: ADMIN_URL });
  await c.connect();
  await c.query(`drop database if exists "${dbName}" with (force)`);
  await c.end();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  if (tmp77) fs.rmSync(tmp77, { recursive: true, force: true });
});

const kindOf = (x: string) => x.split("|")[0];
const fnName = (x: string) => x.split("|")[1];

describe("0077: katalog farkı yalnız Faz B", () => {
  it("yalnız karar fonksiyonu ve üç tetikleyici fonksiyonunun gövdesi değişir (meta aynı); tek yeni fonksiyon Super Admin bağlantıları", () => {
    const removed = minus(S1, S2).filter((x) => kindOf(x) === "F");
    const added = minus(S2, S1).filter((x) => kindOf(x) === "F");
    expect(removed.map(fnName).sort()).toEqual(CHANGED_FUNCTIONS);
    expect(added.map(fnName).sort()).toEqual([...CHANGED_FUNCTIONS, LINKS].sort());
    const meta = (x: string) => x.split("|").slice(0, -1).join("|");
    for (const r of removed) {
      expect(meta(added.find((a) => fnName(a) === fnName(r))!)).toBe(meta(r));
    }
    // Yeni fonksiyon: SECURITY DEFINER, app_migrator, sabit search_path, YALNIZ app_admin.
    const links = added.find((a) => fnName(a) === LINKS)!.split("|");
    expect(links[2]).toBe("true");
    expect(links[3]).toBe("app_migrator");
    expect(links[4]).toBe('{"search_path=pg_catalog, pg_temp"}');
    expect(links[5]).toMatch(/app_admin=X\/app_migrator/);
    expect(links[5]).not.toMatch(/app_user|app_worker|=X\/app_migrator,=/);
  });

  it("şema: iki boş sütun, FK, tekil indeks ve üç kısıtın değer listesi; politika / tetikleyici aynı", () => {
    const removed = minus(S1, S2).filter((x) => kindOf(x) !== "F");
    const added = minus(S2, S1).filter((x) => kindOf(x) !== "F");
    const key = (x: string) => x.split("|").slice(0, 3).join("|");
    expect(removed.map(key).sort()).toEqual(
      [
        "K|option_operations|option_operations_kind_check",
        "K|option_operations|option_operations_values",
        "K|reservation_options|reservation_options_end_state",
      ].sort(),
    );
    expect(added.map(key).sort()).toEqual(
      [
        "C|reservation_option_events|expires_at",
        "C|reservation_options|replaces_option_id",
        "I|reservation_options_replaces_key|CREATE UNIQUE INDEX reservation_options_replaces_key ON public.reservation_options USING btree (replaces_option_id) WHERE (replaces_option_id IS NOT NULL)",
        "K|option_operations|option_operations_kind_check",
        "K|option_operations|option_operations_values",
        "K|reservation_options|reservation_options_end_state",
        "K|reservation_options|reservation_options_replaces_fk",
      ].sort(),
    );
    // Kısıtlar yalnız genişler: eski değer listesi aynen + yeni değerler.
    const def = (set: Set<string>, name: string) =>
      [...set].find((x) => x.startsWith(`K|`) && x.split("|")[2] === name)!;
    expect(def(S2, "option_operations_kind_check")).toContain("'extend'::text, 'reschedule'::text");
    for (const n of ["option_operations_values", "reservation_options_end_state"]) {
      expect(def(S2, n).replace(", 'date_changed'::text", "")).toBe(def(S1, n));
    }
    expect(def(S2, "reservation_options_replaces_fk")).toContain(
      "FOREIGN KEY (replaces_option_id, workspace_id) REFERENCES reservation_options(id, workspace_id) ON DELETE RESTRICT",
    );
    // Yeni sütunlar boş bırakılabilir, varsayılansız.
    for (const c of added.filter((x) => kindOf(x) === "C")) expect(c).toMatch(/\|false\|$/);
  });

  it("karar fonksiyonu: gönderen yeniden denetimi, iyimser kilit ve açıklama modu; oluşturma 24 saat aynen", async () => {
    const src = (
      await query(
        "select prosrc from pg_proc where proname = 'app_wa_option_apply' and pronamespace = 'public'::regnamespace",
      )
    )[0].prosrc as string;
    expect(src).toMatch(/v_minutes := 1440;/);
    expect(src).toContain("GREATEST(pg_catalog.now(), m.sent_at)");
    expect(src).toContain("public.app_wa_sender_block(m.group_id, m.sender_pn) IS NULL");
    expect(src).toContain("o.version = v_target_ver AND o.status = 'open'");
    expect(src).toContain("option_version_conflict");
    expect(src).toContain("v_t_created + interval '14 days'");
    expect(src).toMatch(/WHEN v_intent IN \('create', 'extend', 'reschedule'\) THEN 'clarify'/);
    expect(src).not.toMatch(/workspace_option_settings|default_duration_minutes/);
    // Denetim kaydı: yalnız uygulanan uzatma / tarih değişikliği; mesaj metni / telefon yazılmaz.
    expect(src).toContain("'option.extended'");
    expect(src).toContain("'option.rescheduled'");
    const auditSql = src.slice(src.indexOf("INSERT INTO public.audit_log"));
    expect(auditSql.slice(0, 1600)).not.toMatch(/body|sender_pn|guest_name|phone/);
  });

  it("mevcut veri birebir korunur; yeni sütunlar boş", async () => {
    expect(await dataView()).toEqual(D1);
    expect(
      (
        await query(
          "select count(*)::int n from reservation_options where replaces_option_id is not null",
        )
      )[0].n,
    ).toBe(0);
    expect(
      (
        await query(
          "select count(*)::int n from reservation_option_events where expires_at is not null",
        )
      )[0].n,
    ).toBe(0);
  });
});

describe("0077: geri alma ve yeniden migration", () => {
  it("geri alma 0076 şemasını ve verisini birebir getirir (iki kez de); yeniden migration 0077'yi", async () => {
    expect(await migrationCount()).toBe(78);
    expect(runRollback()).toBe("ok");
    expect(await migrationCount()).toBe(77);
    expect(minus(S1, await snapshot())).toEqual([]);
    expect(minus(await snapshot(), S1)).toEqual([]);
    expect(await dataView()).toEqual(D1);
    expect(runRollback()).toBe("ok");
    expect(minus(await snapshot(), S1)).toEqual([]);
    await runMigrations({ url: migratorUrl(), appEnv: "test", migrationsFolder: tmp77 });
    const S3 = await snapshot();
    expect(minus(S2, S3)).toEqual([]);
    expect(minus(S3, S2)).toEqual([]);
    expect(await migrationCount()).toBe(78);
    expect(await dataView()).toEqual(D1);
  });

  it("Faz B verisi varsa geri alma hiçbir şey değiştirmeden durur", async () => {
    for (const fixture of [
      `insert into option_operations (id, workspace_id, kind, mode, status, source, group_id, wa_message_id,
                                      item_no, property_id, reasons)
       values ('${IDS.op5}', '${IDS.ws}', 'extend', 'clarify', 'pending', 'whatsapp', '${IDS.group}', 'WA7',
               0, '${IDS.prop}', '{duration_missing}')`,
      `insert into reservation_options (id, workspace_id, property_id, source, group_id, origin_wa_message_id,
                                        check_in, check_out, expires_at, expiry_source, replaces_option_id)
       values ('${IDS.opt3}', '${IDS.ws}', '${IDS.prop}', 'whatsapp', '${IDS.group}', 'WA8',
               '2027-02-10', '2027-02-12', '2026-11-20 10:00:00+00', 'system_default', '${IDS.opt2}')`,
    ]) {
      await query(
        `set session_replication_role = replica; ${fixture}; set session_replication_role = origin;`,
      );
      expect(runRollback()).toMatch(/rollback_0077_blocked_data/);
      expect(minus(S2, await snapshot())).toEqual([]);
      expect(minus(await snapshot(), S2)).toEqual([]);
      expect(await migrationCount()).toBe(78);
      await query(`set session_replication_role = replica;
        delete from option_operations where id = '${IDS.op5}';
        delete from reservation_options where id = '${IDS.opt3}';
        set session_replication_role = origin;`);
    }
    expect(await dataView()).toEqual(D1);
  });

  it("0077 geri alınmadan 0076 geri alınamaz", () => {
    expect(runRollbackFile(path.resolve(__dirname, "../../docs/rollback-0076.sql"))).toMatch(
      /rollback_0076_blocked/,
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
