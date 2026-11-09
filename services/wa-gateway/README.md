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
Tek tepki: başarılı grup bağlamada bağlama kodu mesajına ✅.

1. Ana uygulamada migration'lar (0030, 0031) **geliştirme** veritabanına uygulanmış olmalı
   (Coolify → `lp-dev-web` redeploy; açılışta `node dist/migrate.js`). Production'a dokunmayın.
2. Geliştirme veritabanına Mac'ten erişim (ör. SSH tüneli ile yerel bir porta). `.env` içinde:
   `WA_ALLOWED_NUMBER=<test numarası>`, `WA_DATABASE_URL=postgres://app_user:…@127.0.0.1:<port>/<dev-db>`.
   Veritabanı adı `_dev` ile bitmeli ve `prod` içermemeli; bu, bağlantı kurulmadan önce denetlenir.
   Ardından bağlantı denenir (adres/parola yazılmaz).
3. `npm start` → arayüzde "Biçim: A1". Bağlanınca katıldığı tüm gruplar veritabanına "bağlı değil"
   olarak kaydedilir; hiçbir işletmeye görünmez, mesajları saklanmaz.
4. Panelde **WhatsApp Asistanı → Grup bağla**: owner (veya owner'ın yetkilendirdiği manager) kendi
   WhatsApp numarasını girer, 10 dakikalık tek kullanımlık kod alır.
5. Aynı numaradan gruba yalnız `kiraligim XXXX-XXXX` yazılır. Kod geçerli, numara aynı ve kişi hâlâ
   yetkiliyse grup işletmeye bağlanır ve mesaja ✅ bırakılır; aksi hâlde sessizce reddedilir (grup
   başına saatte en fazla 5 hatalı deneme).
6. Sonraki mesajlar panelde "Son mesajlar"da görünür (owner ve manager). Askıya alınan veya bağlantısı
   kesilen grubun mesajı saklanmaz; bağlantı kesilince eski mesajlar silinir.

Ağ geçidi tablolara doğrudan yazamaz; yalnız `app_wa_*` veritabanı fonksiyonlarını çağırır.
Mesaj metni, numara ve kod günlüğe yazılmaz. Saatte bir 90 günden eski mesajlar silinir.

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

## Yeniden bağlanma

| Kapanma nedeni                              | Davranış                                         |
| ------------------------------------------- | ------------------------------------------------ |
| Yeniden başlatma isteği (QR sonrası normal) | Hemen bağlanır                                   |
| Ağ kopması, zaman aşımı, sunucu hatası      | 1, 2, 4 … en fazla 60 sn bekleyerek tekrar dener |
| Telefondan çıkış yapıldı / oturum kapatıldı | Durur, yerel anahtarları siler; yeni QR gerekir  |
| Aynı oturum başka yerde açıldı              | Durur (iki kopya oturumu bozar)                  |
| Erişim reddedildi, bozuk oturum             | Durur; arayüzden "Oturumu sıfırla"               |

## Komutlar

- `npm run check` — tip denetimi + testler (ağ gerektirmez).
- `npm start` — servisi başlatır (WhatsApp'a bağlanır).
