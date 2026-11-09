// Next.js dışında çalışan Node giriş noktalarını tek dosyaya derler (dist/).
// dist/migrate.js: açılış migration'ı (docker-entrypoint.sh)
// dist/db-doctor.js: uygulama DB rolünün güvenlik denetimi.
// dist/storage-check.js: fotoğraf depolama (R2) bağlantı denetimi. Faz 2'de dist/worker.js eklenecek.
// dist/ical-sync.js: harici takvim (iCal) otomatik senkronu (Coolify Scheduled Task).
// dist/wa-retention.js: WhatsApp mesaj saklama süresi temizliği (Coolify Scheduled Task).
import { build } from "esbuild";

await build({
  entryPoints: {
    migrate: "src/db/migrate.ts",
    "db-doctor": "src/db/doctor.ts",
    "storage-check": "src/server/storage/check.ts",
    "ical-sync": "src/server/ical/cron.ts",
    "wa-retention": "src/server/whatsapp/retention.ts",
  },
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  sourcemap: true,
  // pg'nin isteğe bağlı yerel sürücüsü kullanılmıyor.
  external: ["pg-native"],
  logLevel: "info",
});
