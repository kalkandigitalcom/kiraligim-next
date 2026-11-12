/**
 * Acente API takvim değişikliği işlemcisi: `node dist/api-sync.js`
 *
 * Coolify → uygulama → Scheduled Tasks'ta uygulama konteynerinde HER DAKİKA çalıştırılır
 * (`* * * * *`). Tek süreç en fazla 50 sn çalışır, birkaç saniyede bir yeni "değişti" satırlarını
 * işler; aynı anda ikinci süreç başlarsa advisory lock'u alamaz ve hemen çıkar (çıkış 0).
 * Uygulamanın kendi bağlantısını (DATABASE_URL, app_user) kullanır. Webhook gönderimi için
 * API_WEBHOOK_SECRET_KEY (base64, 32 bayt) gerekir; tanımlı değilse değişiklikler yine işlenir,
 * teslimler bekler (iptal edilmez) ve log'a bir uyarı yazılır.
 * Çıkış kodu: 0 başarılı (villa hataları yeniden denenmek üzere veritabanına yazılır), 1 beklenmeyen
 * hata. Log'a yalnız sayılar yazılır.
 */
import { createStandaloneDb } from "../../db/standalone";
import { APP_ENVS, type AppEnv, checkDatabaseName } from "../../lib/env";
import { createLogger } from "../../lib/logger";
import { runApiSync } from "./processor";
import { deliverDue, pruneDeliveries, webhookKey } from "./webhooks";

const log = createLogger({ service: "api-sync" });

class ConfigError extends Error {}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new ConfigError("DATABASE_URL tanımlı değil");
  const appEnv = process.env.APP_ENV as AppEnv | undefined;
  if (appEnv && (APP_ENVS as readonly string[]).includes(appEnv)) {
    const issue = checkDatabaseName(appEnv, url);
    if (issue) throw new ConfigError(`DATABASE_URL: ${issue}`);
  }
  // Tek bağlantı, boşta kapatılmaz: oturum advisory lock'u süreç boyunca bu bağlantıda kalır.
  const { db, end } = createStandaloneDb(url, {
    max: 1,
    idleTimeoutMillis: 0,
    statement_timeout: 30_000,
    application_name: "kiraligim-api-sync",
  });
  try {
    const started = Date.now();
    const key = webhookKey();
    if (!key) log.warn("api_webhooks_disabled_no_key");
    const summary = await runApiSync(db, {
      pruneDeliveries: () => pruneDeliveries(db),
      ...(key ? { deliver: (budgetMs: number) => deliverDue(db, { key, maxMs: budgetMs }) } : {}),
    });
    if (!summary.locked) log.info("api_sync_skipped_running");
    else log.info("api_sync_finished", { ...summary, ms: Date.now() - started });
  } finally {
    await end();
  }
}

main().catch((err: unknown) => {
  log.error("api_sync_failed", {
    reason: err instanceof ConfigError ? err.message : err instanceof Error ? err.name : "unknown",
    code:
      err && typeof err === "object" && "code" in err && typeof err.code === "string"
        ? err.code
        : null,
  });
  process.exit(1);
});
