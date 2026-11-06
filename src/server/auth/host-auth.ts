import "server-only";

import { type BetterAuthOptions, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { uuidv7 } from "uuidv7";

import { getBrand } from "@/config/brand";
import { type Database, getDb } from "@/db/client";
import { authSchema } from "@/db/schema/auth";
import { resetPasswordTemplate, verifyEmailTemplate } from "@/lib/email/templates";
import type { EmailTransport } from "@/lib/email/types";
import { type Env, getEnv } from "@/lib/env";
import { logger as rootLogger } from "@/lib/logger";

import { getEmailTransport } from "./email";
import { type AuthEnv, getAuthEnv } from "./env";

/**
 * Ev sahibi kimlik sistemi (Better Auth) — yalnız app.<alan-adı> için.
 *
 * Aşama 2.0'da bu yapılandırma HİÇBİR ROUTE'A BAĞLANMAMIŞTIR: /api/auth uç noktası yoktur,
 * tablolar da henüz oluşturulmamıştır (migration 0003, Aşama 2.1).
 * Super Admin bu örneği ve tablolarını kullanmaz (ayrı örnek ve tablolar, Aşama 2.3).
 */

export const AUTH_BASE_PATH = "/api/auth";
export const AUTH_COOKIE_PREFIX = "kg";

const log = rootLogger.child({ component: "auth" });

export type HostAuthDeps = {
  env: Pick<Env, "APP_ENV" | "APP_URL">;
  authEnv: AuthEnv;
  db: Database;
  email: EmailTransport;
  brandName: string;
  /** Testlerde kapatılabilir; aksi halde her ortamda açık. */
  rateLimitEnabled?: boolean;
};

export function buildHostAuthOptions(deps: HostAuthDeps) {
  const { env, authEnv, email, brandName } = deps;

  // Doğrulama ve sıfırlama e-postaları beklenmeden gönderilir: yanıt süresinden hesabın
  // var olup olmadığı anlaşılmasın. Hata log'a düşer, isteği bozmaz.
  const sendInBackground = (category: string, task: () => Promise<unknown>) => {
    void task().catch((err: unknown) => log.error("auth_email_failed", { category, err }));
  };

  return {
    appName: brandName,
    baseURL: env.APP_URL,
    basePath: AUTH_BASE_PATH,
    secret: authEnv.BETTER_AUTH_SECRET,
    // Yalnız ev sahibi paneli. Admin ve public alan adları bu oturumu kullanamaz.
    trustedOrigins: [env.APP_URL],
    telemetry: { enabled: false },

    database: drizzleAdapter(deps.db, {
      provider: "pg",
      schema: authSchema,
      usePlural: true,
    }),

    emailAndPassword: {
      enabled: true,
      disableSignUp: !authEnv.AUTH_SIGNUP_ENABLED,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        const tpl = resetPasswordTemplate({ brand: brandName, name: user.name, url });
        sendInBackground("auth.reset-password", () =>
          email.send({ to: user.email, category: "auth.reset-password", ...tpl }),
        );
      },
    },

    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: false,
      expiresIn: 60 * 60,
      sendVerificationEmail: async ({ user, url }) => {
        const tpl = verifyEmailTemplate({ brand: brandName, name: user.name, url });
        sendInBackground("auth.verify-email", () =>
          email.send({ to: user.email, category: "auth.verify-email", ...tpl }),
        );
      },
    },

    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },

    user: {
      // Hesap silme KVKK süreciyle ayrıca tasarlanacak.
      deleteUser: { enabled: false },
      changeEmail: { enabled: false },
    },
    account: { accountLinking: { enabled: false } },

    // Şifre sıfırlama vb. belirteçler veritabanında özet (hash) olarak saklanır.
    verification: { storeIdentifier: "hashed" },

    // Deneme sınırı veritabanında (rate_limits): konteyner yeniden başlasa da sayaçlar korunur.
    rateLimit: {
      enabled: deps.rateLimitEnabled ?? true,
      storage: "database",
      window: 60,
      max: 100,
    },

    advanced: {
      database: { generateId: () => uuidv7() },
      cookiePrefix: AUTH_COOKIE_PREFIX,
      useSecureCookies: env.APP_ENV === "production",
      // Çerez yalnız app.<alan-adı> host'una ait; kök alan ve admin alt alanı göremez.
      crossSubDomainCookies: { enabled: false },
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
      // Better Auth test ortamında köken (CSRF) denetimini varsayılan olarak atlar; burada her
      // ortamda açık tutulur ki testler production davranışını doğrulasın.
      disableOriginCheck: false,
      ipAddress: {
        ipAddressHeaders: [authEnv.AUTH_IP_HEADER],
        ...(authEnv.AUTH_TRUSTED_PROXIES.length > 0
          ? { trustedProxies: authEnv.AUTH_TRUSTED_PROXIES }
          : {}),
      },
    },

    logger: {
      level: "warn",
      // Better Auth'un ek argümanları (istek/kullanıcı verisi içerebilir) log'a yazılmaz.
      log: (level, message) => {
        const fn = level === "error" ? log.error : level === "warn" ? log.warn : log.info;
        fn("better_auth", { betterAuthLevel: level, message });
      },
    },
  } satisfies BetterAuthOptions;
}

export function createHostAuth(deps: HostAuthDeps) {
  return betterAuth(buildHostAuthOptions(deps));
}

export type HostAuth = ReturnType<typeof createHostAuth>;

let instance: HostAuth | undefined;

export function getHostAuth(): HostAuth {
  instance ??= createHostAuth({
    env: getEnv(),
    authEnv: getAuthEnv(),
    db: getDb(),
    email: getEmailTransport(),
    brandName: getBrand().name,
  });
  return instance;
}
