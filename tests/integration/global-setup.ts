/**
 * Entegrasyon testleri için geçici veritabanı.
 * - TEST_ADMIN_DATABASE_URL: geçici Postgres konteynerinin yönetici adresi (yalnız localhost kabul edilir).
 * - Her çalıştırmada rastgele adlı `*_test` veritabanı açılır, gerçek db-bootstrap.sql ve
 *   migration'lar uygulanır, testler biter bitmez veritabanı silinir.
 * Gerçek geliştirme/production veritabanına bağlanmak teknik olarak engellenir.
 */
import { randomBytes } from "node:crypto";
import path from "node:path";

import { Client } from "pg";
import type { TestProject } from "vitest/node";

import { runMigrations } from "../../src/db/migrate";
import { runBootstrap } from "./psql";

declare module "vitest" {
  export interface ProvidedContext {
    testDb: {
      appUrl: string;
      migratorUrl: string;
      /** Test veritabanına süper kullanıcıyla bağlantı */
      adminUrl: string;
      /** Küme yöneticisi bağlantısı (postgres veritabanı) */
      serverAdminUrl: string;
      dbName: string;
      migratorPassword: string;
      appPassword: string;
    };
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function withDb(url: string, db: string, user?: { name: string; password: string }) {
  const u = new URL(url);
  u.pathname = `/${db}`;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
}

/**
 * Vitest, globalSetup içinden fırlatılan hatanın stack'ini işlerken çökebiliyor ve asıl mesaj
 * kayboluyor. Bu yüzden hatalar sade bir mesajla (stack olmadan) yeniden fırlatılır.
 */
function plainError(message: string): Error {
  const err = new Error(message);
  err.stack = `Error: ${message}`;
  return err;
}

async function assertReachable(adminUrl: string) {
  const client = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 3_000 });
  try {
    await client.connect();
    await client.query("select 1");
  } catch (err) {
    throw plainError(
      `Test Postgres'ine bağlanılamadı (${new URL(adminUrl).host}): ${err instanceof Error ? err.message : String(err)}\n` +
        "Mac'te Docker Desktop'ın açık olduğundan emin olun ve `npm run test:integration:docker` kullanın.",
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

export default async function setup(project: TestProject) {
  try {
    return await prepare(project);
  } catch (err) {
    throw plainError(err instanceof Error ? err.message : String(err));
  }
}

async function prepare(project: TestProject) {
  const adminUrl = process.env.TEST_ADMIN_DATABASE_URL;
  if (!adminUrl) {
    throw new Error(
      "TEST_ADMIN_DATABASE_URL tanımlı değil. Mac'te `npm run test:integration:docker` kullanın.",
    );
  }
  if (!LOCAL_HOSTS.has(new URL(adminUrl).hostname)) {
    throw new Error("Entegrasyon testleri yalnız localhost'taki geçici Postgres'e bağlanır.");
  }

  await assertReachable(adminUrl);

  const dbName = `lodging_${randomBytes(4).toString("hex")}_test`;
  const migratorPassword = randomBytes(24).toString("hex");
  const appPassword = randomBytes(24).toString("hex");

  // Gerçek kurulum script'i (parolalar ortam değişkeniyle).
  const res = runBootstrap({ dbName, migratorPassword, appPassword });
  if (res.status !== 0) {
    throw new Error(`db-bootstrap.sql başarısız:\n${res.output}`);
  }

  const migratorUrl = withDb(adminUrl, dbName, {
    name: "app_migrator",
    password: migratorPassword,
  });
  const appUrl = withDb(adminUrl, dbName, { name: "app_user", password: appPassword });

  await runMigrations({
    url: migratorUrl,
    appEnv: "test",
    migrationsFolder: path.resolve(__dirname, "../../drizzle"),
  });

  project.provide("testDb", {
    appUrl,
    migratorUrl,
    adminUrl: withDb(adminUrl, dbName),
    serverAdminUrl: adminUrl,
    dbName,
    migratorPassword,
    appPassword,
  });

  return async () => {
    const client = new Client({ connectionString: adminUrl });
    await client.connect();
    await client.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await client.end();
  };
}
