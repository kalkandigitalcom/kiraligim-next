/**
 * iCal otomatik senkron komutu: `node dist/ical-sync.js`
 *
 * Coolify → uygulama → Scheduled Tasks'ta uygulama konteynerinde çalıştırılır (ör. 15 dakikada bir).
 * Her çalıştırmada son senkronu 4 saatten eski etkin kaynaklar senkron edilir; aynı kaynak
 * eşzamanlı iki kez işlenmez (veritabanı kilidi). Uygulamanın kendi bağlantısını (DATABASE_URL,
 * app_user, RLS) kullanır; HTTP uç noktası veya ek sır yoktur. Çıkış kodu: 0 başarılı (bazı
 * kaynaklar hatalı olsa da — hata kaynakta kayıtlıdır), 1 beklenmeyen hata.
 */
import { createStandaloneDb } from "../../db/standalone";
import { APP_ENVS, type AppEnv, checkDatabaseName } from "../../lib/env";
import { createLogger } from "../../lib/logger";
import { runDueSync } from "./sync";

const log = createLogger({ service: "ical-sync" });

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL tanımlı değil");
  const appEnv = process.env.APP_ENV as AppEnv | undefined;
  if (appEnv && (APP_ENVS as readonly string[]).includes(appEnv)) {
    const issue = checkDatabaseName(appEnv, url);
    if (issue) throw new Error(`DATABASE_URL: ${issue}`);
  }
  const { db, end } = createStandaloneDb(url, {
    max: 4,
    application_name: "kiraligim-ical-sync",
  });
  try {
    const started = Date.now();
    const summary = await runDueSync(db, { log });
    log.info("ical_cron_finished", { ...summary, ms: Date.now() - started });
  } finally {
    await end();
  }
}

main().catch((err: unknown) => {
  log.error("ical_cron_failed", { err });
  process.exit(1);
});
