import { randomBytes } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { runWaGatewayRole } from "./psql";

/**
 * scripts/wa-gateway-role.sql: WhatsApp ağ geçidinin ayrı rolü (app_wa_gateway). Gerçek psql ile
 * çalıştırılır. Rol yalnız ağ geçidi app_wa_* fonksiyonlarını çalıştırabilmeli (A1.1: eski kodlu
 * bağlama ve panel fonksiyonları hariç); hiçbir tabloyu okuyamamalı.
 * Rol küme genelinde olduğu için test sonunda yetkileri geri alınıp rol silinir (diğer testlerin
 * yetki listeleri etkilenmesin).
 */
const db = inject("testDb");
const admin = new Client({ connectionString: db.adminUrl });
const password = randomBytes(24).toString("hex");

const gatewayUrl = (pw = password) => {
  const u = new URL(db.adminUrl);
  u.username = "app_wa_gateway";
  u.password = pw;
  return u.toString();
};

let gw: Client;
const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { code?: string }) => e.code ?? "error",
  );

beforeAll(async () => {
  await admin.connect();
});

afterAll(async () => {
  await gw?.end().catch(() => {});
  await admin.query(
    "select pg_terminate_backend(pid) from pg_stat_activity where usename = 'app_wa_gateway'",
  );
  await admin.query(`
    do $$ begin
      if exists (select 1 from pg_roles where rolname = 'app_wa_gateway') then
        revoke execute on function
          public.app_wa_heartbeat(text, text, text),
          public.app_wa_heartbeat(text, text, text, text),
          public.app_wa_sync_group(uuid, text, text, integer, boolean, boolean, boolean),
          public.app_wa_sync_group(uuid, text, text, integer, boolean, boolean, boolean, text, text),
          public.app_wa_redeem_link_code(uuid, text, text, text),
          public.app_wa_ingest_message(uuid, text, text, text, text, text, text, timestamptz, text),
          public.app_wa_purge_messages(integer),
          public.app_wa_verify_phone(text, text)
          from app_wa_gateway;
        revoke usage on schema public from app_wa_gateway;
        execute format('revoke connect on database %I from app_wa_gateway', current_database());
        drop role app_wa_gateway;
      end if;
    end $$`);
  await admin.end();
});

describe("app_wa_gateway rol betiği", () => {
  it("eksik/zayıf parola ve yanlış veritabanı adı reddedilir", () => {
    const none = runWaGatewayRole({ dbName: db.dbName });
    expect(none.status).not.toBe(0);
    expect(none.output).toMatch(/KG_WA_GATEWAY_PASSWORD/);
    const weak = runWaGatewayRole({ dbName: db.dbName, password: "kisa-parola" });
    expect(weak.status).not.toBe(0);
    expect(weak.output).toMatch(/en az 32 karakter/);
    const name = runWaGatewayRole({ dbName: "kiraligim", password });
    expect(name.status).not.toBe(0);
    expect(name.output).toMatch(/_dev, _prod veya _test/);
  });

  it("rolü oluşturur; parola çıktıda görünmez; tekrar çalıştırılabilir", async () => {
    const res = runWaGatewayRole({ dbName: db.dbName, password });
    expect(res.output).toContain("Tamam: app_wa_gateway rolü hazır");
    expect(res.status).toBe(0);
    expect(res.output).not.toContain(password);
    expect(runWaGatewayRole({ dbName: db.dbName, password }).status).toBe(0);

    const role = (
      await admin.query(`
        select rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolinherit, rolreplication,
               rolcanlogin, rolconnlimit,
               has_database_privilege('app_wa_gateway', current_database(), 'CONNECT') as can_connect,
               has_database_privilege('app_wa_gateway', current_database(), 'TEMPORARY') as can_temp,
               has_schema_privilege('app_wa_gateway', 'public', 'CREATE') as can_create
          from pg_roles where rolname = 'app_wa_gateway'`)
    ).rows[0];
    expect(role).toEqual({
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolbypassrls: false,
      rolinherit: false,
      rolreplication: false,
      rolcanlogin: true,
      rolconnlimit: 5,
      can_connect: true,
      can_temp: false,
      can_create: false,
    });

    // Hiçbir tablo, görünüm veya dizide yetkisi yok; uygulama fonksiyonlarından (app_*) yalnız
    // ağ geçidi fonksiyonlarında EXECUTE (btree_gist gibi eklenti fonksiyonları PUBLIC'tir; veri erişimi vermez).
    const tables = await admin.query(`
      select c.relname from pg_class c
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v', 'm', 'S', 'p')
         and (has_table_privilege('app_wa_gateway', c.oid, 'SELECT')
              or has_table_privilege('app_wa_gateway', c.oid, 'INSERT')
              or has_table_privilege('app_wa_gateway', c.oid, 'UPDATE')
              or has_table_privilege('app_wa_gateway', c.oid, 'DELETE'))`);
    expect(tables.rows).toEqual([]);
    const fns = await admin.query(`
      select p.proname from pg_proc p
       where p.pronamespace = 'public'::regnamespace and p.proname like 'app\\_%'
         and has_function_privilege('app_wa_gateway', p.oid, 'EXECUTE')
       order by 1`);
    expect(fns.rows.map((r) => r.proname)).toEqual([
      "app_wa_heartbeat",
      "app_wa_heartbeat",
      "app_wa_ingest_message",
      "app_wa_purge_messages",
      "app_wa_sync_group",
      "app_wa_sync_group",
      "app_wa_verify_phone",
    ]);
  });

  it("ağ geçidi fonksiyonları çalışır; tablolar, panel fonksiyonları ve işletme verisi kapalı", async () => {
    gw = new Client({ connectionString: gatewayUrl() });
    await gw.connect();
    const me = (await gw.query("select current_user as u, current_database() as d")).rows[0];
    expect(me).toEqual({ u: "app_wa_gateway", d: db.dbName });

    const conn = (await gw.query("select public.app_wa_heartbeat('rol-testi', 'open', null) as id"))
      .rows[0].id;
    const jid = `120363${Date.now()}@g.us`;
    expect(
      (
        await gw.query(
          "select public.app_wa_sync_group($1, $2, 'Rol Testi', 3, false, false, true) as s",
          [conn, jid],
        )
      ).rows[0].s,
    ).toBe("discovered");
    expect(
      (
        await gw.query(
          "select public.app_wa_ingest_message($1, $2, 'r1', '1@lid', null, null, 'x', now(), 'live') as s",
          [conn, jid],
        )
      ).rows[0].s,
    ).toBe("ignored");
    // A1.1: yeni sürümler (4 parametreli kalp atışı, ekleyenli keşif, numara doğrulama).
    expect(
      (
        await gw.query(
          "select public.app_wa_heartbeat('rol-testi', 'open', null, '905350000000') as id",
        )
      ).rows[0].id,
    ).toBe(conn);
    expect(
      (
        await gw.query(
          "select public.app_wa_sync_group($1, $2, 'Rol Testi', 3, false, false, true, '905399999901', null) as s",
          [conn, jid],
        )
      ).rows[0].s,
    ).toBe("discovered");
    expect(
      (await gw.query("select public.app_wa_verify_phone('ABCDEFGH', null) as s")).rows[0].s,
    ).toBe("invalid");
    // Eski kodlu bağlama ve panel fonksiyonları ağ geçidine kapalı.
    for (const q of [
      ["select public.app_wa_redeem_link_code($1, $2, 'ABCDEFGH', null)", [conn, jid]],
      ["select * from public.app_wa_pending_groups()", []],
      ["select public.app_wa_claim_group(gen_random_uuid(), gen_random_uuid())", []],
      ["select public.app_wa_phone_hash('905399999901')", []],
      ["select * from wa_verified_phones", []],
      ["select * from wa_phone_challenges", []],
    ] as const) {
      expect([q[0], await code(gw.query(q[0], [...q[1]]))]).toEqual([q[0], "42501"]);
    }
    expect(typeof (await gw.query("select public.app_wa_purge_messages(90) as n")).rows[0].n).toBe(
      "number",
    );
    expect(await code(gw.query("select public.app_wa_purge_messages(30)"))).toBe("23514");

    for (const q of [
      "select * from wa_groups",
      "select * from wa_inbound_messages",
      "select * from wa_link_codes",
      "select * from wa_connections",
      "select * from workspaces",
      "select * from users",
      "select * from reservations",
      "select * from property_rates",
      "select * from audit_log",
      "insert into wa_groups (id) values (gen_random_uuid())",
      "select public.app_wa_unlink_group(gen_random_uuid())",
      "select public.app_wa_can_manage()",
      "create temp table t (x int)",
      "create table public.t (x int)",
    ]) {
      expect([q, await code(gw.query(q))]).toEqual([q, "42501"]);
    }
    // İşletme bağlamı ayarlamak hiçbir şey açmaz (tablo yetkisi yok).
    await gw.query("select set_config('app.user_id', gen_random_uuid()::text, false)");
    expect(await code(gw.query("select count(*) from wa_inbound_messages"))).toBe("42501");
    await gw.end();
  });

  it("parola yeniden çalıştırmayla değişir; eski parola reddedilir", async () => {
    const next = randomBytes(24).toString("hex");
    expect(runWaGatewayRole({ dbName: db.dbName, password: next }).status).toBe(0);
    const old = new Client({ connectionString: gatewayUrl(password) });
    expect(await code(old.connect())).toBe("28P01");
    await old.end().catch(() => {});
    const fresh = new Client({ connectionString: gatewayUrl(next) });
    await fresh.connect();
    expect((await fresh.query("select current_user as u")).rows[0].u).toBe("app_wa_gateway");
    await fresh.end();
  });
});
