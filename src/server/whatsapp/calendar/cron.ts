/**
 * WhatsApp takvim worker'ı komutu: `node dist/wa-calendar.js`
 *
 * Coolify → uygulama → Scheduled Tasks'ta uygulama konteynerinde HER DAKİKA çalıştırılır
 * (`* * * * *`). Bağlı WhatsApp gruplarından gelen mesajları ayrıştırır ve İŞLEM ÖNERİSİ
 * (wa_calendar_proposals) oluşturur. Bağlı ve aktif grubun Super Admin tarafından engellenmemiş
 * herhangi bir katılımcısının (B aşaması) grubun villası için açık, net tarihli ve çakışmasız kapatma
 * talimatı, işletme sahibinin oturum bağlamında rezervasyon servisiyle doğrudan blok olur
 * (../auto-close.ts).
 * Uygulamanın kendi bağlantısını (DATABASE_URL, app_user, RLS) kullanır; HTTP uç noktası veya ek
 * sır yoktur. İlk çalıştırma worker'ı etkinleştirir: o ana kadar kuyruktaki mesajlar işlenmez.
 * Çıkış kodu: 0 başarılı (tek tek mesaj hataları mesaja yazılır), 1 beklenmeyen hata.
 * Log'a mesaj içeriği ve telefon bilgisi yazılmaz.
 */
import { createStandaloneDb } from "../../../db/standalone";
import { APP_ENVS, type AppEnv, checkDatabaseName } from "../../../lib/env";
import { createLogger } from "../../../lib/logger";
import { createAutoCloser } from "../auto-close";
import { runCalendarWorker, safeError } from "./worker";

const log = createLogger({ service: "wa-calendar" });

/** Yapılandırma hatası: mesajı kişisel veri içermez, log'a yazılır. */
class ConfigError extends Error {}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new ConfigError("DATABASE_URL tanımlı değil");
  const appEnv = process.env.APP_ENV as AppEnv | undefined;
  if (appEnv && (APP_ENVS as readonly string[]).includes(appEnv)) {
    const issue = checkDatabaseName(appEnv, url);
    if (issue) throw new ConfigError(`DATABASE_URL: ${issue}`);
  }
  const { db, end } = createStandaloneDb(url, {
    max: 2,
    application_name: "kiraligim-wa-calendar",
  });
  try {
    const started = Date.now();
    const summary = await runCalendarWorker(db, { log, autoClose: createAutoCloser(db) });
    log.info("wa_calendar_finished", { ...summary, ms: Date.now() - started });
  } finally {
    await end();
  }
}

main().catch((err: unknown) => {
  // Ham hata nesnesi yazılmaz (sorgu parametreleri kişisel veri içerebilir).
  log.error(
    "wa_calendar_failed",
    err instanceof ConfigError ? { reason: err.message } : safeError(err),
  );
  process.exit(1);
});
