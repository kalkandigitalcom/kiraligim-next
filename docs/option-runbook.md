# Opsiyon otomasyonu — işletim kılavuzu (tek ve ortak sistem, 0074)

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
   Mesajda başka bir villanın adı yazılırsa otomatik işlem yapılmaz (onaya düşer).
6. **Süre:** mesajda yazan süre (1 saat – 14 gün, girişten önce dolmalı) ya da işletmenin varsayılan
   süresi (Otomasyon ayarları → İşletmeler). İkisi de yoksa Super Admin onayına düşer.
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
- [ ] İşletmelerin varsayılan opsiyon süreleri (isteğe bağlı) ayarlanmış.

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

-- İşletmelerin varsayılan süreleri.
select workspace_id, default_duration_minutes from workspace_option_settings;

-- Global anahtar.
select enabled, updated_at from option_automation_global;
```

## 4. İzleme (salt okunur)

```sql
select status, count(*) from reservation_options group by 1 order by 1;
select kind, mode, status, count(*) from option_operations group by 1,2,3 order by 1,2,3;
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
