import "server-only";

import { loginHref, type SignupCta, signupCta } from "@/config/marketing";
import { getEnv } from "@/lib/env";
import { getAuthStatus } from "@/server/auth/status";

/**
 * Tanıtım sitesindeki panel bağlantıları. Kayıt durumu yalnız okunur (kimlik sistemine dokunulmaz);
 * kimlik sistemi kullanılamıyorsa kayıt kapalı sayılır.
 */
export function siteLinks(): { trial: SignupCta; login: string } {
  const env = getEnv();
  const auth = getAuthStatus();
  const open = auth.available && auth.signupEnabled;
  return { trial: signupCta(open, env.APP_URL), login: loginHref(env.APP_URL) };
}
