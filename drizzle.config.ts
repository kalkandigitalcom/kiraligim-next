import { defineConfig } from "drizzle-kit";

/**
 * `npm run db:generate` veritabanına bağlanmadan SQL migration dosyası üretir.
 * RLS, roller ve özel kısıtlar için: `npm run db:generate:custom -- --name <ad>`.
 * Uygulanmış dosyalar değiştirilmez (CI kontrol eder).
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  casing: "snake_case",
  strict: true,
  verbose: true,
  dbCredentials: { url: process.env.MIGRATION_DATABASE_URL ?? "" },
  migrations: { schema: "drizzle", table: "__migrations" },
});
