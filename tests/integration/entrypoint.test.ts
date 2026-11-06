import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

import { beforeAll, describe, expect, inject, it } from "vitest";

const db = inject("testDb");
const root = path.resolve(__dirname, "../..");

/** Konteyner giriş noktası: migration'ı sunucudan önce çalıştırır ve migrator parolasını uygulamaya geçirmez. */
describe("scripts/docker-entrypoint.sh", () => {
  beforeAll(() => {
    execFileSync("node", ["scripts/build-scripts.mjs"], { cwd: root, stdio: "ignore" });
  });

  // "Uygulama" yerine, kendi ortamını yazdıran bir komut çalıştırılır.
  const child = [
    "node",
    "-e",
    "console.log('CHILD:' + JSON.stringify({ m: process.env.MIGRATION_DATABASE_URL ?? null }))",
  ];

  function run(env: Record<string, string>) {
    const res = spawnSync("sh", ["scripts/docker-entrypoint.sh", ...child], {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        APP_ENV: "test",
        LOG_LEVEL: "info",
        ...env,
      } as unknown as NodeJS.ProcessEnv,
    });
    return { status: res.status, out: `${res.stdout}${res.stderr}` };
  }

  it("migration'ı çalıştırır, sonra uygulamayı migrator parolası olmadan başlatır", () => {
    const res = run({ RUN_MIGRATIONS_ON_START: "true", MIGRATION_DATABASE_URL: db.migratorUrl });
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain("migration_finished");
    expect(res.out).toContain('CHILD:{"m":null}');
    expect(res.out).not.toContain(new URL(db.migratorUrl).password);
  });

  it("migration bayrağı kapalıyken migration çalışmaz ama parola yine silinir", () => {
    const res = run({ MIGRATION_DATABASE_URL: db.migratorUrl });
    expect(res.status).toBe(0);
    expect(res.out).not.toContain("migration_started");
    expect(res.out).toContain('CHILD:{"m":null}');
  });

  it("migration başarısızsa uygulama başlamaz ve sıfırdan farklı kodla çıkar", () => {
    const bad = new URL(db.migratorUrl);
    bad.password = "yanlis";
    const res = run({ RUN_MIGRATIONS_ON_START: "true", MIGRATION_DATABASE_URL: bad.toString() });
    expect(res.status).not.toBe(0);
    expect(res.out).toContain("migration_failed");
    expect(res.out).not.toContain("CHILD:");
  });

  it("bağlantı adresi yoksa başlamaz", () => {
    const res = run({ RUN_MIGRATIONS_ON_START: "true" });
    expect(res.status).not.toBe(0);
    expect(res.out).not.toContain("CHILD:");
  });

  it("geçersiz bayrak değerinde başlamaz", () => {
    const res = run({ RUN_MIGRATIONS_ON_START: "yes", MIGRATION_DATABASE_URL: db.migratorUrl });
    expect(res.status).not.toBe(0);
    expect(res.out).not.toContain("CHILD:");
  });

  it("yanlış ortamın veritabanına migration uygulamaz", () => {
    const res = run({
      RUN_MIGRATIONS_ON_START: "true",
      MIGRATION_DATABASE_URL: db.migratorUrl,
      APP_ENV: "production",
    });
    expect(res.status).not.toBe(0);
    expect(res.out).not.toContain("CHILD:");
  });
});
