/**
 * Faz 1 giriş noktası: `npm start`.
 * Tek kopya: aynı oturumu iki süreç açarsa WhatsApp ikisini de düşürür; kilit dosyası bunu önler.
 */
import fs from "node:fs";

import { loadConfig } from "./config.ts";
import { startServer } from "./server.ts";
import { WaGateway } from "./session.ts";
import { createPool, WaStore } from "./store.ts";

function acquireLock(lockPath: string): () => void {
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch {
    const pid = Number(fs.readFileSync(lockPath, "utf8"));
    let alive = false;
    try {
      if (pid > 0) {
        process.kill(pid, 0);
        alive = true;
      }
    } catch {
      alive = false;
    }
    if (alive) throw new Error(`Başka bir kopya çalışıyor (pid ${pid}). Önce onu durdurun.`);
    fs.writeFileSync(lockPath, String(process.pid), { mode: 0o600 });
  }
  return () => {
    try {
      if (fs.readFileSync(lockPath, "utf8") === String(process.pid)) fs.unlinkSync(lockPath);
    } catch {
      /* zaten yok */
    }
  };
}

async function main() {
  // Yapılandırma (oturum klasörü konumu ve veritabanı adı "_dev") bağlantıdan ÖNCE denetlenir.
  const config = loadConfig();
  const release = acquireLock(`${config.authDir}.lock`);
  const pool = config.databaseUrl ? createPool(config.databaseUrl) : null;
  if (pool) {
    // Bağlantıyı başlangıçta doğrula (yanlış adres/parola erken fark edilsin; adres yazılmaz).
    await pool.query("select 1");
    console.log("[wa] A1 biçimi: veritabanına bağlanıldı (grup keşfi + mesaj kuyruğu).");
  } else {
    console.log("[wa] Faz 1 test biçimi: WA_DATABASE_URL tanımlı değil, veritabanı kullanılmıyor.");
  }
  const gw = new WaGateway(config, pool ? new WaStore(pool, config.connectionLabel) : null);
  const server = startServer(gw, config.httpPort, config.testGroupJid);

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
