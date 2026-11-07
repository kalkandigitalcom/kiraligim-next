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

## Kimlik (Better Auth) ve e-posta

Durum (Aşama 2.3): kimlik sistemi **açık**. Uç nokta `APP_URL/api/auth/*`
(`src/app/api/auth/[...all]/route.ts`), giriş/kayıt/doğrulama/şifre sayfaları ve ilk işletme sihirbazı
app.<alan-adı> üzerinde çalışır (ayrıntılar: "Kimlik arayüzü ve uç nokta" bölümü). Kimlik tabloları
`0003_auth_tables` ve `0004_auth_grants` ile oluşur. Aşağıdaki değişkenler production'da **gereklidir**;
eksik veya hatalı olduklarında ne olduğu "Yapılandırma hataları" bölümünde anlatılır.

Değişkenler yalnız **çalışma zamanında** okunur (`src/server/auth/env.ts`); Coolify'da Build Variable
olarak işaretlenmez. Değer değişikliği yeniden deploy/yeniden başlatma ile etkinleşir.

| Değişken               | Production                | Örnek / değer                             | Kural (kodda doğrulanır)                                                                                                                                                |
| ---------------------- | ------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`   | **Zorunlu**               | `openssl rand -base64 32`                 | ≥ 32 karakter; `degistir`/`change-me`/`changeme` reddedilir. Ortam başına farklı. Değişirse tüm oturumlar düşer                                                         |
| `EMAIL_TRANSPORT`      | **Zorunlu**               | `resend`                                  | Production'da yalnız `resend`; boş bırakılamaz. `log` yalnız yerelde, `memory` yalnız testte                                                                            |
| `RESEND_API_KEY`       | **Zorunlu**               | `re_…`                                    | `re_` ile başlamalı. Yalnız "Sending access", tek alan adına kısıtlı anahtar                                                                                            |
| `EMAIL_FROM`           | **Zorunlu**               | `Kiralığım <bildirim@kiraligim.com>`      | `Ad <adres@alan.com>` veya `adres@alan.com`. Alan adı Resend'de doğrulanmış olmalı (kod bunu **denetleyemez**)                                                          |
| `EMAIL_REPLY_TO`       | Opsiyonel                 | `destek@kiraligim.com`                    | Boş bırakılabilir; **doluysa geçerli bir e-posta adresi olmalı**, aksi halde kimlik sistemi tamamen kapanır                                                             |
| `AUTH_SIGNUP_ENABLED`  | Opsiyonel (vars. `false`) | `false`                                   | Yalnız küçük harfle `true` / `false`. `True`, `TRUE`, `1`, `yes` **geçersizdir** ve kimliği kapatır. KVKK metinleri hazır olana kadar `false`                           |
| `AUTH_IP_HEADER`       | **Pratikte zorunlu**      | `cf-connecting-ip` veya `x-forwarded-for` | Yalnız küçük harf, rakam, tire (`^[a-z0-9-]+$`). `CF-Connecting-IP` gibi büyük harfli yazım **geçersizdir** ve kimliği kapatır. Seçim: "Deneme sınırı ve istemci IP'si" |
| `AUTH_TRUSTED_PROXIES` | Senaryoya bağlı           | boş veya `CIDR,CIDR`                      | Virgülle ayrılmış geçerli IP/CIDR; tek bir geçersiz giriş kimliği kapatır                                                                                               |

Kimlik sistemi ayrıca şu temel değişkenlere dayanır: `APP_ENV=production` (Resend zorunluluğu ve `Secure`
çerezler bununla devreye girer) ve `APP_URL=https://app.kiraligim.com` (Better Auth adresi, güvenilen köken,
`/api/auth`'un kabul ettiği host ve e-postalardaki bağlantılar; yanlışsa `/api/auth` 404, tarayıcı istekleri 403).

### Yapılandırma hataları ve izleme

**Eksik veya hatalı kimlik değişkeni → kimlik tamamen kapanır (fail-closed):**

- `/giris`, `/kayit`, `/sifremi-unuttum`, `/sifre-sifirla`, `/eposta-dogrulama` "Giriş geçici olarak
  kullanılamıyor" gösterir; formlar açılmaz. `/api/auth/*` **503** (`AUTH_UNAVAILABLE`) döner; korumalı
  sayfalar `/giris`'e yönlenir.
- Log'a süreç başına **bir kez** `auth_unavailable` yazılır; içinde yalnız değişken adı ve kural vardır
  (değer yazılmaz), ör. `BETTER_AUTH_SECRET: … en az 32 karakter olmalı`.
- **`/api/health` bu durumu yakalamaz ve 200 döner.** Sağlık kontrolü yalnız uygulama ve veritabanını
  denetler; Coolify deploy'u başarılı sayar. Bu yüzden her deploy'dan sonra:
  1. `https://app.kiraligim.com/giris` açılır; giriş formu görünmeli ("geçici olarak kullanılamıyor" değil).
  2. Coolify → uygulama → Logs'ta `auth_unavailable` aranır; **hiç** olmamalı.
- Düzeltme: değişken Coolify'da düzeltilir ve yeniden deploy edilir (süreç yeniden başlamadan etkinleşmez).

**Resend anahtarı geçersiz veya gönderen alan adı doğrulanmamış → sessiz gönderim hatası:**

Kod açılışta yalnız biçimi denetler (`re_…`, adres biçimi); Resend'in anahtarı veya alan adını kabul edip
etmediğini **sınamaz**. Bu durumda sayfalar normal açılır ve kayıt / şifre sıfırlama kullanıcıya başarılı
görünür (e-posta arka planda gönderilir, hata isteği bozmaz ve hesap varlığını sızdırmaz), ancak **e-posta
gitmez**: yeni kullanıcı e-postasını doğrulayamaz, şifre sıfırlama çalışmaz.

İzleme:

- Coolify Logs'ta `email_send_failed` aranır. Kayıtta `category` (`auth.verify-email` /
  `auth.reset-password`), maskelenmiş alıcı (`a***@alan.com`) ve `status` (Resend HTTP kodu) veya
  `reason` (zaman aşımı/ağ hatası) bulunur. API anahtarı ve ileti içeriği asla log'a yazılmaz.
  - `401`/`403`: anahtar geçersiz/iptal edilmiş ya da `EMAIL_FROM` alan adı Resend'de doğrulanmamış veya
    anahtar başka alan adına kısıtlı.
  - `422`: gönderen/alıcı biçimi Resend tarafından reddedildi.
  - `429`: Resend gönderim sınırı.
- Başarılı gönderimde `email_sent` (kategori, maskelenmiş alıcı, Resend `id`) yazılır; Resend panelindeki
  Emails/Logs ekranıyla `id` üzerinden eşleştirilebilir.
- Deploy sonrası duman testi: kendi adresinizle `/sifremi-unuttum` → e-posta gelmeli ve log'da
  `email_sent` görünmeli.

Yapılandırmanın temel kararları:

- Uç nokta yalnız ev sahibi panelinde: `APP_URL/api/auth`. Güvenilen köken yalnız `APP_URL`.
- Çerez `kg.` önekli, `HttpOnly`, `SameSite=Lax`, production'da `Secure`; `Domain` yok (yalnız `app.` host'u).
- E-posta doğrulaması zorunlu; doğrulanmadan giriş yapılamaz. Şifre en az 10 karakter (scrypt özeti).
- Şifre sıfırlama/doğrulama belirteçleri veritabanında özet olarak saklanır; sıfırlamada tüm oturumlar kapanır.
- Kimlikler UUID v7. Better Auth telemetrisi kapalı. Köken (CSRF) denetimi her ortamda açık.
- Super Admin bu kimlik sistemini ve tablolarını **kullanmaz**; ayrı kimlik ve tablolar Super Admin aşamasında eklenecek.

### Kimlik tabloları ve yetkiler (0003, 0004)

| Tablo           | İçerik                                                        | `app_user`                          | RLS |
| --------------- | ------------------------------------------------------------- | ----------------------------------- | --- |
| `users`         | ad, e-posta (benzersiz, küçük harf zorunlu), doğrulama durumu | SELECT, INSERT, UPDATE (DELETE yok) | Yok |
| `sessions`      | oturum belirteci (benzersiz), son kullanma, IP, user agent    | SELECT, INSERT, UPDATE, DELETE      | Yok |
| `accounts`      | sağlayıcı hesabı; `credential` için scrypt şifre özeti        | SELECT, INSERT, UPDATE, DELETE      | Yok |
| `verifications` | doğrulama/sıfırlama belirteçleri (özet olarak)                | SELECT, INSERT, UPDATE, DELETE      | Yok |
| `rate_limits`   | deneme sınırı sayaçları                                       | SELECT, INSERT, UPDATE, DELETE      | Yok |

- Kolonlar snake_case (`email_verified`, `user_id`, `last_request` …); Drizzle'da camelCase alanlarla eşlenir.
- `sessions` ve `accounts`, kullanıcı silindiğinde birlikte silinir (`ON DELETE CASCADE`).
- PUBLIC, `app_admin` ve `app_worker`'ın bu tablolarda **hiçbir** yetkisi yoktur.
- **RLS bilinçli olarak uygulanmaz:** Better Auth bu tabloları tenant bağlamı olmadan sorgular; RLS açık
  olsaydı tüm sorgular boş dönerdi. Koruma en dar GRANT ile sağlanır. Super Admin bu tabloları kullanmaz
  (ayrı `admin_*` tabloları, Super Admin aşamasında). Tenant verisi ayrı tablolarda `ENABLE` + `FORCE` RLS altındadır.
- Doğrulama: `tests/integration/auth-tables.test.ts` (şema, kısıt, yetki, migration geçmişi),
  `tests/integration/auth-flow.test.ts` (yalnız `app_user` ile kayıt → doğrulama → giriş → sıfırlama → deneme sınırı).

Deploy sonrası salt-okunur kontrol (Coolify Postgres terminali veya `docker exec`):

```sql
select id, hash, created_at from drizzle.__migrations order by created_at;   -- 5 satır (0000–0004)
select c.relname, a.privilege_type,
       case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as rol
  from pg_class c, aclexplode(c.relacl) a
 where c.relname in ('users','sessions','accounts','verifications','rate_limits')
   and a.grantee <> c.relowner
 order by 1, 3, 2;                                                             -- yalnız app_user, PUBLIC yok
select relname, relrowsecurity from pg_class
 where relname in ('users','sessions','accounts','verifications','rate_limits'); -- hepsi f
```

### Deneme sınırı (rate limit) ve istemci IP'si

Better Auth sınırı `rate_limits` tablosunda tutar (`rateLimit.storage: "database"`; kaynak:
`better-auth/dist/api/rate-limiter`): anahtar `<istemci-ip>|<yol>`, giriş/kayıt için 10 sn'de 3,
sıfırlama/doğrulama e-postası için 60 sn'de 3, diğerleri için 60 sn'de 100 istek.

İstemci IP'si `AUTH_IP_HEADER` başlığından okunur (`@better-auth/core/utils/ip`):

- Başlıkta **tek bir geçerli IP** varsa kabul edilir.
- `AUTH_TRUSTED_PROXIES` boşken çok değerli zincir (`a, b`) **reddedilir**; istemcinin eklediği sahte bir
  `x-forwarded-for` değeri tek başına IP taklidine yol açmaz.
- `AUTH_TRUSTED_PROXIES` doluyken zincir sağdan okunur; güvenilen adresler atlanır, ilk güvenilmeyen adres
  istemci IP'sidir (istemcinin sola eklediği değerlere hiç ulaşılmaz).
- IP çözülemezse production'da tüm istekler yol başına **tek ortak kovaya** (`no-trusted-ip`) düşer:
  giriş için tüm sitede 10 sn'de 3 deneme — birkaç hatalı giriş herkesi kilitler.

Kimlik açılmadan önce `app.kiraligim.com` kaydının Cloudflare durumuna göre **bir** senaryo seçilir.
Trafik yolu: istemci → (Cloudflare) → Hetzner :443 → Traefik (Coolify) → uygulama.

**Senaryo 1 — Cloudflare Proxied (turuncu bulut), önerilen:**

```env
AUTH_IP_HEADER=cf-connecting-ip
AUTH_TRUSTED_PROXIES=
```

- Cloudflare `CF-Connecting-IP` başlığını her istekte gerçek bağlantı IP'siyle **kendisi yazar**; istemcinin
  gönderdiği değer geçmez. Tek değerli olduğu için Better Auth doğrudan kabul eder; Traefik bu başlığa dokunmaz.
- **Ön koşul:** sunucu 80/443'e **yalnız Cloudflare IP aralıklarından** erişilebilir olmalı (Hetzner Cloud
  Firewall veya Cloudflare Authenticated Origin Pulls). Aksi halde sunucu IP'sini bilen biri Cloudflare'i
  atlayıp başlığı istediği gibi yazar: deneme sınırını aşabilir veya bir kurbanın IP kovasını doldurabilir.
- Doğrulama (Cloudflare dışından, salt-okunur):
  `curl -sk --max-time 5 --resolve app.kiraligim.com:443:<HETZNER_IP> https://app.kiraligim.com/api/health`
  zaman aşımına uğramalı; `200` dönerse sunucu kilitli değildir.
- Bu senaryoda `x-forwarded-for` kullanılmaz: Traefik varsayılan olarak başlığı Cloudflare edge IP'siyle
  değiştirir (aynı edge'den gelen herkes tek kovayı paylaşır) veya zinciri geçirir (çok değerli → ortak kova).

**Senaryo 2 — DNS only (gri bulut):**

```env
AUTH_IP_HEADER=x-forwarded-for
AUTH_TRUSTED_PROXIES=
```

- `cf-connecting-ip` **kullanılmaz**: Cloudflare araya girmediği için başlığı herkes serbestçe yazabilir.
- İstemci doğrudan Traefik'e bağlanır. Traefik'in varsayılan davranışında (`forwardedHeaders.insecure`
  kapalı, `trustedIPs` tanımsız) istemciden gelen `X-Forwarded-For` silinir ve yerine bağlantı IP'si yazılır;
  uygulamaya tek değerli, taklit edilemeyen bir başlık ulaşır.
- **Ön koşul:** Coolify'ın Traefik yapılandırmasında `entryPoints.<ad>.forwardedHeaders.insecure=true` veya
  geniş bir `trustedIPs` **olmamalı**. Varsa istemci zinciri geçer; Better Auth çok değerli zinciri reddeder
  ve istekler ortak kovaya düşer.

**Senaryo 3 — `x-forwarded-for` + güvenilen vekiller (yalnız özel gereksinimde):**

```env
AUTH_IP_HEADER=x-forwarded-for
AUTH_TRUSTED_PROXIES=<Cloudflare IPv4/IPv6 aralıkları>,<Traefik/Docker ağı CIDR>
```

- Zincirin uygulamaya ulaşması için Traefik'in de aynı vekillere güvenmesi **zorunludur**: Coolify proxy
  yapılandırmasında ilgili entrypoint için `forwardedHeaders.trustedIPs=<Cloudflare aralıkları>` tanımlanmalı.
  Bu yapılmazsa Traefik zinciri siler ve uygulama yalnız Cloudflare edge IP'sini görür.
- Cloudflare aralıkları değiştikçe hem `AUTH_TRUSTED_PROXIES` hem Traefik `trustedIPs` güncellenmelidir
  (https://www.cloudflare.com/ips/). Daha çok parça ve hata riski olduğu için Senaryo 1 tercih edilir.

**Her senaryoda deploy sonrası kontrol** (salt-okunur; birkaç giriş denemesinden sonra):

```sql
select key from rate_limits order by last_request desc limit 5;
```

Anahtarlar `<gerçek-istemci-ip>|/yol` biçiminde olmalı; Cloudflare IP'si veya `no-trusted-ip` görünüyorsa
ayar yanlıştır. Log'da Better Auth'un "could not determine a client IP" uyarısı da aynı sorunu gösterir.

Not: IPv6 istemciler tek adres (/128) üzerinden sayılır (`ipv6Subnet` ayarlı değil); bir /64 bloğu olan
saldırgan adres değiştirerek sınırı aşabilir. Düşük risk; ileride `ipv6Subnet: 64` değerlendirilecek.

### Kimlik arayüzü ve uç nokta (Aşama 2.3)

- Uç nokta `APP_URL/api/auth/*` (`src/app/api/auth/[...all]/route.ts`). `proxy.ts` `/api/*` isteklerini
  yeniden yazmadığı için route **host'u kendisi denetler**: yalnız `APP_URL` host'u kabul edilir, admin ve
  public alan adlarında 404. Kimlik ortam değişkenleri eksik/hatalıysa 503 döner ve sayfalar
  "Giriş geçici olarak kullanılamıyor" gösterir (log: `auth_unavailable`, yalnız değişken adlarıyla).
- Sayfalar (app.<alan-adı>): `/giris`, `/kayit` (`AUTH_SIGNUP_ENABLED=false` iken "Kayıtlar kapalı"),
  `/eposta-dogrulama`, `/sifremi-unuttum`, `/sifre-sifirla`; oturum gerektirenler: `/` (yönlendirici),
  `/isletme-olustur` (yalnız hiç üyeliği olmayan kullanıcı), `/isletmeler` (seçim / askı bilgisi), `/panel`.
- Formlar tarayıcıdan doğrudan Better Auth'a gider; deneme sınırı ve köken denetimi her istekte uygulanır.
  Şifreler uygulama kodunda saklanmaz. Formlar `method="post"` ve JS yüklenene kadar gönderilemez
  (şifre hiçbir durumda adres çubuğuna düşmez).
- Seçili işletme `kg.isletme` (production'da `__Host-kg.isletme`) çerezinde yalnız **tercih** olarak durur;
  yetki her istekte `withTenant` ile doğrulanır.

**Production'da kimliği açmadan önce (Coolify, yalnız çalışma zamanı değişkeni):**

| Değişken                                  | Değer                                                                                                                              |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`                      | `openssl rand -base64 32` (production'a özel)                                                                                      |
| `EMAIL_TRANSPORT`                         | `resend` (production'da başka değer kabul edilmez)                                                                                 |
| `RESEND_API_KEY`, `EMAIL_FROM`            | Resend'de doğrulanmış alan adından (aşağıdaki bölüm); sonra e-posta duman testi                                                    |
| `AUTH_IP_HEADER` / `AUTH_TRUSTED_PROXIES` | "Deneme sınırı ve istemci IP'si" — Cloudflare durumuna göre **bir senaryo** seçilir; yanlışsa tüm kullanıcılar tek kovayı paylaşır |
| `AUTH_SIGNUP_ENABLED`                     | `false` kalır; KVKK aydınlatma/onay metinleri hazır olunca `true`                                                                  |

### Resend kurulumu (gerçek gönderimden önce)

1. Resend → Domains → `kiraligim.com` (veya `mail.kiraligim.com`) ekleyin.
2. Verilen SPF, DKIM (ve önerilen DMARC) kayıtlarını Cloudflare DNS'e **DNS only** (gri bulut) olarak ekleyin; Resend'de "Verified" olana kadar bekleyin.
3. Resend → API Keys → "Sending access", yalnız bu alan adı. Anahtarı Coolify'a `RESEND_API_KEY` olarak (Build Variable değil) girin.
4. `EMAIL_FROM` alan adı doğrulanan alan adıyla aynı olmalı.

## İşletme (tenant) yapısı ve denetim kaydı (0005, 0006)

### Tablolar

| Tablo               | İçerik                                                          | `app_user` yetkisi                                                      |
| ------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `workspaces`        | işletme: ad, adres (slug, benzersiz), durum, oluşturan          | SELECT; INSERT (id, name, slug, created_by); UPDATE (name, slug)        |
| `workspace_members` | kullanıcı ↔ işletme, rol (`owner`, `manager`, `staff`)          | SELECT, DELETE; INSERT (id, workspace_id, user_id, role); UPDATE (role) |
| `audit_log`         | yalnız eklenebilir denetim kaydı (işlem, hedef, küçük metadata) | SELECT; INSERT (`occurred_at` hariç)                                    |

- Üç tabloda da `ENABLE` + `FORCE ROW LEVEL SECURITY` vardır; tablo sahibi `app_migrator` da politikalara tabidir.
- `status` kolonu uygulama tarafından değiştirilemez (askıya alma Super Admin işi; Super Admin aşamasında eklenecek).
- Kullanıcı silinince üyelikleri silinir; denetim kaydı kalır, `actor_user_id` NULL olur (KVKK takma adlandırma).
  İşletme silme bu aşamada yoktur (`ON DELETE RESTRICT`).

### Güven modeli ve bağlam

- `app.user_id` yalnız doğrulanmış oturumdan, `app.workspace_id` ise `withTenant()` üyelik ve
  `status = 'active'` doğrulamasından sonra ayarlanır (transaction'a özel, parametre bağlı `set_config`).
- Üye olunmayan, var olmayan ve askıdaki işletmeler aynı `NOT_FOUND` yanıtını verir (varlık sızdırılmaz).
- RLS sorgu hatalarına karşı ikinci savunma hattıdır; ele geçirilmiş uygulama koduna karşı koruma değildir.
- Rol, `app_current_member_role()` ile **veritabanından** okunur; istemciden gelen rol bilgisine güvenilmez.
  Bu fonksiyon yalnız **aktif** işletmede rol döndürür: askıdaki işletmede bağlam elle kurulsa bile
  okuma ve yazma kapalıdır (yalnız bağlamsız "işletmelerim" listesinde askıdaki üyelikler görünür).
- İlk owner istisnası yalnız **hiç üyesi olmayan** işletmede ve yalnız onu oluşturan kullanıcı için
  geçerlidir; işletmeden çıkarılan kurucu kendini yeniden ekleyemez.

### Rol matrisi

| İşlem                                | owner | manager             | staff |
| ------------------------------------ | ----- | ------------------- | ----- |
| İşletme bilgisini güncelleme         | ✓     | –                   | –     |
| Üye ekleme                           | ✓     | yalnız `staff` rolü | –     |
| Rol değiştirme / üye çıkarma         | ✓     | –                   | –     |
| Üye listesi (ad, rol, üyelik tarihi) | ✓     | ✓                   | ✓     |
| Denetim kaydını okuma                | ✓     | ✓                   | –     |

- Üye listesinde e-posta ve diğer kişisel bilgiler döndürülmez.
- **Son owner koruması:** işletmenin son sahibi silinemez veya rolü düşürülemez (`workspace_last_owner`);
  eşzamanlı işlemler işletme başına advisory lock ile sıralanır. Kural tetikleyicidedir, `app_migrator` için de geçerlidir.
  Owner'ı etkileyen değişiklik yalnız READ COMMITTED (varsayılan) veya SERIALIZABLE transaction'da yapılabilir;
  REPEATABLE READ'de `workspace_owner_change_isolation` hatasıyla reddedilir (eski snapshot sıfır owner bırakabilir).
- Rol değişikliğinde satır `FOR UPDATE` ile kilitlenir; UPDATE tam 1 satırı değiştirmezse denetim kaydı yazılmaz.
- İşletme oluşturma, ilk owner üyeliği ve `workspace.created` kaydı **tek transaction** içindedir; biri başarısız
  olursa hiçbiri yazılmaz.

### Denetim kaydı değiştirilemez

- `UPDATE`, `DELETE` ve `TRUNCATE` tetikleyiciyle engellenir (tablo sahibi ve süper kullanıcı dahil).
  Tek istisna: kullanıcı silinirken FK zincirinin (`ON DELETE SET NULL`) yaptığı `actor_user_id` → NULL.
  Bu yalnız tetikleyici içinden (`pg_trigger_depth() > 1`), yalnız o kolon değişirken ve kullanıcı artık
  yoksa kabul edilir; doğrudan bir UPDATE ile actor bilgisi silinemez.
- Kayıt yalnız kendi adına (`actor_user_id = app.user_id`) ve geçerli işletmeye yazılır; zaman damgası sunucu verir.
- Metadata yalnız işleme özgü sabit şemayı kabul eder; e-posta, telefon, ad, IP, user agent, belirteç, kimlik/kart/IBAN
  gibi alanlar uygulamada reddedilir; boyut veritabanında 4 KB ile sınırlıdır.

### `app_migrator` istisnası ve SECURITY DEFINER fonksiyonlar

- `SECURITY DEFINER` fonksiyonlar: `app_current_membership_role()` (durumdan bağımsız üyelik rolü),
  `app_current_workspace_unclaimed()` (bağlamdaki işletmenin hiç üyesi yok mu) ve son-owner tetikleyicisi.
  Hepsinin sahibi `app_migrator`, `search_path = pg_catalog, pg_temp`, PUBLIC'ten EXECUTE geri alınmış;
  bağlam fonksiyonları parametre almaz (yalnız o anki kullanıcı/işletme). `app_current_member_role()` ise
  SECURITY INVOKER'dır ve durumu `app_user` olarak okur. FORCE RLS altında definer fonksiyonların
  `workspace_members` tablosunu okuyabilmesi için tek dar politika vardır: `members_migrator_lookup`
  (`FOR SELECT TO app_migrator`). `app_migrator` `workspaces` ve `audit_log` satırlarını göremez.
- Beş bağlam fonksiyonu (`app_current_user_id`, `app_current_workspace_id`, `app_current_membership_role`,
  `app_current_workspace_unclaimed`, `app_current_member_role`) yalnız `app_user`'a açıktır;
  tetikleyici fonksiyonlarının kimseye EXECUTE yetkisi yoktur.
- Doğrulama: `tests/integration/tenancy.test.ts` (yalıtım, roller, atomiklik, son owner, denetim kaydı),
  `tests/integration/tenancy-security.test.ts` (fonksiyon sahipliği, search_path, EXECUTE, politika ve yetki listesi).

Deploy sonrası salt-okunur kontrol:

```sql
select count(*) from drizzle.__migrations;                                   -- 7 (0000–0006)
select relname, relrowsecurity, relforcerowsecurity, pg_get_userbyid(relowner)
  from pg_class where relname in ('workspaces','workspace_members','audit_log'); -- t, t, app_migrator
select tablename, policyname, roles, cmd from pg_policies
 where tablename in ('workspaces','workspace_members','audit_log') order by 1, 2; -- 10 politika
select p.proname, p.prosecdef, pg_get_userbyid(p.proowner), p.proconfig, p.proacl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname like 'app\_%' order by 1;           -- sahip app_migrator, PUBLIC yok
```

## Paketler ve abonelikler (0007, 0008)

| Tablo                     | İçerik                                                                     | `app_user` | RLS                                  |
| ------------------------- | -------------------------------------------------------------------------- | ---------- | ------------------------------------ |
| `plans`                   | paket kataloğu: kod, ad, `max_properties`, `trial_days`, aktif, varsayılan | SELECT     | Yok (tenant verisi değil; dar GRANT) |
| `workspace_subscriptions` | işletme başına **tek** abonelik: paket, durum, deneme bitişi, dönem bitişi | SELECT     | `ENABLE` + `FORCE`                   |

- Başlangıç paketi migration ile tanımlıdır: **Başlangıç** (`baslangic`), 1 mülk, 14 gün deneme, varsayılan.
  Paketler şimdilik yalnız migration ile değişir; yönetim arayüzü Super Admin aşamasında gelecek.
- **Otomatik deneme:** `workspaces` üzerindeki `workspaces_start_trial` tetikleyicisi (AFTER INSERT,
  SECURITY DEFINER) her yeni işletmeye varsayılan paketle `trialing` abonelik açar. İşletme, owner üyeliği,
  denetim kaydı ve abonelik **tek transaction**'dadır; varsayılan paket yoksa (`default_plan_missing`) hiçbiri oluşmaz.
- **Geçerlilik** tek yerde: `app_subscription_is_current(status, trial_ends_at, current_period_end)`.
  `trialing` satırı deneme bitince güncellenmez; süresi dolmuş sayılır (zamanlanmış iş gerekmez). Deneme
  bitince mevcut mülkler görüntülenir/düzenlenir, yeni mülk eklenemez (mülk limiti tetikleyicisi Aşama 2.4b).
- **Yetkiler:** `app_user` paketleri ve kendi işletmesinin aboneliğini yalnız okur (askıdaki işletmede görünmez);
  ekleme, değiştirme, silme yok. `app_migrator` için tek dar istisna: `subscriptions_migrator_trial_insert`
  (yalnız INSERT, yalnız `status = 'trialing'`; okuma/güncelleme yok) — tetikleyici ve backfill içindir.
- **Backfill (0008):** mevcut her işletmeye (askıdakiler dahil) tek deneme aboneliği açılır; deneme migration
  anından başlar. `workspaces` için `FORCE` yalnız migration transaction'ı içinde kaldırılıp geri konur.
- Doğrulama: `tests/integration/billing.test.ts` (katalog, atomik oluşturma, izolasyon, yetkiler, geçerlilik,
  0006 → 0008 backfill).

Deploy sonrası salt-okunur kontrol:

```sql
select count(*) from drizzle.__migrations;                                    -- 9 (0000–0008)
select code, name, max_properties, trial_days, is_default from plans;         -- baslangic | Başlangıç | 1 | 14 | t
select count(*) filter (where s.id is null) as aboneliksiz
  from workspaces w left join workspace_subscriptions s on s.workspace_id = w.id; -- 0
select relname, relrowsecurity, relforcerowsecurity from pg_class
 where relname in ('workspaces','workspace_subscriptions');                   -- t, t
```

## Mülkler (0009, 0010)

`properties`: işletme başına mülkler (villa, apart, bungalow, ev); kapasite (kişi, yatak odası, banyo,
çift/tek/çekyat yatak), adres (il, ilçe, mahalle, açık adres, posta kodu) ve isteğe bağlı koordinat
(`numeric(9,6)`, enlem ve boylam birlikte). Arayüz: app.<alan-adı>/villalar (menü adı "Mülkler").

- **RLS:** `ENABLE` + `FORCE`. Okuma: bağlamdaki aktif işletmenin tüm üyeleri (staff dahil). Ekleme ve
  düzenleme: yalnız owner/manager; ekleme yalnız kendi adına (`created_by = app.user_id`). **DELETE yok**
  (ne yetki ne politika); yalnız pasife alma. Askıdaki işletmede okuma/yazma kapalı.
- **Kolon yetkileri:** `id`, `workspace_id`, `created_by`, `created_at`, `updated_at` güncellenemez.
- **Paket limiti:** `properties_enforce_limit` (BEFORE INSERT, **SECURITY INVOKER**). Aktif + pasif tüm
  mülkler sayılır; abonelik geçerli değilse (`app_subscription_is_current`) yeni mülk eklenemez, mevcutlar
  düzenlenir. İşletme başına advisory lock; REPEATABLE READ'de `property_limit_isolation` ile reddedilir.
  Hata kodları: `property_limit_reached`, `property_subscription_inactive`, `property_subscription_missing`
  (uygulamada `LIMIT_REACHED`). Tetikleyici ekleyen kullanıcının yetkisiyle çalıştığı için `app_migrator`
  için yeni RLS istisnası **yoktur**.
- **Denetim:** `property.created` (tür), `property.updated` (yalnız değişen alan **adları**),
  `property.status_changed` (önceki/sonraki durum). Adres ve koordinat değerleri yazılmaz.
- Konum için gömülü harita yok; "Haritada aç" OpenStreetMap'i yeni sekmede açar (CSP değişmedi).
- Doğrulama: `tests/integration/properties.test.ts`, `tests/unit/properties.test.ts`.

Deploy sonrası salt-okunur kontrol:

```sql
select count(*) from drizzle.__migrations;                                     -- 11 (0000–0010)
select relrowsecurity, relforcerowsecurity from pg_class where relname = 'properties'; -- t, t
select policyname, cmd from pg_policies where tablename = 'properties' order by 1;     -- insert, select, update
select prosecdef from pg_proc where proname = 'app_properties_enforce_limit';           -- f
```

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
