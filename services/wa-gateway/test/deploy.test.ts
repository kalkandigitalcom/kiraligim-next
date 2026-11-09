import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { databaseNameProblem, loadConfig, SERVICE_DIR } from "../src/config.ts";
import { acquireLock, lockHolderAlive } from "../src/lock.ts";
import { databaseRoleProblem, type Queryable } from "../src/store.ts";

/** Sunucu (konteyner) kurulumu: ortam kuralları, tek kopya kilidi, rol denetimi ve imaj içeriği. */
const base = { WA_ALLOWED_NUMBER: "905321112233" };
const svc = "/tmp/svc";

describe("ortam (WA_ENV) ve veritabanı adı", () => {
  it("production yalnız *_prod kabul eder; development yalnız *_dev", () => {
    assert.equal(databaseNameProblem("postgres://u:p@h/kiraligim_prod", "production"), null);
    assert.match(databaseNameProblem("postgres://u:p@h/lodging_dev", "production") ?? "", /_prod/);
    assert.match(databaseNameProblem("postgres://u:p@h/kiraligim", "production") ?? "", /_prod/);
    assert.match(databaseNameProblem("postgres://u:p@h/kiraligim_prod") ?? "", /üretim/);
    const c = loadConfig(
      { ...base, WA_ENV: "production", WA_DATABASE_URL: "postgres://u:p@db:5432/kiraligim_prod" },
      svc,
    );
    assert.equal(c.env, "production");
    assert.throws(
      () => loadConfig({ ...base, WA_ENV: "prod" }, svc),
      /WA_ENV yalnız development veya production/,
    );
  });

  it("WA_REQUIRE_DATABASE=true veya production: veritabanı yoksa başlamaz (Faz 1'e düşmez)", () => {
    assert.throws(
      () => loadConfig({ ...base, WA_REQUIRE_DATABASE: "true" }, svc),
      /WA_DATABASE_URL zorunlu/,
    );
    assert.throws(
      () => loadConfig({ ...base, WA_ENV: "production" }, svc),
      /WA_DATABASE_URL zorunlu/,
    );
    assert.throws(
      () => loadConfig({ ...base, WA_REQUIRE_DATABASE: "1" }, svc),
      /WA_REQUIRE_DATABASE/,
    );
    // Mac'teki Faz 1 test biçimi korunur (veritabanı istenmedikçe).
    assert.equal(loadConfig(base, svc).databaseUrl, null);
    assert.equal(loadConfig({ ...base, WA_REQUIRE_DATABASE: "false" }, svc).databaseUrl, null);
  });

  it("WA_HTTP_HOST yalnız 127.0.0.1 (varsayılan) veya 0.0.0.0", () => {
    assert.equal(loadConfig(base, svc).httpHost, "127.0.0.1");
    assert.equal(loadConfig({ ...base, WA_HTTP_HOST: "0.0.0.0" }, svc).httpHost, "0.0.0.0");
    for (const bad of ["192.168.1.10", "localhost", "::", "example.com"]) {
      assert.throws(() => loadConfig({ ...base, WA_HTTP_HOST: bad }, svc), /WA_HTTP_HOST/, bad);
    }
  });
});

describe("tek kopya kilidi", () => {
  it("kilitteki PID bu sürecin kendisiyse eski kilittir (konteyner yeniden başlatma, PID 1)", () => {
    assert.equal(
      lockHolderAlive(1, 1, () => {}),
      false,
    );
    assert.equal(
      lockHolderAlive(42, 1, () => {}),
      true,
    );
    assert.equal(
      lockHolderAlive(42, 1, () => {
        throw new Error("ESRCH");
      }),
      false,
    );
    assert.equal(
      lockHolderAlive(Number.NaN, 1, () => {}),
      false,
    );
    assert.equal(
      lockHolderAlive(0, 1, () => {}),
      false,
    );
  });

  it("kendi PID'ini taşıyan kilit devralınır; yaşayan başka süreç reddedilir", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-lock-"));
    try {
      const lock = path.join(dir, ".wa-auth.lock");
      fs.writeFileSync(lock, String(process.pid));
      const release = acquireLock(lock);
      assert.equal(fs.readFileSync(lock, "utf8"), String(process.pid));
      release();
      assert.equal(fs.existsSync(lock), false);
      // Yaşayan başka süreç: üst süreç (test çalıştırıcısı).
      fs.writeFileSync(lock, String(process.ppid));
      assert.throws(() => acquireLock(lock), /Başka bir kopya çalışıyor/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("veritabanı rolü denetimi", () => {
  const fakeDb = (row: Record<string, unknown> | undefined): Queryable => ({
    query: async <R>() => ({ rows: (row ? [row] : []) as R[] }),
  });
  const row = (role: string, db: string, extra: Record<string, boolean> = {}) =>
    fakeDb({ role, db, superuser: false, bypassrls: false, ...extra });

  it("production yalnız app_wa_gateway ile ve *_prod veritabanında", async () => {
    assert.equal(
      await databaseRoleProblem(row("app_wa_gateway", "kiraligim_prod"), "production"),
      null,
    );
    assert.match(
      (await databaseRoleProblem(row("app_user", "kiraligim_prod"), "production")) ?? "",
      /app_wa_gateway/,
    );
    assert.match(
      (await databaseRoleProblem(row("app_wa_gateway", "lodging_dev"), "production")) ?? "",
      /_prod/,
    );
  });

  it("süper kullanıcı, BYPASSRLS, postgres ve app_migrator her ortamda reddedilir", async () => {
    for (const env of ["development", "production"] as const) {
      const db = env === "production" ? "kiraligim_prod" : "lodging_dev";
      for (const r of [
        row("postgres", db),
        row("app_migrator", db),
        row("app_wa_gateway", db, { superuser: true }),
        row("app_wa_gateway", db, { bypassrls: true }),
      ]) {
        assert.match((await databaseRoleProblem(r, env)) ?? "", /bağlanılamaz/);
      }
    }
    assert.equal(await databaseRoleProblem(row("app_user", "lodging_dev"), "development"), null);
    assert.match((await databaseRoleProblem(fakeDb(undefined), "development")) ?? "", /okunamadı/);
  });
});

describe("konteyner imajı", () => {
  const read = (f: string) => fs.readFileSync(path.join(SERVICE_DIR, f), "utf8");

  it(".dockerignore oturum anahtarlarını, env dosyalarını ve kilidi dışlar", () => {
    const ignore = read(".dockerignore")
      .split("\n")
      .map((l) => l.trim());
    for (const entry of [".wa-auth", ".wa-auth*", ".env", ".env.*", "*.lock", "node_modules"]) {
      assert.ok(ignore.includes(entry), entry);
    }
  });

  it("Dockerfile: root olmayan kullanıcı, 0.0.0.0, veritabanı zorunlu, sağlık kontrolü, doğrudan node", () => {
    const df = read("Dockerfile");
    assert.match(df, /^USER app$/m);
    assert.match(df, /WA_HTTP_HOST=0\.0\.0\.0/);
    assert.match(df, /WA_REQUIRE_DATABASE=true/);
    assert.match(df, /HEALTHCHECK[\s\S]*\/healthz/);
    assert.match(df, /CMD \["node", "--import", "tsx", "src\/main\.ts"\]/);
    assert.doesNotMatch(df, /COPY \. /);
  });
});
