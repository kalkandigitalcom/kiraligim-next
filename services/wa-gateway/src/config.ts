/**
 * Ortam değişkenlerinden yapılandırma. Hatalı değerle süreç başlamaz.
 *
 * İki çalışma biçimi:
 *  - A1 (WA_DATABASE_URL tanımlı): grup keşfi, grup bağlama kodu ve bağlı grupların mesajlarını
 *    veritabanına yazma. Tek dışa yazım: başarılı bağlama kodu mesajına ✅.
 *  - Faz 1 test biçimi (WA_DATABASE_URL yok): test grubunun mesajlarını konsola yazar ve
 *    WA_TEST_GROUP_JID tanımlıysa o gruba tepki bırakır. Önceki test servisi bozulmasın diye korunur.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Servis klasörü (services/wa-gateway): src/'nin bir üstü; çalışma dizininden bağımsız. */
export const SERVICE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Oturum klasörü adı: ".wa-auth" ya da ".wa-auth-<etiket>" (yalnız küçük harf, rakam, - _). */
const AUTH_DIR_NAME_RE = /^\.wa-auth(-[a-z0-9_-]{1,40})?$/;

export type Config = {
  /** Bağlanmasına izin verilen tek numara (yalnız rakam, ülke koduyla). */
  allowedNumber: string;
  /** A1: geliştirme veritabanı bağlantısı (app_user). null → Faz 1 test biçimi. */
  databaseUrl: string | null;
  /** A1: wa_connections etiketi (platform numarası başına bir etiket). */
  connectionLabel: string;
  /** Faz 1 test biçimi: tepki bırakılacak tek grup; A1'de kullanılmaz. */
  testGroupJid: string | null;
  reaction: string;
  httpPort: number;
  authDir: string;
};

const GROUP_JID_RE = /^[0-9]{6,40}(-[0-9]{6,20})?@g\.us$/;

/**
 * Oturum klasörü güvenli mi? Bu klasör "Oturumu sıfırla" ve oturum kapanışında TÜMÜYLE silinir;
 * bu yüzden yalnız servis klasörünün DOĞRUDAN içindeki `.wa-auth` (veya `.wa-auth-<etiket>`)
 * kabul edilir. `.`, `..`, mutlak yollar, alt/üst klasörler ve sembolik bağlantılar reddedilir.
 * Sorun yoksa null.
 */
export function authDirProblem(authDir: string, serviceDir: string): string | null {
  const dir = path.resolve(authDir);
  const base = path.resolve(serviceDir);
  if (path.dirname(dir) !== base || !AUTH_DIR_NAME_RE.test(path.basename(dir))) {
    return `WA_AUTH_DIR yalnız servis klasörü içindeki ".wa-auth" (veya ".wa-auth-<etiket>") olabilir; verilen yol reddedildi.`;
  }
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) {
      return "WA_AUTH_DIR sembolik bağlantı olamaz.";
    }
  } catch {
    /* henüz yok: ilk başlatmada oluşturulur */
  }
  return null;
}

/**
 * A1 yalnız geliştirme veritabanında çalışır: veritabanı adı "_dev" ile bitmeli ve üretim adına
 * benzememeli. Bağlantı kurulmadan önce denetlenir. Sorun yoksa null.
 */
export function databaseNameProblem(url: string): string | null {
  let name: string;
  try {
    name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    return "WA_DATABASE_URL geçerli bir postgres:// adresi değil.";
  }
  if (!name) return "WA_DATABASE_URL veritabanı adı içermiyor.";
  if (/prod/i.test(name)) {
    return `"${name}" bir üretim veritabanına benziyor; A1 yalnız geliştirme veritabanında çalışır.`;
  }
  if (!/_dev$/.test(name)) {
    return `WA_DATABASE_URL veritabanı adı "_dev" ile bitmeli (bulunan: "${name}"); A1 yalnız geliştirme veritabanında çalışır.`;
  }
  return null;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  serviceDir: string = SERVICE_DIR,
): Config {
  const errors: string[] = [];

  const allowedNumber = (env.WA_ALLOWED_NUMBER ?? env.WA_TEST_NUMBER ?? "").replace(
    /[\s+()-]/g,
    "",
  );
  if (!/^[1-9][0-9]{7,14}$/.test(allowedNumber)) {
    errors.push(
      "WA_ALLOWED_NUMBER (ya da WA_TEST_NUMBER) zorunlu: ülke koduyla yalnız rakam (ör. 905xxxxxxxxx).",
    );
  }

  const databaseUrl = env.WA_DATABASE_URL?.trim() || null;
  if (databaseUrl) {
    const problem = databaseNameProblem(databaseUrl);
    if (problem) errors.push(problem);
  }

  const connectionLabel = (env.WA_CONNECTION_LABEL ?? "primary").trim();
  if (!/^[a-z0-9_-]{1,40}$/.test(connectionLabel)) {
    errors.push("WA_CONNECTION_LABEL yalnız küçük harf, rakam, - ve _ içerebilir (en fazla 40).");
  }

  const groupRaw = (env.WA_TEST_GROUP_JID ?? "").trim();
  if (groupRaw && !GROUP_JID_RE.test(groupRaw)) {
    errors.push("WA_TEST_GROUP_JID biçimi geçersiz (ör. 1203630xxxxxxxxx@g.us).");
  }

  const reaction = (env.WA_TEST_REACTION ?? "✅").trim() || "✅";
  if ([...reaction].length > 4) errors.push("WA_TEST_REACTION tek bir emoji olmalı.");

  const httpPort = Number(env.WA_HTTP_PORT ?? 4010);
  if (!Number.isInteger(httpPort) || httpPort < 1024 || httpPort > 65535) {
    errors.push("WA_HTTP_PORT 1024–65535 arasında olmalı.");
  }

  const authDir = path.resolve(serviceDir, env.WA_AUTH_DIR?.trim() || ".wa-auth");
  const authProblem = authDirProblem(authDir, serviceDir);
  if (authProblem) errors.push(authProblem);

  if (errors.length) throw new Error(`Yapılandırma hatası:\n- ${errors.join("\n- ")}`);
  return {
    allowedNumber,
    databaseUrl,
    connectionLabel,
    // A1 biçiminde test grubu tepkisi kapalı: tek dışa yazım bağlama kodu ✅'idir.
    testGroupJid: databaseUrl ? null : groupRaw || null,
    reaction,
    httpPort,
    authDir,
  };
}
