import path from "node:path";

import type { NextConfig } from "next";

import { staticSecurityHeaders } from "./src/lib/security-headers";

// Proje kökü açıkça sabitlenir. Aksi halde üst dizinlerdeki başka bir package-lock.json
// (ör. ev dizinindeki) kök sanılır: Turbopack tüm ev dizinini izler ve standalone çıktı kayar.
const projectRoot = path.resolve(__dirname);

const nextConfig: NextConfig = {
  outputFileTracingRoot: projectRoot,
  // Docker imajı için yalnız gerekli dosyaları içeren çıktı (.next/standalone).
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  // CSP nonce'u istek başına üretildiği için paneller dinamik render edilir.
  // cacheComponents, public sayfalar geldiğinde (Faz 9) ayrıca değerlendirilecek.
  turbopack: {
    root: projectRoot,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: staticSecurityHeaders() }];
  },
};

export default nextConfig;
