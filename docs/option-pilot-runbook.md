# Opsiyon otomasyonu — tek grup pilotu (Aşama 3f) işletim kılavuzu

Bu kılavuz, WhatsApp opsiyon otomasyonunun **tek bir test grubu, tek bir işletme (workspace) ve tek
bir test villası** üzerinde güvenle denenmesi içindir. Aşama 3f'de uygulama kodu ve veritabanı
şeması DEĞİŞMEZ; pilot mevcut üç anahtarla ve `option-maintenance` göreviyle çalışır.
Davranışın test kanıtı: `tests/integration/option-pilot.test.ts`.

## 1. Temel kurallar

1. **Global kill switch her zaman önceliklidir.** Bir sorun görüldüğünde ilk ve tek gereken adım,
   Super Admin → Opsiyonlar → Otomasyon ayarları sayfasındaki **"Kill switch: otomasyonu hemen kapat"**
   düğmesidir. Global anahtar kapalıyken işletme ve grup anahtarları açık olsa bile hiçbir WhatsApp
   mesajı okunmaz, hiçbir onaylı işlem ve kesinleştirme uygulanmaz (bir sonraki dakikadan itibaren).
2. **Pilot süresince YALNIZ belirlenen test grubunun anahtarı açılır.** Bir grubun mesajları yalnız
   global + işletme + grup anahtarının üçü de açıkken işlenir; grup anahtarı kapalı grup hiçbir
   opsiyon işlemi üretmez ve onaylı işlemi uygulanmaz.
   **Kabul edilen risk:** ikinci bir grubun anahtarının yanlışlıkla açılması veritabanında
   engellenmez. Bu nedenle pilot süresince Otomasyon ayarları sayfasında başka hiçbir grubun anahtarı
   açılmaz ve pilot işletmesi dışında hiçbir işletmenin otomasyon anahtarı açılmaz (bkz. 3.4).
3. **Opsiyonlar müsaitliği etkilemez.** Açık opsiyon; panel takvimi, herkese açık villa sayfası,
   API, iCal ve webhook çıktısında görünmez ve çakışma hesabını değiştirmez. Yalnız Super Admin'in
   onayladığı kesinleştirme, mevcut rezervasyon servisiyle kesin rezervasyon oluşturur.
4. **Kesinleştirme her zaman Super Admin onayıyla.** "Ödeme alındı" gibi mesajlar onaya düşer;
   onayda misafir adı, yetişkin ve çocuk sayısı (yoksa 0) açıkça girilir.
5. **Mevcut sistem aynen çalışır.** WhatsApp worker, ayrıştırıcı, ağ geçidi, tepki kuyruğu,
   rezervasyon akışı, API, iCal ve webhook değişmez. Opsiyon mesajlarına worker'ın verdiği ⚠️
   tepkisi aynen devam eder (opsiyon kaydedilmiş olsa da); pilot kullanıcısına önceden anlatılır.
6. **Villa veya işletme değişikliğinden önce** grubun opsiyon anahtarını kapatın. Grubun villası
   değiştirilirse eski villaya ait onaylı işlemler uygulanmaz (`group_changed`); sonraki opsiyonlar
   yeni villa için açılır.
7. **Onaya düşen işlemler için bildirim yoktur.** Pilot süresince Super Admin → Opsiyonlar → "Onay
   bekleyen" sekmesi günde en az iki kez kontrol edilir.

## 2. Önkoşullar (her biri ayrı onayla)

- [ ] Production veritabanı yedeklemesi çözülmüş ve doğrulanmış.
- [ ] Coolify'da `node dist/option-maintenance.js` görevi (her dakika, `* * * * *`) oluşturulmuş;
      önce DEVRE DIŞI oluşturulup anahtarlar kapalıyken etkinleştirilmiş ve en az birkaç saat
      "Last run: success" görülmüş. Anahtarlar kapalıyken görev yalnız süre dolumu ve çakışma
      uyarısı adımlarını çalıştırır; opsiyon yoksa hiçbir şey değiştirmez.
- [ ] Pilot grup, işletme ve villa yazılı olarak belirlenmiş; villa sahibi bilgilendirilmiş.

## 3. Açılış öncesi salt okunur kontroller

Production veritabanında yalnız salt okunur oturumla çalıştırılır:

```sh
PGOPTIONS='-c default_transaction_read_only=on' psql -X -At -U "$POSTGRES_USER" -d kiraligim_prod
```

`:'g'` yerine pilot grubun kimliği yazılır (`\set g '<grup-uuid>'`). Sorgular kişisel veri
döndürmez.

### 3.1 Grup, villa ve işletme

```sql
select g.status = 'linked'            as grup_bagli,
       g.archived_at is null          as arsivlenmemis,
       p.id                           as villa_id,
       p.status = 'active'            as villa_aktif,
       w.status = 'active'            as isletme_aktif,
       g.workspace_id                 as isletme_id
  from wa_groups g
  join properties p on p.id = g.property_id and p.workspace_id = g.workspace_id
  join workspaces w on w.id = g.workspace_id
 where g.id = :'g';
```

Beklenen: tek satır; `grup_bagli`, `arsivlenmemis`, `villa_aktif`, `isletme_aktif` hepsi `t`;
`villa_id` belirlenen test villası.

### 3.2 Sahip ve doğrulanmış telefon

```sql
select count(*) filter (where m.role = 'owner')                          as sahip,
       count(*) filter (where m.role in ('owner','manager') and v.user_id is not null)
                                                                         as dogrulanmis_sahip_yonetici
  from wa_groups g
  join workspace_members m on m.workspace_id = g.workspace_id
  left join wa_verified_phones v on v.user_id = m.user_id
 where g.id = :'g';
```

Beklenen: `sahip` ≥ 1 ve `dogrulanmis_sahip_yonetici` ≥ 1. Opsiyon işlemini yalnız doğrulanmış
sahip veya yönetici başlatabilir; personel ve doğrulanmamış katılımcının mesajı işlem üretmez.

### 3.3 İşletme varsayılan süresi

```sql
select s.automation_enabled, s.default_duration_minutes
  from wa_groups g left join workspace_option_settings s on s.workspace_id = g.workspace_id
 where g.id = :'g';
```

Süre yazılmayan mesajın otomatik uygulanması için `default_duration_minutes` dolu olmalı (panelden
ayarlanır). Boşsa bu mesajlar Super Admin onayına düşer; pilot yine güvenlidir.

### 3.4 Başka açık anahtar yok

```sql
select (select enabled from option_automation_global where id = 1)                as global,
       (select count(*) from workspace_option_settings where automation_enabled)   as acik_isletme,
       (select count(*) from wa_group_option_settings where enabled)               as acik_grup,
       (select count(*) from wa_group_option_settings where enabled and group_id <> :'g')
                                                                                  as pilot_disi_acik_grup;
```

Açılıştan önce beklenen: `global = f`, `acik_isletme = 0`, `acik_grup = 0`.
Pilot süresince beklenen: `acik_isletme = 1` (pilot işletmesi), `acik_grup = 1`,
**`pilot_disi_acik_grup = 0`**. Bu değer 0 değilse hemen kill switch kapatılır.

## 4. Açma sırası

1. Otomasyon ayarları → İşletmeler: pilot işletmesi için varsayılan süreyi ayarla ve otomasyonu aç (onay kutusu).
2. Otomasyon ayarları → WhatsApp grupları: YALNIZ pilot grubun anahtarını aç.
3. 3.4'teki sorguyu çalıştır: `pilot_disi_acik_grup = 0` olmalı.
4. İzlenebilir bir saatte Otomasyon ayarları → Global anahtar (kill switch): "Global anahtarı aç" (onay kutusu).
5. Açılma anından ÖNCE gelen mesajlar geriye dönük işlenmez.

## 5. Pilot testleri (mesajları pilot kullanıcısı gönderir)

| Mesaj                                                               | Beklenen                                                                                                                 |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `<tarih> opsiyon 1 saat`                                            | Açık opsiyon; 1 saat sonra süresi dolar (`expired`). Takvim değişmez.                                                    |
| `<tarih> opsiyon 48 saat`, sonra `<tarih> opsiyon müşteri vazgeçti` | Opsiyon açılır, sonra `customer_declined` ile kapanır.                                                                   |
| Kesin kaydı olan tarihe opsiyon                                     | Otomatik uygulanmaz; onaya düşer (`calendar_conflict`).                                                                  |
| `<tarih> opsiyon ödeme alındı`                                      | Onaya düşer; Super Admin misafir bilgisini girip onaylar; ~1 dk içinde kesin rezervasyon (kaynak WhatsApp, sahip adına). |
| Personelin opsiyon mesajı                                           | İşlem oluşmaz.                                                                                                           |
| `<tarih> kapat` (mevcut komut)                                      | Eskisi gibi blok oluşur; opsiyon işlemi yazılmaz.                                                                        |

## 6. İzleme (salt okunur)

```sql
select status, count(*) from reservation_options group by 1 order by 1;
select kind, mode, status, count(*) from option_operations group by 1,2,3 order by 1,2,3;
select status, count(*) from option_message_scans group by 1 order by 1;
select count(*) from option_conflict_alerts where acknowledged_at is null;
select action, count(*) from admin_audit_log where action like 'option.%'
 and occurred_at > now() - interval '24 hours' group by 1 order by 1;
```

Ayrıca: Coolify'da `option-maintenance`, `WhatsApp Calendar Worker`, `api-sync`, `ical-sync`
görevlerinin "Last run: success" durumu ve `/api/health`.

## 7. Durdurma ve geri dönüş

Sırasıyla (her adım tek başına güvenlidir; ilk adım her zaman yeterlidir):

1. **Kill switch:** Otomasyon ayarları → Global anahtar (kill switch) → "Kill switch: otomasyonu hemen kapat". Kapatma onay
   istemez; bir sonraki dakikadan itibaren hiçbir mesaj okunmaz ve hiçbir onaylı işlem uygulanmaz.
2. **Grubu kapat:** Otomasyon ayarları → WhatsApp grupları → pilot grubun anahtarı kapalı.
3. **Görevi durdur (gerekirse):** Coolify'da `option-maintenance` görevini devre dışı bırak.
   Görev dururken süresi dolan opsiyonlar panelde "açık" görünmeye devam eder; müsaitliği
   etkilemez.

Geri dönüşte:

- **Hiçbir kayıt silinmez.** Bekleyen ve onaylı işlemler olduğu gibi kalır; anahtarlar kapalıyken
  uygulanmaz. Yeniden açmadan önce gereksiz olanlar panelden reddedilir (aksi halde yeniden
  açıldığında takvim yeniden doğrulanarak uygulanırlar).
- **Açık opsiyonlar** geçmişleriyle korunur; müsaitliği etkilemedikleri için acil müdahale
  gerekmez. Gerekirse Super Admin panelinden iptal edilir (`panel_cancel`) ya da süreleri dolar.
- **Kesinleşmiş rezervasyonlar** normal rezervasyondur; gerekiyorsa mevcut panel akışıyla yönetilir.
- Kod veya migration geri alma GEREKMEZ (Aşama 3f şemayı ve uygulama kodunu değiştirmez).
