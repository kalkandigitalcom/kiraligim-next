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
5. Rolleri oluşturun: [Veritabanı rolleri ve migration](#veritabanı-rolleri-ve-migration) bölümündeki
   B ve C adımları (`db_name=lodging_dev`).

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
4. Pre-deployment command **boş** bırakılır; migration konteyner açılışında çalışır (`RUN_MIGRATIONS_ON_START=true`).
5. Ortam değişkenleri (Coolify'da, "Build Variable" işaretlemeden):

   | Değişken                  | Değer                                                                           |
   | ------------------------- | ------------------------------------------------------------------------------- |
   | `APP_ENV`                 | `development`                                                                   |
   | `APP_NAME`                | `Kiralığım`                                                                     |
   | `APP_URL`                 | `https://app.dev.<alan-adı>`                                                    |
   | `ADMIN_URL`               | `https://admin.dev.<alan-adı>`                                                  |
   | `PUBLIC_URL`              | `https://dev.<alan-adı>`                                                        |
   | `DATABASE_URL`            | `postgres://app_user:<APP>@<lp-dev-db internal host>:5432/lodging_dev`          |
   | `MIGRATION_DATABASE_URL`  | `postgres://app_migrator:<MIGRATOR>@<lp-dev-db internal host>:5432/lodging_dev` |
   | `RUN_MIGRATIONS_ON_START` | `true`                                                                          |
   | `DB_ROLE_GUARD`           | `enforce`                                                                       |
   | `LOG_LEVEL`               | `debug`                                                                         |

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

## Veritabanı rolleri ve migration

### Roller

| Rol                       | Kullanan                      | Yetki                                                                                       | Env                                |
| ------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------- |
| `postgres` (Coolify)      | Yalnız kurulum ve acil durum  | Süper kullanıcı; RLS'i yok sayar                                                            | **Hiçbir uygulama env'inde olmaz** |
| `app_migrator`            | Yalnız migration              | Veritabanı ve `public` şema sahibi; tablo oluşturur. Süper kullanıcı değil, RLS'i atlayamaz | `MIGRATION_DATABASE_URL`           |
| `app_user`                | Web uygulaması                | Nesne oluşturamaz; tablo yetkileri her migration'da açıkça verilir; RLS her zaman uygulanır | `DATABASE_URL`                     |
| `app_admin`, `app_worker` | Super Admin, arka plan işleri | Şimdilik giriş kapalı                                                                       | —                                  |

Tenant tabloları `ENABLE` **ve** `FORCE ROW LEVEL SECURITY` ile oluşturulur: FORCE olmadan tablo
sahibi (`app_migrator`) RLS'ten muaftır. Süper kullanıcı FORCE'u da atlar; bu yüzden uygulama asla
`postgres` ile bağlanmaz. Bu davranışlar `tests/integration/security.test.ts` ile doğrulanır.

### Migration nasıl çalışır

`RUN_MIGRATIONS_ON_START=true` iken konteyner açılışında (`scripts/docker-entrypoint.sh`):

1. `node dist/migrate.js` çalışır (`MIGRATION_DATABASE_URL` ile). Aynı anda açılan konteynerler kilitle sıraya girer; uygulanmış migration tekrar çalışmaz.
2. Başarısızsa konteyner kapanır → sağlık kontrolü geçmez → Coolify yeni sürümü devreye almaz, eski sürüm çalışmaya devam eder.
3. Başarılıysa `MIGRATION_DATABASE_URL` ortamdan silinir ve sunucu başlar; web süreci migrator parolasını görmez.

Kural: Geçiş sırasında eski ve yeni sürüm kısa süre birlikte çalışır. Migration'lar geriye uyumlu yazılır
(önce ekle, sonra kaldır; bir kolon aynı deploy'da hem eklenip hem silinmez). Uygulanmış migration dosyası değiştirilmez.

### Rol denetimi

- Uygulama açılışta bağlandığı rolü denetler ve log'a `db_role_check_ok` veya `db_role_check_unsafe` yazar.
- `DB_ROLE_GUARD=warn` (varsayılan): yalnız log. `DB_ROLE_GUARD=enforce`: güvensiz rolde `/api/health` 503 döner, sürüm devreye girmez.
- Elle denetim (Coolify → uygulama → Terminal): `node dist/db-doctor.js` → `db_role_safe` veya `db_role_unsafe` (+ bulgular).
- Ayrıntı herkese açık `/api/health` yanıtında gösterilmez.

### Production ilk kurulum (`kiraligim_prod`)

Her adım tek başına yapılır; sonucu doğrulanmadan sonrakine geçilmez. Hiçbir adım veri silmez.

| #   | Adım                                                                                       | Doğrulama                                                                       | Geri dönüş                                    |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------- |
| A   | Bu kodu (`docker-entrypoint.sh`, rol denetimi) `main`'e alıp deploy edin. Env'e dokunmayın | `/api/health` 200; log'da `db_role_check_unsafe` (beklenen: hâlâ `postgres`)    | Önceki commit'e redeploy                      |
| B   | Coolify → veritabanı → **Backups** → elle yedek                                            | Yedek listede görünür                                                           | —                                             |
| C   | Rolleri oluşturun (aşağıdaki komut)                                                        | Son satır `Tamam: roller ve veritabanı hazır.`                                  | Roller zararsızdır; uygulama etkilenmez       |
| D   | Env: `MIGRATION_DATABASE_URL` (app_migrator) + `RUN_MIGRATIONS_ON_START=true` → Redeploy   | Log'da `migration_finished`; `/api/health` 200                                  | İki değişkeni silip redeploy                  |
| E   | Env: `DATABASE_URL`'i `app_user`'a çevirin → Redeploy                                      | Log'da `db_role_check_ok`; terminalde `node dist/db-doctor.js` → `db_role_safe` | `DATABASE_URL`'i eski haline getirip redeploy |
| F   | Env: `DB_ROLE_GUARD=enforce` → Redeploy                                                    | `/api/health` 200                                                               | Değişkeni silip redeploy                      |

F'den sonra `DATABASE_URL`'i yeniden `postgres`'e döndürmek gerekirse önce `DB_ROLE_GUARD`'ı silin;
aksi halde sağlık kontrolü 503 verir ve geri dönüş sürümü devreye girmez (bu kasıtlıdır).

**C adımı – rolleri oluşturma.** Parolaları kendi bilgisayarınızda üretip parola yöneticinize kaydedin:

```bash
openssl rand -hex 24   # app_migrator
openssl rand -hex 24   # app_user
```

Sunucuda (SSH). Parolalar `read -rs` ile girilir; ekrana, shell geçmişine ve komut satırına yazılmaz:

```bash
docker ps --format '{{.Names}}  {{.Image}}' | grep -i postgres     # Kiraligim'in konteynerini seçin
curl -fsSL https://raw.githubusercontent.com/kalkandigitalcom/kiraligim-next/main/scripts/db-bootstrap.sql -o /tmp/db-bootstrap.sql
read -rs -p "app_migrator parolası: " KG_MIGRATOR_PASSWORD; echo
read -rs -p "app_user parolası: " KG_APP_PASSWORD; echo
export KG_MIGRATOR_PASSWORD KG_APP_PASSWORD
docker exec -i -e KG_MIGRATOR_PASSWORD -e KG_APP_PASSWORD <KONTEYNER> \
  sh -c 'psql -U "$POSTGRES_USER" -d postgres -X -v ON_ERROR_STOP=1 -v db_name=kiraligim_prod -f -' \
  < /tmp/db-bootstrap.sql
unset KG_MIGRATOR_PASSWORD KG_APP_PASSWORD; rm /tmp/db-bootstrap.sql
```

Script veritabanını yeniden oluşturmaz ve veri silmez; mevcut `kiraligim_prod`'un ve `public` şemanın
sahipliğini `app_migrator`'a devreder. Parola içeren ifadeler sunucu log'una yazılmaz.

**C adımı – doğrulama (salt-okunur).**

```bash
docker exec -i "$KG_PG" sh -c 'psql -U "$POSTGRES_USER" -d kiraligim_prod -X' <<'SQL'
select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin
  from pg_roles where rolname like 'app_%' order by 1;
select pg_get_userbyid(datdba) as db_sahibi,
       (select nspowner::regrole from pg_namespace where nspname = 'public') as sema_sahibi
  from pg_database where datname = current_database();
select case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as rol,
       a.privilege_type as yetki
  from pg_namespace n, aclexplode(n.nspacl) a
 where n.nspname = 'public' order by 1, 2;
select has_database_privilege('app_user', current_database(), 'CONNECT') as app_user_baglanir,
       has_schema_privilege('app_user', 'public', 'CREATE')  as app_user_tablo_olusturur;
select count(*) as tablo_sayisi from pg_tables where schemaname not in ('pg_catalog','information_schema');
SQL
```

| Kontrol                                                              | C sonrası (bootstrap)                       | D sonrası (migration 0000–0002)                                                                              |
| -------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `app_*` rolleri: süper kullanıcı / BYPASSRLS / CREATEROLE / CREATEDB | hepsi `f`                                   | aynı                                                                                                         |
| Giriş açık                                                           | `app_migrator`, `app_user`                  | aynı                                                                                                         |
| Veritabanı ve `public` şema sahibi                                   | `app_migrator`                              | aynı                                                                                                         |
| `public` şema yetkileri                                              | `PUBLIC USAGE`, `app_migrator CREATE+USAGE` | `app_admin USAGE`, `app_migrator CREATE+USAGE`, `app_user USAGE`, `app_worker USAGE` — **PUBLIC satırı yok** |
| `app_user` bağlanır / tablo oluşturur                                | `t` / `f`                                   | `t` / `f`                                                                                                    |
| Tablo sayısı                                                         | `0`                                         | `0` (`drizzle.__migrations` `drizzle` şemasında, sayılmaz)                                                   |

C sonrasında `PUBLIC USAGE` görünmesi PostgreSQL 15+'ın varsayılanıdır; `0002_revoke_public_schema_usage` kaldırır.
PUBLIC'in veritabanına bağlanma (CONNECT) yetkisi bootstrap'ta kaldırıldığı için ara dönemde risk yoktur.

**Parola doğrulama testleri.** Parolalar `read -rs` ile girilir. `PGPASSWORD="$…" docker exec -e PGPASSWORD`
biçiminde değer komut argümanlarına girmez (`ps` ve shell geçmişinde yalnız değişken adı görünür).
`-w` psql'in parola sormasını engeller; `PGPASSFILE=/nonexistent` konteynerdeki olası bir `.pgpass`'ın
kullanılmasını önler; bağlantı konteynerin ağ adresinden yapılır (uygulamanın yolu).

```bash
read -rs -p "app_user parolası: " KG_APP_PASSWORD; echo
read -rs -p "app_migrator parolası: " KG_MIGRATOR_PASSWORD; echo
echo "${#KG_APP_PASSWORD} ${#KG_MIGRATOR_PASSWORD}"      # 48 48

kg_login() {  # kullanım: PGPASSWORD=... kg_login <rol>
  docker exec -i -e PGPASSWORD -e PGPASSFILE=/nonexistent -e KG_ROLE="$1" "$KG_PG" \
    sh -c 'ip=$(hostname -i | cut -d" " -f1); psql -w -h "$ip" -U "$KG_ROLE" -d kiraligim_prod -X -tA -v ON_ERROR_STOP=1 -f -' <<'SQL'
select current_user || ' | ' || coalesce(system_user, 'PAROLASIZ GIRIS!');
SQL
  echo "exit=$?"
}

PGPASSWORD="$KG_APP_PASSWORD"      kg_login app_user       # app_user | scram-sha-256:app_user      exit=0
PGPASSWORD="$KG_MIGRATOR_PASSWORD" kg_login app_migrator   # app_migrator | scram-sha-256:app_migrator  exit=0
PGPASSWORD="yanlis-parola-$RANDOM" kg_login app_user       # FATAL: password authentication failed  exit=2

unset KG_APP_PASSWORD KG_MIGRATOR_PASSWORD; unset -f kg_login
```

| Sonuç                                            | Anlamı                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `… \| scram-sha-256:<rol>` ve `exit=0`           | Parola doğrulandı (SCRAM). Beklenen.                                                                                                       |
| `… \| PAROLASIZ GIRIS!`                          | Bağlantı parola sorulmadan kabul edildi (`trust`). **Dur.**                                                                                |
| Yanlış parolada `password authentication failed` | Parola gerçekten kontrol ediliyor. Beklenen.                                                                                               |
| `fe_sendauth: no password supplied`              | `PGPASSWORD` konteynere ulaşmadı (ör. `sudo` ortamı sildi); bu bir parola testi **değildir**. `sudo --preserve-env=PGPASSWORD …` kullanın. |
| Yanlış parolada `exit=0`                         | Parola kontrol edilmiyor. **Dur.**                                                                                                         |

**D ve E adımlarındaki bağlantı adresleri.** Host kısmını Coolify'daki veritabanı sayfasının
"Postgres URL (internal)" alanından alın; kullanıcı ve parolayı oradan **kullanmayın**:

```
MIGRATION_DATABASE_URL=postgres://app_migrator:<MIGRATOR_PAROLASI>@<iç-host>:5432/kiraligim_prod
DATABASE_URL=postgres://app_user:<APP_PAROLASI>@<iç-host>:5432/kiraligim_prod
```

Coolify'da bu değişkenler **Build Variable olarak işaretlenmez** (yalnız çalışma zamanı).

### Sonraki migration'lar

1. Şema `src/db/schema` altında değişir → `npm run db:generate` (RLS/yetki için `npm run db:generate:custom`).
2. CI tüm migration'ları boş veritabanına sıfırdan uygular ve testleri koşturur.
3. Deploy'da konteyner açılışında uygulanır. Production'dan önce Coolify'da elle yedek alınır.
