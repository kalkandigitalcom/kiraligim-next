/**
 * Giriş noktası: `npm start` (Mac) ya da konteynerde `node --import tsx src/main.ts`.
 * Tek kopya, iki katman: yerel kilit dosyası (aynı makinede ikinci süreç) ve veritabanı biçiminde
 * PostgreSQL advisory lock (başka konteyner/sunucu dahil; kilit alınmadan WhatsApp'a bağlanılmaz).
 * Watchdog süresi dolarsa süreç kontrollü kapanır ve WATCHDOG_EXIT_CODE ile çıkar; Docker'ın
 * restart politikası (unless-stopped) temiz bir süreç başlatır. Oturum dosyaları korunur.
 */
import { loadConfig } from "./config.ts";
import { type Lease, NoopLease, PgLease } from "./lease.ts";
import { acquireLock } from "./lock.ts";
import { startServer } from "./server.ts";
import { WaGateway, WATCHDOG_EXIT_CODE } from "./session.ts";
import { createPool, databaseRoleProblem, WaStore } from "./store.ts";
import { RestartHistory } from "./watchdog.ts";

/** Kapanış en fazla bu kadar sürer (Docker'ın durdurma süresi bundan uzun olmalı: 30 sn). */
const SHUTDOWN_LIMIT_MS = 25_000;

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
  const lease: Lease = config.databaseUrl
    ? PgLease.fromUrl(config.databaseUrl, config.connectionLabel)
    : new NoopLease();

  let shuttingDown = false;
  const shutdown = async (why: string, code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[wa] ${why}; bağlantı kapatılıyor (oturum korunur).`);
    const force = setTimeout(() => {
      console.error("[wa] Kapanış süre sınırını aştı; süreç sonlandırılıyor.");
      release();
      process.exit(code === 0 ? 1 : code);
    }, SHUTDOWN_LIMIT_MS);
    force.unref();
    try {
      await gw.stop();
      server.close();
      await pool?.end();
    } catch (e: unknown) {
      console.error(`[wa] Kapanış hatası: ${e instanceof Error ? e.name : "Error"}`);
    }
    release();
    process.exit(code);
  };

  const gw = new WaGateway(config, pool ? new WaStore(pool, config.connectionLabel) : null, {
    lease,
    history: new RestartHistory(`${config.authDir}.watchdog.json`),
    onWatchdog: () => void shutdown("Watchdog süresi doldu", WATCHDOG_EXIT_CODE),
  });
  const server = startServer(gw, config.httpPort, config.testGroupJid, config.httpHost);
  console.log(
    `[wa] Protokol sürümü ${gw.protocolVersion} (sabit); watchdog ${Math.round(gw.watchdogWindowMs / 60_000)} dk.`,
  );

  process.on("SIGINT", () => void shutdown("SIGINT alındı", 0));
  process.on("SIGTERM", () => void shutdown("SIGTERM alındı", 0));

  await gw.start();
}

main().catch((e: unknown) => {
  console.error(`[wa] Başlatılamadı: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
