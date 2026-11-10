import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Modül sınırları:
 * - Veritabanı sürücüsü (pg, drizzle) yalnız src/db içinden kullanılır.
 * - Ev sahibi paneli, admin paneli ve public sayfalar birbirinin dosyalarını import etmez;
 *   ortak kod src/components, src/lib veya src/server altına konur.
 * - İstemci bileşenleri (src/components/ui) veritabanına erişemez.
 */
const dbOnly = {
  paths: [{ name: "pg", message: "pg yalnız src/db içinde kullanılır." }],
  patterns: [
    { group: ["drizzle-orm/node-postgres*"], message: "Sürücü yalnız src/db içinde kullanılır." },
  ],
};

const surfaceRule = (own) => {
  const others = ["host", "admin", "site"].filter((s) => s !== own);
  return {
    files: [`src/app/${own}/**`],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          ...dbOnly,
          patterns: [
            ...dbOnly.patterns,
            ...others.map((o) => ({
              group: [`@/app/${o}/*`, `../${o}/*`, `../../${o}/*`],
              message: `${own} yüzeyi ${o} yüzeyinden import yapamaz; ortak kodu src/components veya src/lib altına taşıyın.`,
            })),
          ],
        },
      ],
    },
  };
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/db/**"],
    rules: { "no-restricted-imports": ["error", dbOnly] },
  },
  surfaceRule("host"),
  surfaceRule("admin"),
  surfaceRule("site"),
  {
    // WhatsApp takvim worker'ı rezervasyon, iCal ve fiyat servislerini (takvime yazan kodu)
    // doğrudan import edemez. Takvime giden TEK yol src/server/whatsapp/auto-close.ts'dir (A2e:
    // sahibin açık kapatma talimatı, yalnız blok); cron.ts onu worker'a enjekte eder.
    files: ["src/server/whatsapp/calendar/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          ...dbOnly,
          patterns: [
            ...dbOnly.patterns,
            {
              group: [
                "@/server/reservations",
                "@/server/reservations/*",
                "@/server/ical",
                "@/server/ical/*",
                "@/server/rates",
                "@/server/rates/*",
                "**/server/reservations/**",
                "**/server/ical/**",
                "**/server/rates/**",
                "../../reservations/*",
                "../../ical/*",
                "../../rates/*",
              ],
              message:
                "WhatsApp takvim worker'ı yalnız öneri oluşturur; rezervasyon/iCal/fiyat servislerini import edemez.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/components/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          ...dbOnly,
          patterns: [
            ...dbOnly.patterns,
            { group: ["@/db", "@/db/*"], message: "Bileşenler veritabanına doğrudan erişemez." },
          ],
        },
      ],
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "dist/**",
    "coverage/**",
    "next-env.d.ts",
    // Ayrı servisler kendi tsconfig ve testleriyle denetlenir (services/*/npm run check).
    "services/**",
  ]),
]);

export default eslintConfig;
