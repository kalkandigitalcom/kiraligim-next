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
  globalIgnores([".next/**", "out/**", "build/**", "dist/**", "coverage/**", "next-env.d.ts"]),
]);

export default eslintConfig;
