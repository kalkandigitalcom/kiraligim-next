import "server-only";

import { isIP } from "node:net";

import { z } from "zod";

import { type AppEnv, getEnv } from "@/lib/env";

/**
 * Kimlik ve e-posta ayarları. Ana env şemasından ayrı ve tembel doğrulanır:
 * yalnız kimlik sistemi kullanıldığında okunur, böylece bu değişkenler henüz tanımlı olmayan
 * production ortamı (Aşama 2.0) etkilenmez.
 */

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);
const boolFromString = z
  .preprocess(emptyToUndefined, z.enum(["true", "false"]).default("false"))
  .transform((v) => v === "true");

/** "1.2.3.4", "10.0.0.0/8", "2400:cb00::/32" */
export function isValidCidr(entry: string): boolean {
  const [ip = "", prefix, ...rest] = entry.split("/");
  if (rest.length > 0) return false;
  const family = isIP(ip);
  if (family === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const n = Number(prefix);
  return family === 4 ? n <= 32 : n <= 128;
}

const EXAMPLE_SECRETS = new Set(["degistir", "change-me", "changeme"]);

export const authEnvSchema = z.object({
  // openssl rand -base64 32 → en az 32 karakter. Ortam başına farklı olmalı.
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "en az 32 karakter olmalı (openssl rand -base64 32)")
    .refine((v) => !EXAMPLE_SECRETS.has(v.toLowerCase()), "örnek değer kullanılamaz"),
  // Public kayıt (sign-up) uç noktası. Onboarding ve KVKK onayı hazır olana kadar kapalı (Aşama 2.6).
  AUTH_SIGNUP_ENABLED: boolFromString,
  // İstemci IP'sinin okunacağı başlık. Deneme sınırı (rate limit) bu IP'ye göre tutulur.
  AUTH_IP_HEADER: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^[a-z0-9-]+$/, "küçük harfli başlık adı olmalı")
      .default("x-forwarded-for"),
  ),
  // Güvenilen ters vekil (proxy) IP/CIDR listesi, virgülle. x-forwarded-for zinciri sağdan
  // bu adresler atlanarak okunur. Boşsa yalnız tek değerli başlık kabul edilir.
  AUTH_TRUSTED_PROXIES: z
    .preprocess(emptyToUndefined, z.string().optional())
    .transform((v) =>
      (v ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .refine((list) => list.every(isValidCidr), "geçersiz IP/CIDR"),
  EMAIL_TRANSPORT: z.preprocess(emptyToUndefined, z.enum(["resend", "log", "memory"]).optional()),
  RESEND_API_KEY: z.preprocess(
    emptyToUndefined,
    z.string().startsWith("re_", "Resend anahtarı re_ ile başlar").optional(),
  ),
  // "Kiralığım <bildirim@kiraligim.com>" — alan adı Resend'de doğrulanmış olmalı.
  EMAIL_FROM: z.preprocess(emptyToUndefined, z.string().min(3).optional()),
  EMAIL_REPLY_TO: z.preprocess(emptyToUndefined, z.email().optional()),
});

export type AuthEnv = Omit<z.infer<typeof authEnvSchema>, "EMAIL_TRANSPORT" | "EMAIL_FROM"> & {
  EMAIL_TRANSPORT: "resend" | "log" | "memory";
  EMAIL_FROM: string;
};

export class AuthEnvError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Kimlik ortam değişkenleri geçersiz:\n- ${issues.join("\n- ")}`);
    this.name = "AuthEnvError";
  }
}

const FROM_RE = /^(?:[^<>]+<)?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/;

/** Ortama göre ek kurallar: production'da yalnız gerçek gönderim (Resend). */
export function parseAuthEnv(appEnv: AppEnv, source: Record<string, string | undefined>): AuthEnv {
  const parsed = authEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new AuthEnvError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "(genel)"}: ${i.message}`),
    );
  }
  const e = parsed.data;
  const issues: string[] = [];

  const transport =
    e.EMAIL_TRANSPORT ?? (appEnv === "test" ? "memory" : appEnv === "local" ? "log" : undefined);
  if (!transport) issues.push("EMAIL_TRANSPORT: bu ortamda açıkça belirtilmeli (resend)");
  if (appEnv === "production" && transport !== "resend") {
    issues.push("EMAIL_TRANSPORT: production'da yalnız resend kullanılabilir");
  }
  if (transport === "memory" && appEnv !== "test") {
    issues.push("EMAIL_TRANSPORT: memory yalnız testlerde kullanılabilir");
  }
  if (transport === "resend" && !e.RESEND_API_KEY) {
    issues.push("RESEND_API_KEY: EMAIL_TRANSPORT=resend iken zorunlu");
  }
  const from =
    e.EMAIL_FROM ?? (transport === "resend" ? undefined : "Kiralığım <gelistirme@kiraligim.test>");
  if (!from) issues.push("EMAIL_FROM: EMAIL_TRANSPORT=resend iken zorunlu");
  else if (!FROM_RE.test(from))
    issues.push("EMAIL_FROM: 'Ad <adres@alan.com>' veya 'adres@alan.com' olmalı");
  if (appEnv === "production" && e.AUTH_SIGNUP_ENABLED && transport !== "resend") {
    issues.push("AUTH_SIGNUP_ENABLED: e-posta doğrulaması gönderilemezken kayıt açılamaz");
  }

  if (issues.length > 0) throw new AuthEnvError(issues);
  return { ...e, EMAIL_TRANSPORT: transport!, EMAIL_FROM: from! };
}

let cached: AuthEnv | undefined;

export function getAuthEnv(): AuthEnv {
  cached ??= parseAuthEnv(getEnv().APP_ENV, process.env);
  return cached;
}

/** Yalnız testler için. */
export function resetAuthEnvCache(): void {
  cached = undefined;
}
