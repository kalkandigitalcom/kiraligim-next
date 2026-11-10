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

/** Çalışma ortamı: veritabanı adı ve veritabanı rolü kuralları buna göre denetlenir. */
export type WaEnv = "development" | "production";

export type Config = {
  /** development (varsayılan): yalnız "*_dev"; production: yalnız "*_prod" ve app_wa_gateway rolü. */
  env: WaEnv;
  /** Bağlanmasına izin verilen tek numara (yalnız rakam, ülke koduyla). */
  allowedNumber: string;
  /** A1: geliştirme veritabanı bağlantısı (app_user). null → Faz 1 test biçimi. */
  databaseUrl: string | null;
  /** A1: wa_connections etiketi (platform numarası başına bir etiket). */
  connectionLabel: string;
  /** Faz 1 test biçimi: tepki bırakılacak tek grup; A1'de kullanılmaz. */
  testGroupJid: string | null;
  reaction: string;
  /** Yerel arayüz adresi: 127.0.0.1 (varsayılan) ya da konteyner içinde 0.0.0.0. */
  httpHost: string;
  httpPort: number;
  authDir: string;
  /**
   * WhatsApp Web protokol sürümü. null: kurulu ve test edilmiş Baileys sürümünün kendi değeri
   * (önerilen). Her bağlantıda GitHub'dan sürüm ÇEKİLMEZ. Güncelleme kontrollü bir işlemdir
   * (README → "Protokol sürümü"); WA_PROTOCOL_VERSION yalnız geçici geçersiz kılma içindir.
   */
  protocolVersion: [number, number, number] | null;
  /** WA_TRACE=1: mesaj alımı için yalnız metadata günlüğü (metin/numara yok). */
  trace: boolean;
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
 * Yanlış veritabanına bağlanmayı engeller (bağlantı kurulmadan önce):
 *  - development: ad "_dev" ile bitmeli ve "prod" içermemeli;
 *  - production: ad "_prod" ile bitmeli (ana uygulamadaki kuralla aynı).
 * Sorun yoksa null. Hata mesajı adres/parola içermez (yalnız veritabanı adı).
 */
export function databaseNameProblem(url: string, env: WaEnv = "development"): string | null {
  let name: string;
  try {
    name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    return "WA_DATABASE_URL geçerli bir postgres:// adresi değil.";
  }
  if (!name) return "WA_DATABASE_URL veritabanı adı içermiyor.";
  if (env === "production") {
    return /_prod$/.test(name)
      ? null
      : `WA_ENV=production iken veritabanı adı "_prod" ile bitmeli (bulunan: "${name}").`;
  }
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

  const waEnvRaw = (env.WA_ENV ?? "development").trim();
  const waEnv: WaEnv = waEnvRaw === "production" ? "production" : "development";
  if (waEnvRaw !== "development" && waEnvRaw !== "production") {
    errors.push("WA_ENV yalnız development veya production olabilir.");
  }

  const requireRaw = (env.WA_REQUIRE_DATABASE ?? "").trim();
  if (requireRaw && requireRaw !== "true" && requireRaw !== "false") {
    errors.push("WA_REQUIRE_DATABASE yalnız true veya false olabilir.");
  }
  // production her zaman veritabanı ister: Faz 1 test biçimine (mesajı konsola yazan) düşmez.
  const requireDatabase = requireRaw === "true" || waEnv === "production";

  const databaseUrl = env.WA_DATABASE_URL?.trim() || null;
  if (databaseUrl) {
    const problem = databaseNameProblem(databaseUrl, waEnv);
    if (problem) errors.push(problem);
  } else if (requireDatabase) {
    errors.push(
      "WA_DATABASE_URL zorunlu (WA_REQUIRE_DATABASE=true veya WA_ENV=production); Faz 1 test biçimi kapalı.",
    );
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

  // Arayüz yalnız yerel adrese ya da (konteynerde) tüm arayüzlere bağlanır; dışarıya açmak port
  // eşlemesiyle (127.0.0.1:4010:4010) sınırlandırılır. Host başlığı denetimi her durumda sürer.
  const httpHost = (env.WA_HTTP_HOST ?? "127.0.0.1").trim();
  if (httpHost !== "127.0.0.1" && httpHost !== "0.0.0.0") {
    errors.push("WA_HTTP_HOST yalnız 127.0.0.1 veya 0.0.0.0 olabilir.");
  }

  const httpPort = Number(env.WA_HTTP_PORT ?? 4010);
  if (!Number.isInteger(httpPort) || httpPort < 1024 || httpPort > 65535) {
    errors.push("WA_HTTP_PORT 1024–65535 arasında olmalı.");
  }

  const authDir = path.resolve(serviceDir, env.WA_AUTH_DIR?.trim() || ".wa-auth");
  const authProblem = authDirProblem(authDir, serviceDir);
  if (authProblem) errors.push(authProblem);

  const versionRaw = (env.WA_PROTOCOL_VERSION ?? "").trim();
  let protocolVersion: [number, number, number] | null = null;
  if (versionRaw) {
    const m = /^(\d{1,4})\.(\d{1,6})\.(\d{1,12})$/.exec(versionRaw);
    if (m) protocolVersion = [Number(m[1]), Number(m[2]), Number(m[3])];
    else errors.push("WA_PROTOCOL_VERSION biçimi geçersiz (ör. 2.3000.1043857760).");
  }

  const traceRaw = (env.WA_TRACE ?? "").trim();
  if (traceRaw && !["0", "1", "true", "false"].includes(traceRaw)) {
    errors.push("WA_TRACE yalnız 0, 1, true veya false olabilir.");
  }
  const trace = traceRaw === "1" || traceRaw === "true";

  if (errors.length) throw new Error(`Yapılandırma hatası:\n- ${errors.join("\n- ")}`);
  return {
    env: waEnv,
    allowedNumber,
    databaseUrl,
    connectionLabel,
    // A1 biçiminde test grubu tepkisi kapalı: tek dışa yazım bağlama kodu ✅'idir.
    testGroupJid: databaseUrl ? null : groupRaw || null,
    reaction,
    httpHost,
    httpPort,
    authDir,
    protocolVersion,
    trace,
  };
}
