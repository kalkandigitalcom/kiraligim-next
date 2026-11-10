# Kiraligim WhatsApp ağ geçidi — Faz 1 test bağlantısı ve A1 grup kaydı

Ana Next.js uygulamasından bağımsız, ayrı bir Node servisi. İki biçimi vardır:

- **A1** (`WA_DATABASE_URL` tanımlı): grupları geliştirme veritabanına kaydeder, bağlama kodunu tanır,
  yalnız bağlı gruplardaki mesajları saklar (90 gün). Bkz. [A1 biçimi](#a1-biçimi-grup-kaydı-ve-mesaj-kuyruğu).
- **Faz 1 test biçimi** (`WA_DATABASE_URL` boş): aşağıdaki gibi; veritabanı kullanılmaz.

Faz 1 test biçiminde yalnız:

- test numarasını QR ile bağlı cihaz olarak bağlar ([Baileys](https://github.com/WhiskeySockets/Baileys) 7.0.0-rc14, MIT);
- test grubundaki mesajı okur, grup kimliğini, gönderen numarasını, mesaj kimliğini, içeriği ve zamanı konsola yazar;
- aynı mesaja ✅ tepkisi bırakır.

Metin mesajı gönderen kod yoktur. Takvim, fiyat, Kiraligim veritabanı ve iCal ile bağlantısı yoktur.

> **Risk:** Baileys resmî olmayan bir WhatsApp istemcisidir; WhatsApp Hizmet Şartları otomatik ve izinsiz
> erişimi yasaklar ve numara kapatılabilir. Yalnız bu iş için ayrılmış test numarasıyla kullanın; ana
> Kiraligim numarasını asla bağlamayın.

## Çalıştırma (Mac, Node 20+)

```bash
cd services/wa-gateway
npm install
cp .env.example .env      # WA_ALLOWED_NUMBER'ı test numarasıyla doldurun
npm start                 # http://localhost:4010
```

1. Tarayıcıda `http://localhost:4010` açın. Durum "QR bekleniyor" olunca **test numarasının** telefonunda
   WhatsApp → Ayarlar → Bağlı cihazlar → Cihaz bağla ile QR'ı okutun.
2. Başka bir hesap okutulursa servis oturumu hemen kapatır ve anahtarları siler.
3. Test numarasını test grubuna ekleyin; gruba herhangi bir mesaj yazın. Arayüzdeki "Görülen gruplar"
   tablosundan grup kimliğini (`…@g.us`) kopyalayıp `.env` içinde `WA_TEST_GROUP_JID` yapın, servisi
   yeniden başlatın (Ctrl+C, `npm start`; oturum korunur, QR tekrar istenmez).
4. Test grubuna `Villa Zeytin'in 10-15 Temmuz tarihlerini kapat.` yazın. Konsolda mesaj bilgileri
   görünür; aynı mesaja ✅ tepkisi gelir. Arayüzde "Tepki sunucuya ulaştı" olayı görülür.

## A1 biçimi: grup kaydı ve mesaj kuyruğu

Yalnız okuma. AI analizi, takvim, fiyat, rezervasyon ve iCal işlemi yoktur; metin mesajı gönderilmez.
Gruplara kod yazılmaz. Tek tepki: asistana özel mesajla gelen başarılı numara doğrulamasına ✅.

1. Ana uygulamada migration'lar (0030–0034) **geliştirme** veritabanına uygulanmış olmalı
   (Coolify → `lp-dev-web` redeploy; açılışta `node dist/migrate.js`). Production'a dokunmayın.
2. Geliştirme veritabanına Mac'ten erişim (ör. SSH tüneli ile yerel bir porta). `.env` içinde:
   `WA_ALLOWED_NUMBER=<test numarası>`, `WA_DATABASE_URL=postgres://app_user:…@127.0.0.1:<port>/<dev-db>`.
   Veritabanı adı `_dev` ile bitmeli ve `prod` içermemeli; bu, bağlantı kurulmadan önce denetlenir.
   Ardından bağlantı denenir (adres/parola yazılmaz).
3. `npm start` → arayüzde "Biçim: A1". Bağlanınca katıldığı tüm gruplar veritabanına "bağlı değil"
   olarak kaydedilir; hiçbir işletmeye görünmez, mesajları saklanmaz.
4. Panelde **WhatsApp Asistanı → Numaramı doğrula** (bir kez): owner veya yetkili manager
   "WhatsApp'ta aç" ile asistana `kiraligim doğrula XXXX-XXXX` özel mesajını gönderir. Ağ geçidi
   gönderen numarasını doğrular ve mesaja ✅ bırakır. Başka özel mesajlar okunmaz/saklanmaz.
5. Villa sahibi asistan numarasını **doğrulanmış numarasından** gruba ekler. Ağ geçidi katılımı algılar,
   ekleyen kişinin ve kurucunun numara özetiyle grubu "bağlı değil" kaydeder.
6. Panelde **Bekleyen gruplar** → Eşleştir → villa seç → Kaydet. Grup aktif olur; sonraki mesajlar
   "Son mesajlar"da görünür (owner ve manager). Askıya alınan veya bağlantısı kesilen grubun mesajı
   saklanmaz; bağlantı kesilince eski mesajlar silinir.

Ağ geçidi tablolara doğrudan yazamaz; yalnız `app_wa_*` veritabanı fonksiyonlarını çağırır.
Mesaj metni, numara ve kod günlüğe yazılmaz. Saatte bir 90 günden eski mesajlar silinir.

## Sunucuda çalıştırma (Coolify, konteyner)

İmaj: `services/wa-gateway/Dockerfile` (Coolify'da **Base Directory** `/services/wa-gateway`). İmaj
oturum anahtarı, `.env` veya kilit içermez (`.dockerignore`). Varsayılanlar: `WA_HTTP_HOST=0.0.0.0`,
`WA_HTTP_PORT=4010`, `WA_REQUIRE_DATABASE=true`; süreç doğrudan `node` ile çalışır (SIGTERM'de düzgün
kapanır), kullanıcı `app` (uid 1001).

- **Veritabanı rolü:** production'da ağ geçidi `app_user`'ı KULLANMAZ. Yönetici kullanıcıyla bir kez
  `scripts/wa-gateway-role.sql` çalıştırılır → `app_wa_gateway`: yalnız beş `app_wa_*` fonksiyonunu
  çalıştırabilir, hiçbir tabloyu okuyamaz. Ön koşul: 0030–0032 migration'ları uygulanmış olmalı.
- **Ortam değişkenleri:** `WA_ENV=production`, `WA_ALLOWED_NUMBER=<test numarası>`,
  `WA_DATABASE_URL=postgres://app_wa_gateway:<parola>@<postgres-iç-host>:5432/kiraligim_prod`,
  `WA_CONNECTION_LABEL=prod`. Servis başlarken ad (`_prod`) ve rol (`app_wa_gateway`, süper kullanıcı
  değil) denetlenir; uymazsa başlamaz.
- **Kalıcı oturum:** Persistent Storage → Volume Mount → Destination Path `/app/.wa-auth`. Volume
  korundukça yeniden başlatmada QR gerekmez. Kilit (`/app/.wa-auth.lock`) volume dışındadır; konteyner
  yeniden başlarken kendi PID'ini taşıyan eski kilit devralınır.
- **Arayüz:** alan adı YOK. Port eşlemesi yalnız `127.0.0.1:4010:4010`; erişim Mac'ten
  `ssh -L 4010:127.0.0.1:4010 <kullanıcı>@<sunucu>` → `http://localhost:4010`.
- **Sağlık kontrolü:** `GET /healthz` (yalnız durum; numara, grup, QR yok). Oturum durdurulmuşsa 503.
- **Tek kopya:** aynı oturumla iki konteyner çalışmamalı. Deploy sırasında `docker ps` ile tek ağ
  geçidi konteyneri görüldüğünü doğrulayın; Mac'teki servis kapalı olsun.

## Güvenlik

- Oturum anahtarları `.wa-auth/` klasöründe (izin 0700), `.gitignore` ile Git dışında. `WA_AUTH_DIR`
  yalnız servis klasöründeki `.wa-auth` / `.wa-auth-<etiket>` olabilir; sembolik bağlantı reddedilir
  (bu klasör oturum sıfırlanınca tümüyle silindiği için). QR ve anahtarlar
  günlüğe yazılmaz; QR yalnız bellekte tutulur ve yerel arayüzde önbelleksiz gösterilir.
- Arayüz yalnız `127.0.0.1`'e bağlanır, başka `Host` başlıklarını reddeder (DNS rebinding), CSP ile
  kilitlidir. "Oturumu sıfırla" süreç başına üretilen token ve aynı köken ister.
- Test grubu dışındaki grupların mesaj içeriği yazılmaz, onlara tepki bırakılmaz.
- Dakikada en fazla 10 tepki; aynı mesaj ikinci kez işlenmez.
- Tek kopya: `.wa-auth.lock` ikinci sürecin aynı oturumu açmasını engeller.

## Yeniden bağlanma ve kendini kurtarma (Aşama 1)

Kurtarılabilir her kapanma, "full jitter" üstel beklemeyle (2 sn tabandan başlayıp en fazla 120 sn)
sınırsız yeniden denenir. Yalnız insan müdahalesi gerektiren durumlarda gateway durur. **Hiçbir kapanma
kodu oturum dosyalarını silmez.** Oturum yalnız arayüzdeki "Oturumu sıfırla" düğmesiyle silinir; ayrıca
izin verilmeyen bir hesap bağlanırsa o hesaba ait yeni oturum silinir.

| Kapanma nedeni                                               | Davranış                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| 515 yeniden başlatma isteği (QR sonrası normal)              | Hemen bağlanır                                                                  |
| 408 / 428 ağ kopması, zaman aşımı, kodsuz                    | Jitter'lı bekleme (2–120 sn)                                                    |
| 503 WhatsApp hizmet dışı                                     | En az 30 sn bekleyip tekrar dener                                               |
| 500 bozuk oturum / kodsuz akış hatası ("stream errored out") | Durmaz, yeniden dener; art arda 5 kez olursa `degraded` uyarısı                 |
| 440 aynı oturum başka yerde açıldı                           | 2–5 dk bekleyip tekrar dener; 30 dk içinde 3. kez olursa durur (`replaced`)     |
| 401 telefondan çıkış, 411 çoklu cihaz uyumsuzluğu            | Durur (`needs_qr`), **oturum silinmez**; yeni QR için arayüzden elle sıfırlayın |
| 403 erişim reddedildi                                        | Durur (`blocked`)                                                               |

- **Tek uçuş:** Aynı anda en fazla bir bağlantı kurulumu ve bir canlı soket olur. Eski soketin
  dinleyicileri kaldırılır ve olayları yok sayılır. Kurulumun her adımı zaman aşımlıdır; hata her zaman
  yeni bir deneme planlar, yani gateway sessizce takılı kalmaz.
- **Watchdog:** Bağlantı kurtarılabilir bir durumda 10 dk boyunca kurulamazsa süreç kontrollü olarak
  kapanır ve **3** koduyla çıkar; Docker restart politikası temiz bir süreç başlatır.
  - Restart döngüsüne karşı pencere üstel büyür: son 6 saatteki watchdog çıkışlarına göre 10, 20, 40,
    en fazla 60 dk.
  - Çıkış geçmişi `<oturum klasörü>.watchdog.json` dosyasında tutulur (konteynerde
    `/app/.wa-auth.watchdog.json`, volume dışında). Bağlantı pencere boyunca açık kalırsa geçmiş
    temizlenir.
  - QR bekleme, `needs_qr`, `blocked`, `replaced` ve kilit beklemesinde watchdog çalışmaz; restart
    bunları çözmez.
  - Oturum dosyalarına dokunulmaz.
- **Tek kopya (iki katman):**
  - Yerel kilit dosyası (`.wa-auth.lock`) aynı makinede ikinci süreci engeller.
  - Veritabanı biçiminde ayrıca bir **PostgreSQL advisory lock** alınır (etiket başına, ayrı ve kalıcı
    bir bağlantıda). Kilidi alamayan kopya WhatsApp'a **bağlanmaz** (`lease_wait`).
  - Kilit bağlantısı koparsa (örneğin veritabanı yeniden başladı) WhatsApp soketi hemen kapatılır ve
    kilit yeniden alınmadan bağlanılmaz. WhatsApp bu sürede gelen mesajları bağlı cihaz için bekletir.
  - Tablo veya migration gerekmez; `app_wa_gateway` rolü için ek yetki gerekmez
    (`pg_try_advisory_lock` herkese açık).
- **Sağlık kontrolü (`/healthz`) gerçek WhatsApp bağlantısını yansıtır.**
  - 200 dönen durumlar: bağlı; ilk eşleştirme QR'ı bekleniyor; 3 dk'dan kısa süredir yeniden
    bağlanıyor.
  - 503 dönen durumlar: daha uzun süredir bağlanamıyor; `needs_qr`, `blocked`, `replaced` veya
    `lease_wait`; durdu.
  - Gövdede yalnız `ok`, `status`, `connected`, `attention`, `notOpenSec` ve `pendingMessages` vardır;
    numara, grup veya QR yoktur.
  - Docker "unhealthy" konteyneri kendiliğinden yeniden başlatmaz; yeniden başlatmayı watchdog yapar.
- **Heartbeat:** `wa_connections` satırı her durumda 60 sn'de bir güncellenir. `last_error_code`
  alanına son kapanma kodu (`close_428`), `needs_qr_401`, `replaced_440`, `lease_wait`,
  `watchdog_exit` veya `ingest_backlog` gibi kısa bir kod yazılır.
- **Mesajlar sessizce kaybolmaz:**
  - Veritabanına yazılamayan mesaj 3 kez (0,5 / 2 / 5 sn) yeniden denenir.
  - Yine olmazsa bellekteki kuyrukta bekler; 30 sn'de bir, bağlantı açılınca ve kapanışta (en fazla
    10 sn) yeniden gönderilir.
  - Kuyruk sınırı 2.000 mesajdır; aşılırsa en eski mesaj düşürülür ve bu, hata olarak sayılıp günlüğe
    yazılır.
  - Veritabanı mesajı tekil tuttuğu için yeniden gönderim çift kayıt üretmez.
  - **Sınır:** süreç çökerse bellekteki kuyruk kaybolur. Diskteki kuyruk Aşama 3'te gelecek.
- **Çözülemeyen mesajlar** (`No session found to decrypt message` / CIPHERTEXT) `undecryptable`
  sayacında görünür. Baileys yeniden deneme ister; başarılı olursa mesaj aynı kimlikle tekrar gelir.

## Mesaj alımı teşhisi (Aşama 1.1)

Yalnız gözlemdir; bağlantı davranışını değiştirmez, yeniden başlatma yapmaz. Bir mesajın nerede
kaybolduğu dört katmanda ayrı sayılır ve `/status.json` → `diagnostics` altında görünür:

| Katman           | Alan                                                                                                                                             | Anlamı                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| 1. Ham paket     | `raw.group`, `raw.direct`, `raw.lastGroupAt`, `raw.lastFrameAt`                                                                                  | WhatsApp WebSocket'inden paket geldi mi (Baileys'ten önce)? `lastFrameAt` bağlantının canlı olduğunu gösterir |
| 2. Baileys olayı | `upsert.notify`, `upsert.append`, `upsert.other`, `upsert.skippedType`, `upsert.stale`                                                           | Baileys paketi `messages.upsert` olayına çevirdi mi?                                                          |
| 3. Filtre        | `filtered.*` (`from_me`, `ciphertext`, `non_text`, `reaction`, `protocol`, `stub`, `no_sender`, `duplicate`…), `nonTextTypes`, `undecryptable.*` | Bizim ayıklama katmanımız neden eledi? Çözülemeyen mesajın türü (`no_session`, `bad_mac`…)                    |
| 4. Kayıt         | `processing.accepted`, `stored`, `duplicate`, `ignored`, `failed`                                                                                | Veritabanı sonucu                                                                                             |

- `groups[]`: grup başına aynı sayaçlar ve son karar (`lastDecision`).
- `stallSuspected`: ham paket geldiği halde 2 dk boyunca hiç upsert oluşmadıysa `true` olur ve bir kez
  uyarı yazılır. Bu, Baileys işleme hattında takılma şüphesidir; otomatik işlem yapılmaz.

**Okuma kılavuzu:**

- Test mesajından sonra `raw.group` artmıyorsa: paket WebSocket'e hiç gelmedi (WhatsApp bu cihaza
  teslim etmiyor).
- `raw` artıyor, `upsert` artmıyorsa: Baileys içinde kalıyor (çözülemedi ya da takıldı; Baileys hata
  günlüğüne de bakın).
- `upsert` artıyor ama kayıt yoksa: `filtered` alanı nedeni gösterir.

**`WA_TRACE=1`:** her adım için tek satırlık `[wa-trace]` günlüğü yazılır (paket, olay, filtre
nedeni, kayıt sonucu). Mesaj metni, numara, gönderen kimliği ve tam grup kimliği yazılmaz; grup son 6
hanesiyle (`grp=…827787`), mesaj kimliğiyle gösterilir. Teşhisten sonra kapatın (varsayılan kapalı).

## Protokol sürümü

WhatsApp Web protokol sürümü **sabittir**: kurulu ve test edilmiş Baileys sürümünün kendi değeri
kullanılır (`/status.json` → `protocolVersion`). Her bağlantıda GitHub'dan sürüm çekilmez.

Güncelleme ayrı ve kontrollü bir işlemdir:

1. `baileys` paketi ayrı bir dalda güncellenir.
2. `npm run check` çalıştırılır.
3. Mac'te test numarasıyla bağlantı denenir.
4. Geliştirme sunucusunda 24 saat izlenir.
5. Ancak sonra production'a deploy edilir.

Acil durumda (örneğin WhatsApp eski sürümü reddediyorsa) `WA_PROTOCOL_VERSION=2.3000.x` ortam değişkeni
geçici geçersiz kılma sağlar; biçim denetlenir ve kalıcı çözüm paket güncellemesidir.

## Coolify ayarları (zorunlu)

- **Restart politikası:** `unless-stopped`. Watchdog'un çıkışı ancak bu politikayla yeniden başlatmaya
  dönüşür; `docker inspect` ile doğrulayın.
- **Tek konteyner:** Ölçeklendirme yapılmaz. Deploy'da önce eski konteyner durmalı; sabit port eşlemesi
  bunu sağlar. PostgreSQL kilidi bunu kodla da garanti eder.
- **Durdurma süresi:** en az 30 sn. Kapanış bekleyen mesajları yazar, soketi kapatır ve kilidi bırakır;
  süreç en fazla 25 sn içinde çıkar.
- **Kalıcı depolama:** `/app/.wa-auth` volume (oturum). Watchdog geçmişi ve yerel kilit volume dışındadır.
- **Volume yedeği:** Deploy'dan önce salt okunur bir yedek alın (oturuma dokunmaz).

## Komutlar

- `npm run check` — tip denetimi + testler (ağ gerektirmez).
- `npm start` — servisi başlatır (WhatsApp'a bağlanır).
