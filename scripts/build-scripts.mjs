// Next.js dışında çalışan Node giriş noktalarını tek dosyaya derler (dist/).
// dist/migrate.js: ön-deploy migration. Faz 2'de dist/worker.js eklenecek.
import { build } from "esbuild";

await build({
  entryPoints: { migrate: "src/db/migrate.ts" },
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
