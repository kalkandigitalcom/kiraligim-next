/**
 * WhatsApp mesaj saklama komutu: `node dist/wa-retention.js`
 *
 * Saklama süresi (WA_RETENTION_DAYS = 90 gün) dolan grup mesajlarını ve 7 günden eski bağlama
 * kodlarını siler (app_wa_purge_messages). Ağ geçidi de saatte bir aynı fonksiyonu çağırır; bu
 * komut, ağ geçidi kapalıyken de silmenin sürmesi için Coolify Scheduled Task olarak çalıştırılır.
 * Uygulamanın kendi bağlantısını (DATABASE_URL, app_user) kullanır.
 */
import { sql } from "drizzle-orm";

import { createStandaloneDb } from "../../db/standalone";
import { APP_ENVS, type AppEnv, checkDatabaseName } from "../../lib/env";
import { createLogger } from "../../lib/logger";
import { WA_RETENTION_DAYS } from "../../lib/whatsapp-meta";

const log = createLogger({ service: "wa-retention" });

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL tanımlı değil");
  const appEnv = process.env.APP_ENV as AppEnv | undefined;
  if (appEnv && (APP_ENVS as readonly string[]).includes(appEnv)) {
    const issue = checkDatabaseName(appEnv, url);
    if (issue) throw new Error(`DATABASE_URL: ${issue}`);
  }
  const { db, end } = createStandaloneDb(url, {
    max: 1,
    application_name: "kiraligim-wa-retention",
  });
  try {
    const res = await db.execute<{ n: number }>(
      sql`select public.app_wa_purge_messages(${WA_RETENTION_DAYS}) as n`,
    );
    log.info("wa_retention_finished", { deleted: res.rows[0]?.n ?? 0, days: WA_RETENTION_DAYS });
  } finally {
    await end();
  }
}

main().catch((err: unknown) => {
  log.error("wa_retention_failed", { err });
  process.exit(1);
});
