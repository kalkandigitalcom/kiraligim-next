import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

/**
 * 0006_tenancy_security: SECURITY DEFINER fonksiyonların sahipliği, search_path ve EXECUTE
 * yetkileri; RLS/FORCE bayrakları; politika listesi; tablo ve kolon yetkileri.
 */
const db = inject("testDb");
const admin = new Client({ connectionString: db.adminUrl });
const TABLES = ["audit_log", "workspace_members", "workspaces"];

beforeAll(() => admin.connect());
afterAll(() => admin.end());

describe("fonksiyonlar", () => {
  const fn = async () =>
    (
      await admin.query(`
        select p.proname, pg_get_userbyid(p.proowner) as owner, p.prosecdef as definer,
               p.provolatile as volatility, p.proconfig as config
          from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'app\\_%'
         order by 1`)
    ).rows;

  it("hepsinin sahibi app_migrator ve search_path sabit (pg_catalog, pg_temp)", async () => {
    const rows = await fn();
    expect(rows.map((r) => r.proname)).toEqual([
      "app_audit_log_immutable",
      "app_current_member_role",
      "app_current_membership_role",
      "app_current_user_id",
      "app_current_workspace_id",
      "app_current_workspace_unclaimed",
      // 0029 (3.1): iCal senkron (kilit, sonuç), dışa aktarma akışı, kaynak tetikleyicisi
      "app_ical_apply_sync",
      "app_ical_claim_sources",
      "app_ical_export",
      "app_ical_sources_before_write",
      "app_properties_enforce_limit",
      "app_property_photos_before_insert",
      "app_property_rates_currency_guard",
      // 0027 (F3): villa sayfasından rezervasyon talebi (tek yazma noktası)
      "app_public_reservation_request",
      // 0024 (F2a): public villa okuma fonksiyonları
      "app_public_villa",
      "app_public_villa_busy",
      "app_public_villa_photos",
      "app_public_villa_rates",
      "app_public_villa_visible",
      // 0029 (3.1): harici (iCal) doluluk çakışma tetikleyicisi
      "app_reservations_external_guard",
      "app_reservations_guard",
      "app_set_updated_at",
      "app_subscription_is_current",
      "app_uuid_v7",
      "app_workspace_members_keep_owner",
      "app_workspace_start_trial",
    ]);
    for (const r of rows) {
      expect(r.owner, r.proname).toBe("app_migrator");
      expect(r.config, r.proname).toEqual(["search_path=pg_catalog, pg_temp"]);
    }
  });

  it("yalnız üyelik aramaları, son owner koruması ve deneme aboneliği tetikleyicisi SECURITY DEFINER", async () => {
    const definers = (await fn()).filter((r) => r.definer).map((r) => r.proname);
    expect(definers).toEqual([
      "app_current_membership_role",
      "app_current_workspace_unclaimed",
      // 0029 (3.1): iCal senkronu ve dışa aktarma — tek yazma/okuma noktaları (kilit belirteciyle)
      "app_ical_apply_sync",
      "app_ical_claim_sources",
      "app_ical_export",
      // 0027 (F3): yayındaki villaya beklemede web talebi yazan tek fonksiyon
      "app_public_reservation_request",
      // 0024 (F2a): yalnız yayındaki villaların sabit kolonlarını döndüren okuma fonksiyonları
      "app_public_villa",
      "app_public_villa_busy",
      "app_public_villa_photos",
      "app_public_villa_rates",
      "app_public_villa_visible",
      // 0029 (3.1): harici doluluk tetikleyicisi her bağlamda (F3 dahil) olayları okuyabilmeli
      "app_reservations_external_guard",
      "app_workspace_members_keep_owner",
      "app_workspace_start_trial",
    ]);
  });

  it("SECURITY DEFINER bağlam fonksiyonları parametre almaz (başka workspace/kullanıcı sorgulanamaz)", async () => {
    const r = await admin.query(`
      select proname, pronargs from pg_proc
       where pronamespace = 'public'::regnamespace and prosecdef and prorettype <> 'trigger'::regtype
         and proname not like 'app\\_public\\_villa%'
         and proname <> 'app_public_reservation_request'
         and proname not like 'app\\_ical\\_%'
       order by 1`);
    expect(r.rows).toEqual([
      { proname: "app_current_membership_role", pronargs: 0 },
      { proname: "app_current_workspace_unclaimed", pronargs: 0 },
    ]);
    // 0024 (F2a): public okuma fonksiyonları parametre alır (adres / mülk kimliği / tarih), ancak
    // yalnız yayındaki ve görünür villaların sabit kolonlarını döndürür (tests/integration/public-villa.test.ts).
    const pub = await admin.query(`
      select proname, pronargs from pg_proc
       where pronamespace = 'public'::regnamespace and prosecdef and proname like 'app\\_public\\_villa%'
       order by 1`);
    expect(pub.rows).toEqual([
      { proname: "app_public_villa", pronargs: 1 },
      { proname: "app_public_villa_busy", pronargs: 3 },
      { proname: "app_public_villa_photos", pronargs: 1 },
      { proname: "app_public_villa_rates", pronargs: 1 },
      { proname: "app_public_villa_visible", pronargs: 1 },
    ]);
    // 0027 (F3): talep fonksiyonu sayfa adresi + form alanlarını alır; işletme/mülk kimliği ALMAZ
    // (veritabanında adresten bulunur). Ayrıntılı testler: tests/integration/reservation-request.test.ts.
    const req = await admin.query(`
      select pronargs, pg_get_function_identity_arguments(oid) as args from pg_proc
       where pronamespace = 'public'::regnamespace and proname = 'app_public_reservation_request'`);
    expect(req.rows).toEqual([
      {
        pronargs: 11,
        args: "p_id uuid, p_slug text, p_check_in date, p_check_out date, p_guests integer, p_name text, p_phone text, p_email text, p_note text, p_total_minor bigint, p_currency text",
      },
    ]);
  });

  it("EXECUTE: bağlam fonksiyonları yalnız app_user'da; tetikleyici fonksiyonları kimsede; PUBLIC'te hiçbiri", async () => {
    const r = await admin.query(`
      select p.proname,
             coalesce(array_agg(case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end order by 1)
                        filter (where a.grantee <> p.proowner), '{}') as grantees
        from pg_proc p left join lateral aclexplode(p.proacl) a on true
       where p.pronamespace = 'public'::regnamespace and p.proname like 'app\\_%'
       group by p.proname order by 1`);
    expect(Object.fromEntries(r.rows.map((x) => [x.proname, x.grantees]))).toEqual({
      app_audit_log_immutable: [],
      app_current_member_role: ["app_user"],
      app_current_membership_role: ["app_user"],
      app_current_user_id: ["app_user"],
      app_current_workspace_id: ["app_user"],
      app_current_workspace_unclaimed: ["app_user"],
      app_ical_apply_sync: ["app_user"],
      app_ical_claim_sources: ["app_user"],
      app_ical_export: ["app_user"],
      app_ical_sources_before_write: [],
      app_properties_enforce_limit: [],
      app_property_photos_before_insert: [],
      app_property_rates_currency_guard: [],
      app_public_reservation_request: ["app_user"],
      app_public_villa: ["app_user"],
      app_public_villa_busy: ["app_user"],
      app_public_villa_photos: ["app_user"],
      app_public_villa_rates: ["app_user"],
      app_public_villa_visible: [],
      app_reservations_external_guard: [],
      app_reservations_guard: [],
      app_set_updated_at: [],
      app_subscription_is_current: ["app_user"],
      app_uuid_v7: [],
      app_workspace_members_keep_owner: [],
      app_workspace_start_trial: [],
    });
  });

  it("geçici şemadaki sahte tablo SECURITY DEFINER fonksiyonu kandıramaz", async () => {
    const app = new Client({ connectionString: db.appUrl });
    await app.connect();
    try {
      await app.query("begin");
      // app_user TEMPORARY yetkisine sahip: pg_temp'te aynı adlı tablo oluşturup sahte rol döndürmeyi dener.
      await app.query(
        "create temp table workspace_members (workspace_id uuid, user_id uuid, role text)",
      );
      const ws = "00000000-0000-7000-8000-000000000001";
      const me = "00000000-0000-7000-8000-000000000002";
      await app.query("insert into pg_temp.workspace_members values ($1, $2, 'owner')", [ws, me]);
      await app.query(
        "select set_config('app.workspace_id', $1, true), set_config('app.user_id', $2, true)",
        [ws, me],
      );
      const r = await app.query(
        "select public.app_current_membership_role() as role, public.app_current_workspace_unclaimed() as unclaimed",
      );
      expect(r.rows[0]).toEqual({ role: null, unclaimed: true });
      await app.query("rollback");
    } finally {
      await app.end();
    }
  });

  it("app_user fonksiyon tanımını değiştiremez", async () => {
    const app = new Pool({ connectionString: db.appUrl, max: 1 });
    try {
      await expect(
        app.query(
          "create or replace function public.app_current_member_role() returns text language sql as $$ select 'owner' $$",
        ),
      ).rejects.toThrow(/permission denied|must be owner/);
    } finally {
      await app.end();
    }
  });
});

describe("RLS", () => {
  it("üç tabloda ENABLE ve FORCE açık", async () => {
    const r = await admin.query(
      "select relname, relrowsecurity, relforcerowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname = any($1) order by 1",
      [TABLES],
    );
    for (const row of r.rows)
      expect(row, row.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    expect(r.rowCount).toBe(3);
  });

  it("politikalar beklenen roller ve komutlarla tanımlı", async () => {
    const r = await admin.query(
      `select tablename, policyname, cmd, roles::text[] as roles from pg_policies
        where schemaname = 'public' and tablename = any($1) order by 1, 2`,
      [TABLES],
    );
    expect(r.rows.map((x) => [x.tablename, x.policyname, x.cmd, x.roles])).toEqual([
      ["audit_log", "audit_log_insert", "INSERT", ["app_user"]],
      ["audit_log", "audit_log_select", "SELECT", ["app_user"]],
      ["workspace_members", "members_delete", "DELETE", ["app_user"]],
      ["workspace_members", "members_insert", "INSERT", ["app_user"]],
      ["workspace_members", "members_migrator_lookup", "SELECT", ["app_migrator"]],
      ["workspace_members", "members_select", "SELECT", ["app_user"]],
      ["workspace_members", "members_update", "UPDATE", ["app_user"]],
      // 0029 (3.1): yalnız app.ical_export / app.ical_sync açıkken (dışa aktarma, cron)
      ["workspaces", "workspaces_ical_export_read", "SELECT", ["app_migrator"]],
      ["workspaces", "workspaces_ical_sync_read", "SELECT", ["app_migrator"]],
      ["workspaces", "workspaces_insert", "INSERT", ["app_user"]],
      // 0024 (F2a): yalnız app.public_read açıkken, yayındaki villaların işletmeleri
      ["workspaces", "workspaces_public_read", "SELECT", ["app_migrator"]],
      ["workspaces", "workspaces_select", "SELECT", ["app_user"]],
      ["workspaces", "workspaces_update", "UPDATE", ["app_user"]],
    ]);
  });

  it("tablo sahibi (app_migrator) workspace ve denetim satırlarını göremez; yalnız üyelikleri okuyabilir", async () => {
    const mig = new Client({ connectionString: db.migratorUrl });
    await mig.connect();
    try {
      const r = await mig.query(
        "select (select count(*) from workspaces)::int w, (select count(*) from audit_log)::int a, (select count(*) from workspace_members)::int m",
      );
      expect(r.rows[0].w).toBe(0);
      expect(r.rows[0].a).toBe(0);
      expect(r.rows[0].m).toBeGreaterThan(0);
      expect((await mig.query("update workspace_members set role = role")).rowCount).toBe(0);
    } finally {
      await mig.end();
    }
  });
});

describe("yetkiler", () => {
  it("tablo düzeyi: PUBLIC, app_admin, app_worker hiçbir şeye sahip değil", async () => {
    const r = await admin.query(
      `select c.relname, case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee, a.privilege_type
         from pg_class c, aclexplode(c.relacl) a
        where c.relnamespace = 'public'::regnamespace and c.relname = any($1) and a.grantee <> c.relowner
        order by 1, 2, 3`,
      [TABLES],
    );
    expect(r.rows.map((x) => `${x.relname}:${x.grantee}:${x.privilege_type}`)).toEqual([
      "audit_log:app_user:SELECT",
      "workspace_members:app_user:DELETE",
      "workspace_members:app_user:SELECT",
      "workspaces:app_user:SELECT",
    ]);
  });

  it("kolon düzeyi: ekleme ve güncelleme yalnız izin verilen kolonlarda", async () => {
    const r = await admin.query(
      `select table_name, privilege_type, string_agg(column_name, ',' order by column_name) as cols
         from information_schema.column_privileges
        where table_schema = 'public' and table_name = any($1) and grantee = 'app_user'
          and privilege_type in ('INSERT', 'UPDATE')
        group by 1, 2 order by 1, 2`,
      [TABLES],
    );
    expect(r.rows.map((x) => `${x.table_name}:${x.privilege_type}:${x.cols}`)).toEqual([
      "audit_log:INSERT:action,actor_user_id,id,metadata,target_id,target_type,workspace_id",
      "workspace_members:INSERT:id,role,user_id,workspace_id",
      "workspace_members:UPDATE:role",
      "workspaces:INSERT:created_by,id,name,slug",
      "workspaces:UPDATE:contact_whatsapp,name,slug",
    ]);
  });

  it("app_user workspace durumunu (askıya alma) değiştiremez", async () => {
    const app = new Pool({ connectionString: db.appUrl, max: 1 });
    try {
      await expect(app.query("update workspaces set status = 'active'")).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await app.end();
    }
  });
});
