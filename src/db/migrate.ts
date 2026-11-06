/**
 * Ön-deploy migration komutu: `node dist/migrate.js`
 * Coolify'da yeni sürüm devreye girmeden önce çalışır. Hata olursa sıfırdan farklı kodla çıkar
 * ve deploy durur; eski sürüm çalışmaya devam eder.
 * MIGRATION_DATABASE_URL (app_migrator rolü) kullanır; uygulamanın DATABASE_URL'i kullanılmaz.
 */
import path from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { APP_ENVS, type AppEnv, checkDatabaseName } from "../lib/env";
import { createLogger } from "../lib/logger";
import { createPool } from "./pool";

const log = createLogger({ service: "migrate" });

// Aynı anda iki deploy'un migration çalıştırmasını engelleyen sabit kilit anahtarı.
const ADVISORY_LOCK_KEY = 4_815_162_342;

export async function runMigrations(opts: {
  url: string;
  appEnv: AppEnv;
  migrationsFolder: string;
}) {
  const problem = checkDatabaseName(opts.appEnv, opts.url);
  if (problem) throw new Error(problem);

  const pool = createPool(opts.url, {
    max: 1,
    statement_timeout: 0,
    application_name: "kiraligim-migrate",
  });
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    try {
      await migrate(drizzle(client), {
        migrationsFolder: opts.migrationsFolder,
        migrationsSchema: "drizzle",
        migrationsTable: "__migrations",
      });
    } finally {
      await client.query("select pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

async function main() {
  const url = process.env.MIGRATION_DATABASE_URL;
  const appEnv = process.env.APP_ENV as AppEnv | undefined;
  if (!url) throw new Error("MIGRATION_DATABASE_URL tanımlı değil");
  if (!appEnv || !APP_ENVS.includes(appEnv)) throw new Error("APP_ENV geçersiz");

  const migrationsFolder = process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), "drizzle");
  const started = Date.now();
  log.info("migration_started", { appEnv, migrationsFolder });
  await runMigrations({ url, appEnv, migrationsFolder });
  log.info("migration_finished", { ms: Date.now() - started });
}

// Yalnız doğrudan çalıştırıldığında (dist/migrate.js); testlerde import edilince çalışmaz.
if (process.argv[1] && /migrate\.(js|ts|mjs|cjs)$/.test(process.argv[1])) {
  main().catch((err: unknown) => {
    log.error("migration_failed", { err });
    process.exit(1);
  });
}
