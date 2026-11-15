/**
 * Opsiyon bakım görevi: `node dist/option-maintenance.js` (Aşama 3b).
 *
 * Coolify → uygulama → Scheduled Tasks'ta YENİ ve AYRI bir görev olarak (her dakika, `* * * * *`)
 * çalışması için hazırlanmıştır; mevcut WhatsApp Calendar Worker, api-sync ve ical-sync görevlerine
 * dokunmaz. Görev Coolify'da DEVRE DIŞI oluşturulur; production'da etkinleştirme yalnız açık
 * onayla (K-C). Görev hiç çalışmasa da mevcut sistem bundan etkilenmez.
 *
 * Yapılanlar (ayrıntı: ./run.ts): süresi dolan opsiyonları expired yapar; Super Admin'in onayladığı
 * oluşturma / iptal işlemlerini (yalnız global + işletme + grup anahtarı açıkken; Aşama 3c) uygular;
 * açık opsiyonla çakışan kesin kayıtlar için Super Admin uyarısı yazar. Mesaj imleci Aşama 3b'de KAPALIDIR (mesaj
 * işleyicisi Aşama 3d'de eklenir). WhatsApp'a tepki göndermez (K-A, K-B); rezervasyon, blok,
 * harici takvim, API, iCal ve webhook verisine YAZMAZ; opsiyon müsaitliği hiçbir koşulda kapatmaz.
 *
 * Uygulamanın kendi bağlantısını (DATABASE_URL, app_user, RLS) kullanır; ek sır ve ortam değişkeni
 * gerekmez. Aynı anda ikinci süreç advisory lock'u alamaz ve hemen çıkar (çıkış 0).
 * Çıkış kodu: 0 başarılı; 1 yapılandırma / bağlantı hatası ya da bir adımın başarısız olması.
 * Log'a yalnız sayılar ve kısa hata kodları yazılır.
 */
import { createStandaloneDb } from "../../db/standalone";
import { APP_ENVS, type AppEnv, checkDatabaseName } from "../../lib/env";
import { createLogger } from "../../lib/logger";
import { runOptionMaintenance } from "./run";

const log = createLogger({ service: "option-maintenance" });

/** Yapılandırma hatası: mesajı kişisel veri içermez, log'a yazılır. */
class ConfigError extends Error {}

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new ConfigError("DATABASE_URL tanımlı değil");
  const appEnv = process.env.APP_ENV as AppEnv | undefined;
  if (appEnv && (APP_ENVS as readonly string[]).includes(appEnv)) {
    const issue = checkDatabaseName(appEnv, url);
    if (issue) throw new ConfigError(`DATABASE_URL: ${issue}`);
  }
  // Tek bağlantı, boşta kapatılmaz: oturum advisory lock'u çalıştırma boyunca bu bağlantıda kalır.
  const { db, end } = createStandaloneDb(url, {
    max: 1,
    idleTimeoutMillis: 0,
    statement_timeout: 30_000,
    application_name: "kiraligim-option-maintenance",
  });
  try {
    const started = Date.now();
    // Aşama 3b: mesaj işleyicisi YOK → imleç okunmaz (Aşama 3d'de bağlanır).
    const summary = await runOptionMaintenance(db, { log });
    log.info("option_maintenance_finished", { ...summary, ms: Date.now() - started });
    return summary.locked && summary.failedSteps.length > 0 ? 1 : 0;
  } finally {
    await end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const e = err as { code?: unknown } | null;
    log.error(
      "option_maintenance_failed",
      err instanceof ConfigError
        ? { reason: err.message }
        : {
            code: typeof e?.code === "string" ? e.code : err instanceof Error ? err.name : "error",
          },
    );
    process.exit(1);
  });
