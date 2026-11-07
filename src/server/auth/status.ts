import "server-only";

import { logger } from "@/lib/logger";

import { AuthEnvError, getAuthEnv } from "./env";

/**
 * Kimlik sistemi kullanılabilir mi? Ortam değişkenleri eksik/hatalıysa (ör. production'da
 * BETTER_AUTH_SECRET veya Resend henüz tanımlı değilse) sayfalar 500 vermek yerine
 * "geçici olarak kullanılamıyor" gösterir, /api/auth 503 döner. Değerler değil, yalnız
 * değişken adları log'a yazılır (AuthEnvError mesajı değer içermez).
 */
export type AuthStatus =
  | {
      available: true;
      signupEnabled: boolean;
      /** "log": e-posta GÖNDERİLMEZ, sunucu log'una yazılır (yalnız yerel geliştirme). */
      emailDelivery: "resend" | "log" | "memory";
    }
  | { available: false };

let warned = false;

export function getAuthStatus(): AuthStatus {
  try {
    const env = getAuthEnv();
    return {
      available: true,
      signupEnabled: env.AUTH_SIGNUP_ENABLED,
      emailDelivery: env.EMAIL_TRANSPORT,
    };
  } catch (err) {
    if (!(err instanceof AuthEnvError)) throw err;
    if (!warned) {
      warned = true;
      logger.error("auth_unavailable", { issues: err.issues });
    }
    return { available: false };
  }
}
