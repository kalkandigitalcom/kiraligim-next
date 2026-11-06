import { z } from "zod";

/**
 * Ortam değişkenleri tek yerden, Zod ile doğrulanır.
 * Eksik ya da hatalı değer varsa uygulama açılmaz.
 * Değerler ilk kullanımda okunur; böylece `next build` sırasında sır gerekmez.
 */

export const APP_ENVS = ["local", "test", "development", "production"] as const;
export type AppEnv = (typeof APP_ENVS)[number];

/** Her ortamın kullanabileceği veritabanı adı soneki (emniyet kemeri). */
const DB_SUFFIX: Record<AppEnv, string> = {
  local: "_dev",
  development: "_dev",
  test: "_test",
  production: "_prod",
};

const postgresUrl = z
  .string()
  .min(1)
  .refine((v) => /^postgres(ql)?:\/\//.test(v), "postgres:// ile başlamalı");

const httpUrl = z.url({ protocol: /^https?$/ });

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    APP_ENV: z.enum(APP_ENVS),
    APP_NAME: z.string().trim().min(1).max(60),
    APP_URL: httpUrl,
    ADMIN_URL: httpUrl,
    PUBLIC_URL: httpUrl,
    DATABASE_URL: postgresUrl,
    LOG_LEVEL: z.preprocess(
      emptyToUndefined,
      z.enum(["debug", "info", "warn", "error"]).optional(),
    ),
    APP_VERSION: z.preprocess(emptyToUndefined, z.string().max(64).optional()),
  })
  .superRefine((env, ctx) => {
    const hosts = [env.APP_URL, env.ADMIN_URL, env.PUBLIC_URL].map((u) => new URL(u).host);
    if (new Set(hosts).size !== hosts.length) {
      ctx.addIssue({
        code: "custom",
        path: ["ADMIN_URL"],
        message: "APP_URL, ADMIN_URL ve PUBLIC_URL farklı host'lar olmalı",
      });
    }
    if (env.APP_ENV === "production") {
      for (const key of ["APP_URL", "ADMIN_URL", "PUBLIC_URL"] as const) {
        if (new URL(env[key]).protocol !== "https:") {
          ctx.addIssue({ code: "custom", path: [key], message: "production'da https zorunlu" });
        }
      }
    }
    const dbIssue = checkDatabaseName(env.APP_ENV, env.DATABASE_URL);
    if (dbIssue) ctx.addIssue({ code: "custom", path: ["DATABASE_URL"], message: dbIssue });
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Yanlış veritabanına bağlanmayı engeller: production yalnız `*_prod`,
 * geliştirme/yerel yalnız `*_dev`, test yalnız `*_test` adlı veritabanına bağlanır.
 */
export function checkDatabaseName(appEnv: AppEnv, url: string): string | null {
  let dbName: string;
  try {
    dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    return "Geçersiz veritabanı adresi";
  }
  const suffix = DB_SUFFIX[appEnv];
  if (!dbName.endsWith(suffix)) {
    return `APP_ENV=${appEnv} iken veritabanı adı "${suffix}" ile bitmeli (bulunan: "${dbName || "boş"}")`;
  }
  return null;
}

export class EnvError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Ortam değişkenleri geçersiz:\n- ${issues.join("\n- ")}`);
    this.name = "EnvError";
  }
}

/** Hata mesajlarında değerler değil, yalnız değişken adları ve kurallar yer alır. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvError(
      result.error.issues.map((i) => `${i.path.join(".") || "(genel)"}: ${i.message}`),
    );
  }
  return result.data;
}

let cached: Env | undefined;

export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Yalnız testler için. */
export function resetEnvCache(): void {
  cached = undefined;
}
