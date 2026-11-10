/**
 * Super Admin hesap aracı: `node dist/admin-user.js <komut> [--email e] [--name ad]`
 * (uygulama konteynerinde; DATABASE_ADMIN_URL ve ADMIN_SECRET_KEY tanımlı olmalı).
 *
 *   create        yeni yönetici (şifre ADMIN_NEW_PASSWORD ortam değişkeninden; komut satırında değil)
 *   reset-2fa     yeni TOTP sırrı (kayıp telefon); tüm oturumlar kapanır
 *   reset-password şifre yenileme (ADMIN_NEW_PASSWORD); tüm oturumlar kapanır, kilit kalkar
 *   disable       devre dışı bırak (tüm oturumlar kapanır)  ·  enable  yeniden etkinleştir
 *   list          yöneticiler (e-posta, ad, durum, son giriş)
 *
 * create ve reset-2fa TOTP sırrını YALNIZ bir kez ekrana yazar: kimlik doğrulama uygulamasına
 * ekleyip terminali temizleyin. Sır log'a yazılmaz; veritabanında şifreli saklanır.
 */
import { sql } from "drizzle-orm";

import { createStandaloneDb } from "../../db/standalone";
import { APP_ENVS, type AppEnv } from "../../lib/env";
import {
  AdminSetupError,
  createAdminUser,
  resetAdminPassword,
  resetAdminTotp,
  setAdminStatus,
} from "./auth";
import { readAdminConfig } from "./env";

/** Komut çıktısı (log değil; terminale). */
const out = (text: string) => void process.stdout.write(`${text}\n`);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function need(v: string | undefined, what: string): string {
  if (!v) throw new AdminSetupError(`${what} gerekli.`);
  return v;
}

async function main() {
  const cmd = process.argv[2];
  const appEnv = process.env.APP_ENV as AppEnv | undefined;
  if (!appEnv || !(APP_ENVS as readonly string[]).includes(appEnv)) {
    throw new AdminSetupError("APP_ENV tanımlı değil.");
  }
  const cfg = readAdminConfig(
    process.env,
    appEnv,
    process.env.ADMIN_URL ?? "https://admin.invalid",
  );
  if (!cfg.ok) throw new AdminSetupError(cfg.reason);
  const { db, end } = createStandaloneDb(cfg.config.dbUrl, {
    max: 1,
    application_name: "kiraligim-admin-cli",
  });
  try {
    switch (cmd) {
      case "create": {
        const r = await createAdminUser(
          db,
          {
            email: need(arg("email"), "--email"),
            name: need(arg("name"), "--name"),
            password: need(process.env.ADMIN_NEW_PASSWORD, "ADMIN_NEW_PASSWORD"),
          },
          cfg.config.key,
        );
        printSecret("Yönetici oluşturuldu.", r.secret, r.uri);
        break;
      }
      case "reset-2fa": {
        const r = await resetAdminTotp(db, need(arg("email"), "--email"), cfg.config.key);
        printSecret(
          "Yeni iki adımlı doğrulama sırrı oluşturuldu; eski oturumlar kapandı.",
          r.secret,
          r.uri,
        );
        break;
      }
      case "reset-password":
        await resetAdminPassword(
          db,
          need(arg("email"), "--email"),
          need(process.env.ADMIN_NEW_PASSWORD, "ADMIN_NEW_PASSWORD"),
        );
        out("Şifre güncellendi; tüm oturumlar kapandı.");
        break;
      case "disable":
      case "enable":
        await setAdminStatus(
          db,
          need(arg("email"), "--email"),
          cmd === "disable" ? "disabled" : "active",
        );
        out(cmd === "disable" ? "Yönetici devre dışı bırakıldı." : "Yönetici etkinleştirildi.");
        break;
      case "list": {
        const r = await db.execute<{
          email: string;
          name: string;
          status: string;
          last_login_at: Date | null;
        }>(sql`select email, name, status, last_login_at from admin_users order by email`);
        for (const u of r.rows) {
          out(`${u.email}\t${u.name}\t${u.status}\t${u.last_login_at?.toISOString() ?? "-"}`);
        }
        break;
      }
      default:
        throw new AdminSetupError(
          "Komut: create | reset-2fa | reset-password | disable | enable | list",
        );
    }
  } finally {
    await end();
  }
}

function printSecret(title: string, secret: string, uri: string) {
  out(
    [
      title,
      "",
      "Kimlik doğrulama uygulamasına (Google Authenticator, 1Password…) ekleyin:",
      `  Sır (elle giriş): ${secret.replace(/(.{4})/g, "$1 ").trim()}`,
      `  Bağlantı: ${uri}`,
      "",
      "Bu bilgi yalnız şimdi gösterilir. Ekledikten sonra terminali temizleyin (clear).",
    ].join("\n"),
  );
}

main().catch((err: unknown) => {
  // Ham hata nesnesi yazılmaz (bağlantı adresi veya parametre içerebilir).
  console.error(
    err instanceof AdminSetupError
      ? err.message
      : `Hata: ${err instanceof Error ? err.name : "bilinmiyor"}`,
  );
  process.exit(1);
});
