import { randomBytes } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { DB_CASING } from "@/db/casing";
import * as schema from "@/db/schema";
import {
  ADMIN_LIMITS,
  beginAdminLogin,
  completeAdminLogin,
  createAdminUser,
  getAdminSession,
  resetAdminPassword,
  resetAdminTotp,
  revokeAdminSession,
  setAdminStatus,
} from "@/server/admin/auth";
import { sha256Hex } from "@/server/admin/crypto";
import { totpCode, totpStep } from "@/server/admin/totp";

import { runAdminRole } from "./psql";

/**
 * Super Admin (Aşama 2.8 minimal) — gerçek PostgreSQL 17. Servisler app_admin rolüyle çalışır
 * (süper kullanıcı bağlantısında SET ROLE app_admin: yetki ve RLS app_admin'inkidir).
 *
 * Doğrulananlar: yalnız app_admin admin_* tablolarına erişir; app_user hiçbirine erişemez ve
 * app_admin işletme tablolarını okuyamaz; zorunlu 2FA; genel hata mesajı; kilitlenme; TOTP tekrar
 * kullanılamaz; giriş adımı süresi/deneme sınırı; oturum mutlak/hareketsizlik süresi, iptal,
 * devre dışı yönetici; belirteçler yalnız özetle saklanır; denetim kaydı yalnız eklenir.
 */
const db = inject("testDb");
const asAdminPool = new Pool({ connectionString: db.adminUrl, max: 3 });
asAdminPool.on("connect", (c) => void c.query("set role app_admin"));
const adminDb = drizzle(asAdminPool, { schema, casing: DB_CASING });
const appPool = new Pool({ connectionString: db.appUrl, max: 2 });
const admin = new Client({ connectionString: db.adminUrl });
const KEY = randomBytes(32);
const tag = randomBytes(3).toString("hex");
const PW = "Guclu-yonetici-sifresi-2026";

let secret: string;
let adminId: string;
const email = `burhan.${tag}@kiraligim.com`;
const t0 = new Date("2026-11-10T10:00:00Z");
const at = (min: number) => new Date(t0.getTime() + min * 60_000);
const code = (when: Date, offsetSteps = 0) =>
  totpCode(secret, totpStep(when.getTime()) + offsetSteps);

async function login(when: Date, c?: string) {
  const b = await beginAdminLogin(adminDb, { email, password: PW }, when);
  if (!b.ok) throw new Error(`begin ${b.reason}`);
  return completeAdminLogin(
    adminDb,
    { challengeToken: b.challengeToken, code: c ?? code(when) },
    KEY,
    when,
  );
}

beforeAll(async () => {
  await admin.connect();
  const r = await createAdminUser(
    adminDb,
    { email: ` ${email.toUpperCase()} `, name: "Burhan", password: PW },
    KEY,
  );
  secret = r.secret;
  adminId = r.id;
});

afterAll(async () => {
  await admin.end();
  await asAdminPool.end();
  await appPool.end();
});

describe("yetki sınırları", () => {
  it("app_user admin_* tablolarına hiçbir şekilde erişemez", async () => {
    for (const q of [
      "select * from admin_users",
      "select * from admin_sessions",
      "select * from admin_login_challenges",
      "select * from admin_audit_log",
      "insert into admin_audit_log (id, action) values (gen_random_uuid(), 'admin.login')",
    ]) {
      const c = await appPool.query(q).then(
        () => "ok",
        (e: { code?: string }) => e.code,
      );
      expect([q, c]).toEqual([q, "42501"]);
    }
  });

  it("app_admin işletme tablolarını okuyamaz; denetim kaydını değiştiremez; yönetici silemez", async () => {
    for (const q of [
      "select * from workspaces",
      "select * from users",
      "select * from reservations",
      "select * from wa_groups",
      "update admin_audit_log set action = 'admin.logout'",
      "delete from admin_audit_log",
      "delete from admin_users",
      "update admin_users set email = 'x@y.com'",
    ]) {
      const c = await asAdminPool.query(q).then(
        () => "ok",
        (e: { code?: string }) => e.code,
      );
      expect([q, c]).toEqual([q, "42501"]);
    }
  });

  it("tablolar FORCE RLS; app_admin dışındaki uygulama rollerinde yetki yok", async () => {
    const r = await admin.query(`
      select c.relname, c.relrowsecurity rls, c.relforcerowsecurity force,
             has_table_privilege('app_user', c.oid, 'SELECT') app_user,
             has_table_privilege('app_worker', c.oid, 'SELECT') worker
        from pg_class c where c.relname like 'admin\\_%' and c.relkind = 'r' order by 1`);
    expect(r.rows).toEqual(
      ["admin_audit_log", "admin_login_challenges", "admin_sessions", "admin_users"].map(
        (relname) => ({ relname, rls: true, force: true, app_user: false, worker: false }),
      ),
    );
  });
});

describe("hesap", () => {
  it("e-posta normalize edilir; şifre özetli, TOTP sırrı şifreli saklanır", async () => {
    const u = (await admin.query("select * from admin_users where id = $1", [adminId])).rows[0];
    expect(u.email).toBe(email);
    expect(u.password_hash).toMatch(/^scrypt\$/);
    expect(u.password_hash).not.toContain(PW);
    expect(u.totp_secret_enc).toMatch(/^v1:/);
    expect(u.totp_secret_enc).not.toContain(secret);
    await expect(
      createAdminUser(adminDb, { email, name: "İkinci", password: PW }, KEY),
    ).rejects.toThrow(/zaten/);
    await expect(
      createAdminUser(adminDb, { email: `k.${tag}@x.com`, name: "K", password: "kısa" }, KEY),
    ).rejects.toThrow(/12/);
  });
});

describe("giriş", () => {
  it("şifre + TOTP → oturum; belirteç yalnız özetle saklanır; denetim kaydı", async () => {
    const r = await login(at(0));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = await getAdminSession(adminDb, r.sessionToken, at(1));
    expect(s).toMatchObject({ adminId, email, name: "Burhan" });
    const row = (
      await admin.query("select token_hash from admin_sessions where id = $1", [s!.sessionId])
    ).rows[0];
    expect(row.token_hash).toBe(sha256Hex(r.sessionToken));
    expect(r.sessionToken).not.toBe(row.token_hash);
    const audit = await admin.query(
      "select action, metadata from admin_audit_log where admin_id = $1 and action = 'admin.login'",
      [adminId],
    );
    expect(audit.rows.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(audit.rows)).not.toContain(r.sessionToken);
  });

  it("şifre doğru olsa da TOTP olmadan oturum yok; aynı TOTP kodu ikinci kez kullanılamaz", async () => {
    const when = at(10);
    const first = await login(when);
    expect(first.ok).toBe(true);
    const b = await beginAdminLogin(adminDb, { email, password: PW }, at(10.2));
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    const replay = await completeAdminLogin(
      adminDb,
      { challengeToken: b.challengeToken, code: code(when) },
      KEY,
      at(10.2),
    );
    expect(replay).toEqual({ ok: false, reason: "invalid" });
  });

  it("bilinmeyen e-posta, yanlış şifre ve devre dışı hesap aynı genel hatayı verir", async () => {
    expect(
      await beginAdminLogin(adminDb, { email: `yok.${tag}@x.com`, password: PW }, at(20)),
    ).toEqual({ ok: false, reason: "invalid" });
    expect(
      await beginAdminLogin(adminDb, { email, password: "yanlis-sifre-12345" }, at(20)),
    ).toEqual({ ok: false, reason: "invalid" });
    await admin.query("update admin_users set failed_count = 0 where id = $1", [adminId]);
  });

  it("art arda 5 hatalı denemede hesap 15 dk kilitlenir (doğru şifreyle bile); süre dolunca açılır", async () => {
    for (let i = 0; i < ADMIN_LIMITS.maxFailures - 1; i++) {
      expect(
        await beginAdminLogin(adminDb, { email, password: `yanlis-${i}-xxxxxxxx` }, at(30)),
      ).toEqual({ ok: false, reason: "invalid" });
    }
    expect(
      await beginAdminLogin(adminDb, { email, password: "son-yanlis-xxxxxxx" }, at(30)),
    ).toEqual({ ok: false, reason: "locked" });
    expect(await beginAdminLogin(adminDb, { email, password: PW }, at(31))).toEqual({
      ok: false,
      reason: "locked",
    });
    const later = await login(at(46));
    expect(later.ok).toBe(true);
    const audit = await admin.query(
      "select metadata from admin_audit_log where admin_id = $1 and action = 'admin.login_failed' order by id desc limit 1",
      [adminId],
    );
    expect(audit.rows[0].metadata).toEqual({ step: "password", locked: true });
  });

  it("hatalı TOTP de sayılır; giriş adımı 5 denemede ve 5 dakikada biter", async () => {
    const b = await beginAdminLogin(adminDb, { email, password: PW }, at(60));
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(
      await completeAdminLogin(
        adminDb,
        { challengeToken: b.challengeToken, code: "000000" },
        KEY,
        at(60),
      ),
    ).toEqual({ ok: false, reason: "invalid" });
    const u = (await admin.query("select failed_count from admin_users where id = $1", [adminId]))
      .rows[0];
    expect(u.failed_count).toBe(1);
    // Süre doldu.
    expect(
      await completeAdminLogin(
        adminDb,
        { challengeToken: b.challengeToken, code: code(at(66)) },
        KEY,
        at(66),
      ),
    ).toEqual({ ok: false, reason: "expired" });
    // Belirteç silindi: yeniden kullanılamaz.
    expect(
      await completeAdminLogin(
        adminDb,
        { challengeToken: b.challengeToken, code: code(at(60)) },
        KEY,
        at(60.5),
      ),
    ).toEqual({ ok: false, reason: "expired" });
    // Deneme sınırı (kilit eşiğinin altında kalarak: sayaç her başarılı girişte sıfırlanır).
    await admin.query("update admin_users set failed_count = 0 where id = $1", [adminId]);
    const b2 = await beginAdminLogin(adminDb, { email, password: PW }, at(70));
    if (!b2.ok) throw new Error("begin");
    await admin.query("update admin_login_challenges set attempts = 5 where token_hash = $1", [
      sha256Hex(b2.challengeToken),
    ]);
    expect(
      await completeAdminLogin(
        adminDb,
        { challengeToken: b2.challengeToken, code: code(at(70)) },
        KEY,
        at(70),
      ),
    ).toEqual({ ok: false, reason: "expired" });
    await admin.query("update admin_users set failed_count = 0 where id = $1", [adminId]);
  });

  it("yanlış şifreleme anahtarıyla TOTP doğrulanamaz", async () => {
    const b = await beginAdminLogin(adminDb, { email, password: PW }, at(80));
    if (!b.ok) throw new Error("begin");
    expect(
      await completeAdminLogin(
        adminDb,
        { challengeToken: b.challengeToken, code: code(at(80)) },
        randomBytes(32),
        at(80),
      ),
    ).toEqual({ ok: false, reason: "invalid" });
    await admin.query("update admin_users set failed_count = 0 where id = $1", [adminId]);
  });
});

describe("oturum", () => {
  it("hareketsizlikte (2 saat) ve mutlak sürede (12 saat) biter; kullanım süreyi uzatır", async () => {
    const r = await login(at(100));
    if (!r.ok) throw new Error("login");
    expect(await getAdminSession(adminDb, r.sessionToken, at(100 + 119))).not.toBeNull(); // dokunur
    expect(await getAdminSession(adminDb, r.sessionToken, at(100 + 119 + 119))).not.toBeNull();
    expect(await getAdminSession(adminDb, r.sessionToken, at(100 + 119 + 119 + 121))).toBeNull();
    const r2 = await login(at(1000));
    if (!r2.ok) throw new Error("login");
    for (let m = 100; m < 12 * 60; m += 100) {
      expect(await getAdminSession(adminDb, r2.sessionToken, at(1000 + m))).not.toBeNull();
    }
    expect(await getAdminSession(adminDb, r2.sessionToken, at(1000 + 12 * 60 + 1))).toBeNull();
  });

  it("çıkış oturumu iptal eder; sahte ve aşırı uzun belirteç reddedilir", async () => {
    const r = await login(at(2000));
    if (!r.ok) throw new Error("login");
    await revokeAdminSession(adminDb, r.sessionToken);
    expect(await getAdminSession(adminDb, r.sessionToken, at(2001))).toBeNull();
    expect(await getAdminSession(adminDb, "sahte", at(2001))).toBeNull();
    expect(await getAdminSession(adminDb, "x".repeat(500), at(2001))).toBeNull();
    expect(await getAdminSession(adminDb, undefined, at(2001))).toBeNull();
  });

  it("2FA yenilenince ve hesap devre dışı bırakılınca tüm oturumlar kapanır", async () => {
    const r = await login(at(3000));
    if (!r.ok) throw new Error("login");
    const reset = await resetAdminTotp(adminDb, email, KEY);
    expect(await getAdminSession(adminDb, r.sessionToken, at(3001))).toBeNull();
    secret = reset.secret;
    const r2 = await login(at(3010));
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    await setAdminStatus(adminDb, email, "disabled");
    expect(await getAdminSession(adminDb, r2.sessionToken, at(3011))).toBeNull();
    expect(await beginAdminLogin(adminDb, { email, password: PW }, at(3012))).toEqual({
      ok: false,
      reason: "invalid",
    });
    await setAdminStatus(adminDb, email, "active");
    await resetAdminPassword(adminDb, email, "Yeni-guclu-sifre-2027");
    expect(await beginAdminLogin(adminDb, { email, password: PW }, at(3020))).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(
      (await beginAdminLogin(adminDb, { email, password: "Yeni-guclu-sifre-2027" }, at(3021))).ok,
    ).toBe(true);
    const actions = (
      await admin.query("select action from admin_audit_log where target_id = $1 order by id", [
        adminId,
      ])
    ).rows.map((x) => x.action);
    expect(actions).toEqual([
      "admin.user_created",
      "admin.totp_reset",
      "admin.user_disabled",
      "admin.user_enabled",
      "admin.password_reset",
    ]);
  });
});

describe("rol betiği (scripts/admin-role.sql)", () => {
  afterAll(async () => {
    // Rol küme genelinde: diğer testler app_admin'in girişinin kapalı olmasını bekler.
    await admin.query("alter role app_admin nologin password null");
  });

  it("app_admin girişini açar; parola çıktıda görünmez; yalnız admin_* tablolarına erişir", async () => {
    const password = randomBytes(24).toString("hex");
    expect(runAdminRole({ dbName: db.dbName }).status).not.toBe(0);
    expect(runAdminRole({ dbName: db.dbName, password: "kisa" }).status).not.toBe(0);
    const r = runAdminRole({ dbName: db.dbName, password });
    expect(r.status, r.output).toBe(0);
    expect(r.output).not.toContain(password);
    const u = new URL(db.adminUrl);
    u.username = "app_admin";
    u.password = password;
    const c = new Client({ connectionString: u.toString() });
    await c.connect();
    try {
      expect((await c.query("select current_user u")).rows[0].u).toBe("app_admin");
      expect((await c.query("select count(*)::int n from admin_users")).rows[0].n).toBeGreaterThan(
        0,
      );
      const denied = await c.query("select * from workspaces").then(
        () => "ok",
        (e: { code?: string }) => e.code,
      );
      expect(denied).toBe("42501");
    } finally {
      await c.end();
    }
  });
});
