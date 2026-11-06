/**
 * Drizzle kolon adlandırması: TypeScript'te camelCase alan, veritabanında snake_case kolon.
 * drizzle-kit (drizzle.config.ts) ve çalışma zamanı (src/db/client.ts) bu tek değeri kullanır;
 * ikisi farklı olursa migration'ın oluşturduğu kolonlar ile sorguların aradığı kolonlar ayrışır.
 */
export const DB_CASING = "snake_case" as const;
