"use client";

import { createAuthClient } from "better-auth/client";

/**
 * Tarayıcı tarafı Better Auth istemcisi. İstekler aynı kökene (app.<alan-adı>/api/auth) gider;
 * böylece Better Auth'un deneme sınırı ve köken (CSRF) denetimi her istekte uygulanır.
 * Şifreler yalnız Better Auth'a iletilir; uygulama kodu saklamaz ve işlemez.
 */
export const authClient = createAuthClient({ basePath: "/api/auth" });

/** E-posta bağlantılarının döneceği sayfalar (göreli yol: yalnız aynı köken). */
export const AUTH_PATHS = {
  verifyCallback: "/eposta-dogrulama?durum=tamam",
  resetCallback: "/sifre-sifirla",
} as const;
