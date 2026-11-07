// Next.js dışında çalışan Node giriş noktalarını tek dosyaya derler (dist/).
// dist/migrate.js: açılış migration'ı (docker-entrypoint.sh)
// dist/db-doctor.js: uygulama DB rolünün güvenlik denetimi.
// dist/storage-check.js: fotoğraf depolama (R2) bağlantı denetimi. Faz 2'de dist/worker.js eklenecek.
import { build } from "esbuild";

await build({
  entryPoints: {
    migrate: "src/db/migrate.ts",
    "db-doctor": "src/db/doctor.ts",
    "storage-check": "src/server/storage/check.ts",
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
