/**
 * Giriş noktası: `npm start` (Mac) ya da konteynerde `node --import tsx src/main.ts`.
 * Tek kopya: aynı oturumu iki süreç açarsa WhatsApp ikisini de düşürür; kilit dosyası bunu önler.
 */
import { loadConfig } from "./config.ts";
import { acquireLock } from "./lock.ts";
import { startServer } from "./server.ts";
import { WaGateway } from "./session.ts";
import { createPool, databaseRoleProblem, WaStore } from "./store.ts";

async function main() {
  // Yapılandırma (oturum klasörü, ortam ve veritabanı adı) bağlantıdan ÖNCE denetlenir.
  const config = loadConfig();
  const release = acquireLock(`${config.authDir}.lock`);
  const pool = config.databaseUrl ? createPool(config.databaseUrl, config.env) : null;
  if (pool) {
    // Bağlantıyı ve rolü başlangıçta doğrula (yanlış adres/rol erken fark edilsin; adres yazılmaz).
    const roleProblem = await databaseRoleProblem(pool, config.env);
    if (roleProblem) {
      await pool.end();
      release();
      throw new Error(roleProblem);
    }
    console.log(
      `[wa] A1 biçimi (${config.env}): veritabanına bağlanıldı (grup keşfi + mesaj kuyruğu).`,
    );
  } else {
    console.log("[wa] Faz 1 test biçimi: WA_DATABASE_URL tanımlı değil, veritabanı kullanılmıyor.");
  }
  const gw = new WaGateway(config, pool ? new WaStore(pool, config.connectionLabel) : null);
  const server = startServer(gw, config.httpPort, config.testGroupJid, config.httpHost);

  const shutdown = async (signal: string) => {
    console.log(`[wa] ${signal} alındı; bağlantı kapatılıyor (oturum korunur).`);
    await gw.stop();
    server.close();
    await pool?.end();
    release();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await gw.start();
}

main().catch((e: unknown) => {
  console.error(`[wa] Başlatılamadı: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
