/**
 * Super Admin yapılandırması. Ana env şemasından ayrı ve tembel okunur: tanımlı değilse yönetim
 * paneli "yapılandırılmamış" der, uygulamanın geri kalanı etkilenmez.
 *
 *  - DATABASE_ADMIN_URL: app_admin rolüyle bağlantı (scripts/admin-role.sql ile LOGIN açılır).
 *    Veritabanı adı ortam kuralına uymalı (production: *_prod).
 *  - ADMIN_SECRET_KEY: base64 kodlu 32 bayt (openssl rand -base64 32). TOTP sırlarını şifreler;
 *    değişirse mevcut yöneticilerin 2FA'sı yeniden kurulmalıdır (dist/admin-user.js reset-2fa).
 */
import { type AppEnv, checkDatabaseName } from "@/lib/env";

import { parseSecretKey } from "./crypto";

export type AdminConfig = { dbUrl: string; key: Buffer; secureCookies: boolean };
export type AdminConfigResult = { ok: true; config: AdminConfig } | { ok: false; reason: string };

export function readAdminConfig(
  source: Record<string, string | undefined>,
  appEnv: AppEnv,
  adminUrl: string,
): AdminConfigResult {
  const dbUrl = source.DATABASE_ADMIN_URL?.trim();
  if (!dbUrl) return { ok: false, reason: "DATABASE_ADMIN_URL tanımlı değil" };
  if (!/^postgres(ql)?:\/\//.test(dbUrl)) {
    return { ok: false, reason: "DATABASE_ADMIN_URL postgres:// ile başlamalı" };
  }
  const dbIssue = checkDatabaseName(appEnv, dbUrl);
  if (dbIssue) return { ok: false, reason: `DATABASE_ADMIN_URL: ${dbIssue}` };
  try {
    if (new URL(dbUrl).username !== "app_admin") {
      return { ok: false, reason: "DATABASE_ADMIN_URL app_admin rolüyle bağlanmalı" };
    }
  } catch {
    return { ok: false, reason: "DATABASE_ADMIN_URL geçersiz" };
  }
  const key = parseSecretKey(source.ADMIN_SECRET_KEY);
  if (!key) {
    return {
      ok: false,
      reason: "ADMIN_SECRET_KEY base64 kodlu 32 bayt olmalı (openssl rand -base64 32)",
    };
  }
  const secureCookies = new URL(adminUrl).protocol === "https:";
  if (appEnv === "production" && !secureCookies) {
    return { ok: false, reason: "production'da ADMIN_URL https olmalı" };
  }
  return { ok: true, config: { dbUrl, key, secureCookies } };
}
