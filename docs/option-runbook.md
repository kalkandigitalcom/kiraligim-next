# Opsiyon otomasyonu — işletim kılavuzu (tek ve ortak sistem, 0074; sabit 24 saat, 0075–0076; uzatma / tarih değişikliği, 0077)

Kiraligim'de tek bir ortak opsiyon sistemi vardır. Bütün işletmeler ve bütün bağlı WhatsApp
grupları aynı kurallarla çalışır; işletme veya grup başına açma yoktur. Davranışın test kanıtı:
`tests/integration/option-shared.test.ts`.

## 1. Temel kurallar

1. **Global anahtar = acil durum kill switch'i.** Normal kullanımda açık kalır. Kapatılınca bir
   sonraki dakikadan itibaren hiçbir grupta opsiyon mesajı okunmaz, onaylanmış işlemler ve
   kesinleştirmeler uygulanmaz (bekler, silinmez). Yeniden açılınca kapalıyken gelen mesajlar
   geriye dönük işlenmez. Kapatma: Super Admin → Opsiyonlar → Otomasyon ayarları →
   **"Kill switch: otomasyonu hemen kapat"** (onay istemez).
2. **Otomasyonun çalıştığı gruplar:** global açıkken, işletmeye bağlı (`linked`), villası atanmış ve
   işletmesi aktif HER WhatsApp grubu. Yeni işletme ve yeni grup için ayrıca bir şey açılmaz; grup
   Super Admin tarafından işletmeye ve villaya bağlandığı andan sonra gelen mesajlar işlenir.
3. **Çalışmadığı durumlar:** grup bağlı değil, askıya alınmış, villası yok ya da işletmesi askıda.
   Engellenen numaraların mesajı hiç alınmaz.
4. **Kim başlatabilir:** yalnız işletmenin doğrulanmış sahip veya yönetici telefonu. Personel ve
   doğrulanmamış katılımcının mesajı opsiyon işlemi üretmez.
5. **İzolasyon:** her grup yalnız kendi işletmesinin, kendi bağlı villasının opsiyonlarını yönetir.
   Mesajda başka bir villanın adı yazılırsa otomatik işlem yapılmaz (açıklama bekler).
6. **Süre (0076): sabit 24 saat.** Ev sahibi yalnız WhatsApp'a yazar ("20-23 Aralık opsiyon");
   süre belirtmesi gerekmez. İşletme veya sistem bazında süre ayarı YOKTUR (işletme panelinde ve
   Super Admin'de süre formu yok). Mesajda açıkça yazılan süre aynen kullanılır.
   - Yazılı süre ASLA kısaltılmaz: girişi aşarsa opsiyon açılmaz, istek "açıklama bekliyor" olur.
   - Sabit 24 saat girişi aşarsa bitiş giriş saatine (İstanbul 00:00) çekilir; girişe 60 dakikadan
     az kalıyorsa istek açıklama bekler.
   - Başlamış / geçmiş girişli istek otomatik işlenmez (açıklama bekler).
   - **Açıklama bekleyenler** (`mode = clarify`): WhatsApp'tan gelip güvenle uygulanamayan
     oluşturmalar. Hiçbir görev uygulamaz, Super Admin onaylamaz; Super Admin → Opsiyonlar →
     "Açıklama bekleyen" sekmesinde teknik takip için salt okunur listelenir. Ev sahibi doğru
     bilgiyle gruba yeni mesaj yazar.
   - İptal ve kesinleştirme belirsizlikleri ile 0075 öncesinden kalan bekleyenler eskisi gibi Super
     Admin onayındadır.
   - Opsiyon yönetimi yalnız WhatsApp'tan yapılır; işletme panelinde opsiyon bölümü yoktur.
     6a. **Uzatma ve tarih değişikliği (0077, Faz B).** Yalnız doğrulanmış sahip / yönetici, yalnız
     WhatsApp'tan; veritabanı göndereni yeniden denetler (engelli değil + doğrulanmış sahip / yönetici).
   - Uzatma: "20-23 Aralık opsiyonunu 2 saat uzatalım", "Ödeme bekliyorum, 2 saat daha
     bekleyelim", "Bu opsiyona 1 gün daha süre verelim". Yeni bitiş = mevcut bitiş + yazılan süre
     (en az 1 saat). Opsiyon sözcüğü ya da ödeme bekleme bağlamı yoksa ("2 saat daha bekleyelim")
     hiçbir şey yapılmaz. Mutlak zaman ("yarın 18:00'e kadar") desteklenmez → açıklama bekler.
   - Uzatma kısaltılmaz: yeni bitiş girişi aşarsa ya da opsiyonun İLK oluşturulmasından itibaren
     14 günü aşarsa (art arda uzatmalar dahil) açıklama bekler.
   - Tarih değişikliği: "20-23 Aralık opsiyonunu 21-24 Aralık yap", "Opsiyon tarihini 20-24 Aralık
     yapalım". Eski opsiyon silinmez: "Tarih değişti" nedeniyle kapanır, yenisi ona bağlı açılır;
     bitiş KORUNUR (yeni 24 saat başlamaz). "X'i Y'ye kaydır / değiştir" biçiminde ayrıştırıcı eski
     aralığı saklamadığı için açıklama bekler; göreli kaydırma ("bir gün ileri alalım") da öyle.
   - Hedef: mesajdaki aralıkla birebir tek açık opsiyon; tarih yoksa grubun TEK açık opsiyonu.
     Birden çok aday, süre dolmuş opsiyon, çakışma ya da belirsizlikte hiçbir şey değişmez.
   - Uygulanan uzatma / tarih değişikliği opsiyonun geçmişinde ve işlem kaydında (önce / sonra)
     görünür.
7. **Opsiyonlar müsaitliği etkilemez.** Panel takvimi, herkese açık villa sayfası, API, iCal ve
   webhook yalnız kesin rezervasyonla değişir.
8. **Kesinleştirme her zaman Super Admin onayıyla.** Onayda misafir adı, yetişkin ve çocuk sayısı
   (yoksa 0) açıkça girilir; rezervasyon işletme sahibi adına, kaynak WhatsApp olarak oluşur.
9. **Mevcut sistem aynen çalışır.** WhatsApp worker, ayrıştırıcı (v8), ağ geçidi, tepki kuyruğu,
   rezervasyon komutları (kapat / aç / tarih değiştir), API, iCal ve webhook değişmez. Opsiyon
   mesajlarına worker'ın ⚠️ tepkisi aynen devam eder; sonuç Super Admin → Opsiyonlar'da görülür.
10. **Villa veya işletme değişikliği:** grubun villası değiştirilirse eski villaya ait onaylı
    işlemler uygulanmaz (`group_changed`); sonraki mesajlar yeni villa için işlenir.
11. **Bildirim yoktur.** "Onay bekleyen" sekmesi düzenli kontrol edilir.

## 2. Önkoşullar (her biri ayrı onayla)

- [ ] Production veritabanı yedeklemesi.
- [ ] Coolify'da `Option Maintenance` görevi (`node dist/option-maintenance.js`, her dakika) etkin.
      Görev yalnız global açıkken mesaj okur ve onaylı işlem uygular; süre dolumu ve çakışma
      uyarısı her durumda çalışır.

## 3. Açılış öncesi salt okunur kontroller

```sh
PGOPTIONS='-c default_transaction_read_only=on' psql -X -At -U "$POSTGRES_USER" -d kiraligim_prod
```

```sql
-- Otomasyonun açılınca çalışacağı gruplar (kişisel veri yok).
select g.status, g.property_id is not null as villa_var, p.status as villa, w.status as isletme,
       (select count(*) from workspace_members m join wa_verified_phones v on v.user_id = m.user_id
         where m.workspace_id = g.workspace_id and m.role in ('owner','manager')) as dogrulanmis
  from wa_groups g
  left join properties p on p.id = g.property_id
  left join workspaces w on w.id = g.workspace_id
 where g.status = 'linked';


-- Global anahtar. (default_duration_* sütunları 0075'ten kalır; 0076'dan beri okunmaz.)
select enabled, updated_at from option_automation_global;
```

## 4. İzleme (salt okunur)

```sql
select status, count(*) from reservation_options group by 1 order by 1;
select kind, mode, status, count(*) from option_operations group by 1,2,3 order by 1,2,3;
-- Süre kaynağı (message / workspace_default / system_default / manual).
select expiry_source, count(*) from reservation_options group by 1 order by 1;
select status, count(*) from option_message_scans group by 1 order by 1;
select count(*) from option_conflict_alerts where acknowledged_at is null;
select action, count(*) from admin_audit_log where action like 'option.%'
 and occurred_at > now() - interval '24 hours' group by 1 order by 1;
```

## 5. Durdurma ve geri dönüş

1. **Kill switch** (ilk ve çoğu zaman yeterli adım): global anahtarı kapat.
2. **Tek bir grubu durdurmak:** Super Admin → WhatsApp grupları → grubu askıya al ya da bağlantısını
   kaldır (mevcut grup yönetimi).
3. **Görevi durdurmak (gerekirse):** Coolify'da `Option Maintenance` görevini devre dışı bırak.

Hiçbir kayıt silinmez: bekleyen / onaylı işlemler kalır, anahtar kapalıyken uygulanmaz. Yeniden
açmadan önce gereksiz olanlar panelden reddedilir. Açık opsiyonlar müsaitliği etkilemez; panelden
iptal edilebilir ya da süreleri dolar.

**0074'ü geri almak** (yalnız gerekirse): `docs/rollback-0074.sql` üç anahtar kuralını (global +
işletme + grup) geri getirir; uygulama kodu da önceki sürüme döndürülür. Geri almadan sonra işletme
ve grup anahtarı açık olmayan gruplarda otomasyon durur.

**0075'i geri almak** (yalnız gerekirse): `docs/rollback-0075.sql` 0074 durumunu birebir getirir
(sistem varsayılanı sütunları ve yeni fonksiyonlar kalkar, karar fonksiyonu 0069 gövdesine döner).
`system_default` kaynaklı opsiyon / işlem ya da `clarify` işlem varsa betik durur ve sayıları
bildirir; önce bu kayıtlar için karar verilir. Uygulama kodu da önceki sürüme döndürülür.

**0076'yı geri almak** (yalnız gerekirse): `docs/rollback-0076.sql` 0075 durumunu birebir getirir
(süre zinciri mesaj → işletme varsayılanı → sistem varsayılanı; süre ayarı fonksiyonları yeniden
oluşur). Veriye dokunmaz. 0075'i geri almak için önce 0076 geri alınmalıdır.

**0077'yi geri almak** (yalnız gerekirse): `docs/rollback-0077.sql` 0076 durumunu birebir getirir
(karar ve tetikleyici fonksiyonları, iki yeni sütun, bağlantı FK / indeksi, kısıt değerleri).
Uzatma / tarih değişikliği işlemi, `date_changed` ya da bağlı opsiyon varsa betik hiçbir şey
değiştirmeden durur; o durumda yalnız uygulama kodu geri alınır (0076 kodu uzatma / tarih
değişikliği göndermez). Olaylardaki bitiş anlık görüntüsü silinir. 0076'yı geri almak için önce
0077 geri alınmalıdır.
