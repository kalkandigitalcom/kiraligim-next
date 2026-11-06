# Coolify kurulum kontrol listesi

Bu adımlar **sunucuda** yapılır ve sizin onayınız ve uygulamanızla ilerler.
Mevcut Kalkan Digital ve diğer projelerin hiçbir kaynağına, ağına, veritabanına veya alan adına dokunulmaz.
Her adımın sonunda "Doğrulama" satırı kontrol edilir.

## S1. GitHub deposu

1. GitHub'da **private** `kiraligim` deposu oluşturun (README eklemeden).
2. Mac'te proje klasöründe:
   ```bash
   git remote add origin git@github.com:<hesap>/kiraligim.git
   git push -u origin main
   git switch -c develop && git push -u origin develop
   ```
3. Branch protection (`main` ve `develop`): PR zorunlu, **CI** kontrolleri geçmeli, force-push kapalı.

Doğrulama: PR açınca "CI / Lint, tip, test, build" ve "CI / Docker imajı" yeşil.

## S2. Coolify projesi

1. Coolify → Projects → **New Project**: `kiraligim`
2. Ortamlar: `development` ve `production` (production'ın kuruluşu Faz 2 sonunda).

## S3. Geliştirme veritabanı (`lp-dev-db`)

1. `development` ortamında **New Resource → PostgreSQL 17**. Ad: `lp-dev-db`
2. **Make it publicly available: KAPALI.**
3. Ports Mappings: **`127.0.0.1:55432:5432`**
   > ⚠️ Başında `127.0.0.1:` olmayan `55432:5432` eşlemesi Postgres'i internete açar
   > (Docker, ufw kurallarını atlayabilir). Öneki mutlaka yazın.
4. Kalıcı volume açık (varsayılan). Başlatın.
5. Kurulum script'ini çalıştırın. Mac'te iki güçlü parola üretin:
   ```bash
   openssl rand -hex 24   # migrator parolası
   openssl rand -hex 24   # app_user parolası
   ```
   Sunucuda (SSH ile), script'i konteynere gönderin:
   ```bash
   docker exec -i <lp-dev-db-konteyneri> psql -U postgres \
     -v db_name=lodging_dev \
     -v migrator_password='<MIGRATOR>' \
     -v app_password='<APP>' \
     -f - < db-bootstrap.sql
   ```
   (`db-bootstrap.sql` dosyasını `scp scripts/db-bootstrap.sql sunucu:~/` ile kopyalayın; iş bitince silin.)

Doğrulama: çıktının son satırı `Tamam: roller ve veritabanı hazır.`

## S4. Güvenlik doğrulaması

1. Kendi bilgisayarınızdan (sunucu dışından): `nc -vz <sunucu-ip> 55432` ve `nc -vz <sunucu-ip> 5432` → **bağlanamamalı**.
2. Hetzner Cloud Firewall kullanıyorsanız 5432/55432 için kural **eklemeyin**.
3. Mac'te `.env.local` içine `DB_TUNNEL_SSH=kullanici@sunucu-ip` yazın, `npm run db:tunnel` çalıştırın.
4. `DATABASE_URL=postgres://app_user:<APP>@localhost:5433/lodging_dev` ile `npm run dev` → `/api/health` 200.

## S5. Geliştirme uygulaması (`lp-dev-web`)

1. **New Resource → Private Repository (GitHub App)**. Coolify'daki GitHub App'e **yalnız bu depoya** erişim verin.
2. Dal: `develop`. Build Pack: **Dockerfile**. Port: `3000`.
3. Health check: yol `/api/health`, port `3000`.
4. **Pre-deployment command:** `node dist/migrate.js`
5. Ortam değişkenleri (Coolify'da, "Build Variable" işaretlemeden):

   | Değişken                 | Değer                                                                           |
   | ------------------------ | ------------------------------------------------------------------------------- |
   | `APP_ENV`                | `development`                                                                   |
   | `APP_NAME`               | `Kiralığım`                                                                     |
   | `APP_URL`                | `https://app.dev.<alan-adı>`                                                    |
   | `ADMIN_URL`              | `https://admin.dev.<alan-adı>`                                                  |
   | `PUBLIC_URL`             | `https://dev.<alan-adı>`                                                        |
   | `DATABASE_URL`           | `postgres://app_user:<APP>@<lp-dev-db internal host>:5432/lodging_dev`          |
   | `MIGRATION_DATABASE_URL` | `postgres://app_migrator:<MIGRATOR>@<lp-dev-db internal host>:5432/lodging_dev` |
   | `LOG_LEVEL`              | `debug`                                                                         |

   İç host adını Coolify'daki veritabanı sayfasında "Postgres URL (internal)" alanında görürsünüz.
   O adresteki kullanıcı/parolayı **kullanmayın**; yalnız host kısmını alın.

6. Domains: üç alan adını virgülle ekleyin (`https://app.dev…,https://admin.dev…,https://dev…`).
7. Dış erişimi kapatın: Cloudflare Access veya Coolify'da basic auth.
   Health check konteynere doğrudan gittiği için etkilenmez.

Doğrulama:

- Deploy log'unda `migration_finished` satırı var.
- `https://app.dev.<alan-adı>/api/health` → `{"status":"ok", "checks":{"database":"ok"}}`.
- Üç alan adı doğru paneli açıyor, başka bir host 404 veriyor.

## S6. Production (Faz 2 sonunda)

S3–S5'in aynısı, şu farklarla:

- `lp-prod-db`: **port eşlemesi yok**. Veritabanı adı `lodging_prod`. **Farklı parolalar.**
- `lp-prod-web`: dal `main`, otomatik deploy **kapalı** (elle tetiklenir), `APP_ENV=production`, https alan adları.
- Coolify zamanlanmış yedek: günlük, R2'deki ayrı yedek bucket'ına.
- Production sırları Mac'e indirilmez.

## Production alan adları (kiraligim.com)

Uygulama hangi panelin açılacağına `Host` başlığına bakarak karar verir (`src/proxy.ts`).
Bir alt alan adının çalışması için **üç katmanın** da doğru olması gerekir; kod yalnız üçüncüsünü kontrol eder.

| Katman             | Nerede                                 | Gerekli ayar                                                                                                                                                                         |
| ------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. DNS             | Cloudflare → DNS                       | `app` ve `admin` için kayıt: `A` → sunucu IP'si (veya `CNAME` → `kiraligim.com`), **Proxied** (turuncu bulut). `www` zaten var.                                                      |
| 2. Coolify         | Uygulama → Configuration → **Domains** | Virgülle: `https://kiraligim.com,https://www.kiraligim.com,https://app.kiraligim.com,https://admin.kiraligim.com` → Save → **Redeploy** (Traefik yönlendirmesi ve sertifikalar için) |
| 3. Uygulama ortamı | Coolify → Environment Variables        | `PUBLIC_URL=https://kiraligim.com`, `APP_URL=https://app.kiraligim.com`, `ADMIN_URL=https://admin.kiraligim.com` (sonda `/` ve yol olmadan)                                          |

Cloudflare SSL/TLS modu **Full (strict)** olmalı.

Teşhis:

| Belirti                                                      | Neden                                                                                                                 |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Tarayıcı "sunucu bulunamadı" / `DNS_PROBE_FINISHED_NXDOMAIN` | 1. katman: DNS kaydı yok                                                                                              |
| Cloudflare 52x hatası veya `404 page not found` (Traefik)    | 2. katman: alan adı Coolify'a eklenmemiş ya da redeploy yapılmamış                                                    |
| Düz metin `Not found`                                        | 3. katman: env'deki URL host ile eşleşmiyor. Uygulama log'unda `unknown_host` satırı hangi host'un geldiğini gösterir |
| `www.kiraligim.com` → `kiraligim.com` 308 yönlendirmesi      | Beklenen davranış                                                                                                     |

## Migration akışı

1. Şema `src/db/schema` altında değişir → `npm run db:generate` → yeni SQL dosyası PR'a girer.
2. CI tüm migration'ları boş veritabanına sıfırdan uygular ve testleri koşturur.
3. `develop`'a birleşince Coolify dev ortamında `node dist/migrate.js` çalışır.
   Hata olursa yeni sürüm devreye girmez, eskisi çalışmaya devam eder.
4. Aynı dosyalar `main`'e geçince production'da uygulanır. Öncesinde Coolify'da elle yedek alınır.
