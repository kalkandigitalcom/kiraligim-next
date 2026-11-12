# Kiraligim Acente API'si — v1

Acenteler, ev sahibinin **izin verdiği** villaların yalnız kimliğini, adını ve dolu tarih
aralıklarını görür ve bu takvimi kendi sistemine **senkronize** eder. API yalnız okur: rezervasyon
oluşturmaz, Kiraligim takvimini değiştirmez; Airbnb/Booking ve iCal kayıtlarına dokunmaz.

- Sözleşme: [`openapi.yaml`](./openapi.yaml)
- Örnekler: [`examples/`](./examples) — senkron istemcisi ve webhook alıcısı (Node.js 20+,
  bağımlılıksız)

| Bölüm                                               | İçerik                                       |
| --------------------------------------------------- | -------------------------------------------- |
| [Erişim](#erişim-nasıl-verilir)                     | Hesap, anahtar, erişim kodu, ev sahibi onayı |
| [Okuma uç noktaları](#okuma-uç-noktaları-1-aşama)   | `/me`, `/properties`, `/availability`        |
| [Takvim senkronu](#takvim-senkronu-2-aşama)         | Bağlantı, snapshot, değişiklik akışları      |
| [Webhook](#webhook)                                 | Kayıt, imza doğrulama, yeniden deneme, sıra  |
| [Önerilen entegrasyon](#önerilen-entegrasyon-akışı) | Adım adım istemci mantığı                    |
| [Hatalar](#hatalar) · [Sınırlar](#istek-sınırı)     |                                              |

## Erişim nasıl verilir?

1. Kiraligim ekibi (Super Admin) acente için API hesabı açar, bir **API anahtarı** ve bir
   **acente erişim kodu** (`KG-XXXX-XXXX`) oluşturur. İkisi de yalnız bir kez gösterilir.
2. Acente kodu ev sahibine verir.
3. Ev sahibi (veya işletme yöneticisi) panelde **Villalar → villa → API erişimi** sekmesinde kodu
   girer, acentenin adını görür ve onaylar. İzin yalnız o villa içindir.
4. Ev sahibi izni aynı ekrandan istediği zaman kaldırır; acente bir sonraki istekte villayı
   göremez, varsa takvim bağlantısı sona erer (`revoked`). Kiraligim ekibi de izin
   verebilir/kaldırabilir.

## Kimlik doğrulama

```
Authorization: Bearer kg_live_xxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Anahtar sorgu dizgisinde kabul edilmez. Kiraligim anahtarın yalnız özetini saklar; kaybolursa
geri alınıp yenisi oluşturulur. Hesap pasifse her istek `403 account_disabled` alır.

## Tarih aralıkları

Tüm tarih aralıkları **yarı açıktır: `[start_date, end_date)`**. `end_date` çıkış günüdür ve dolu
**değildir**; o gün yeni giriş yapılabilir (Kiraligim takviminin kuralıyla aynı). Tarihler
`YYYY-MM-DD`, Europe/Istanbul takvim günüdür. Bitişik ve çakışan kayıtlar tek aralıkta
birleştirilir; kaydın türü (rezervasyon, blok, harici takvim) ve kaynağı gösterilmez.

## Okuma uç noktaları (1. aşama)

| Yöntem | Yol                                              | Dönen                            |
| ------ | ------------------------------------------------ | -------------------------------- |
| GET    | `/api/v1/me`                                     | Hesap kimliği, adı, istek sınırı |
| GET    | `/api/v1/properties?limit=&cursor=`              | İzinli villalar: `id`, `name`    |
| GET    | `/api/v1/properties/{id}`                        | `id`, `name`                     |
| GET    | `/api/v1/properties/{id}/availability?from=&to=` | Dolu aralıklar                   |

`availability`: `from` varsayılanı bugün, `to` varsayılanı `from + 90 gün`. Pencere en fazla 366
gün; `from` bugünden en fazla 12 ay geri, `to` en fazla 24 ay ileri olabilir. `/properties` villa
kimliğine göre sıralıdır; `limit` 1–500 (varsayılan 100), `next_cursor` doluysa
`?cursor=<next_cursor>` ile sonraki sayfa alınır.

## Takvim senkronu (2. aşama)

| Yöntem | Yol                                                               | Ne yapar                                     |
| ------ | ----------------------------------------------------------------- | -------------------------------------------- |
| POST   | `/api/v1/calendar-connections`                                    | Villayı kendi kimliğinizle bağlar            |
| GET    | `/api/v1/calendar-connections?status=current\|all&limit=&cursor=` | Bağlantılar                                  |
| GET    | `/api/v1/calendar-connections/{id}`                               | Tek bağlantı                                 |
| DELETE | `/api/v1/calendar-connections/{id}`                               | Senkronu durdurur (idempotent)               |
| GET    | `/api/v1/calendar-connections/{id}/snapshot`                      | Tam takvim + cursor (ilk/yeniden senkron)    |
| GET    | `/api/v1/calendar-connections/{id}/changes?cursor=&limit=`        | Bu bağlantının cursor sonrası değişiklikleri |
| GET    | `/api/v1/calendar-changes?cursor=&limit=`                         | Hesabın tüm bağlantılarının değişiklikleri   |

### Bağlantı

```http
POST /api/v1/calendar-connections
Content-Type: application/json

{"property_id": "0198…", "external_property_id": "VILLA-123"}
```

- `external_property_id`: sizin sisteminizdeki kimlik (1–100 yazdırılabilir ASCII, baş/son boşluk
  yok). Webhook ve akışlarda geri döner.
- Etkin izin varsa bağlantı hemen `active` olur → `201`. Aynı villa aynı kimlikle zaten bağlıysa
  `200` ve mevcut bağlantı. Farklı kimlikle bağlıysa `409 already_connected`; kimlik başka etkin
  bağlantıda kullanılıyorsa `409 external_id_in_use`. İzin yoksa `404`.
- İstek gövdesi `application/json`, en fazla 4 KB, bilinmeyen alan kabul edilmez.

Bağlantı durumları:

| `status`       | Anlamı                                                                              |
| -------------- | ----------------------------------------------------------------------------------- |
| `active`       | Senkron çalışıyor                                                                   |
| `paused`       | Villa veya işletme geçici olarak pasif. Snapshot/changes `404`, webhook gönderilmez |
| `disconnected` | Siz kestiniz (DELETE). Kalıcı; yeniden bağlanmak için yeni POST                     |
| `revoked`      | Ev sahibi veya Kiraligim izni kaldırdı. Kalıcı                                      |

`paused` saklanan bir durum değildir; villa/işletme yeniden etkinleştiğinde bağlantı kendiliğinden
`active` olur ve **tam pencere değişikliği** (12 ay geri – 24 ay ileri) gelir. DELETE yalnız
senkronu durdurur; sizin sisteminizdeki kayıtlara dokunulmaz.

### Snapshot

```json
{
  "connection_id": "0198…",
  "property_id": "0198…",
  "external_property_id": "VILLA-123",
  "from": "2025-11-11",
  "to": "2028-11-12",
  "busy_dates": [{ "start_date": "2026-12-10", "end_date": "2026-12-14" }],
  "cursor": "c1.…"
}
```

`busy_dates` ve `cursor` **aynı veri anındandır**: cursor'dan sonraki her değişiklik akışta
gelir, öncekiler snapshot'ın içindedir. Pencere bugünden 12 ay geri – 24 ay ileridir.
Snapshot'ı yerel takviminizi **tamamen değiştirerek** uygulayın. Yeni snapshot, o bağlantı için
daha önce kuyruğa girmiş ve henüz teslim edilmemiş webhook'ları geçersiz kılar.

### Değişiklik

```json
{
  "change_id": "1842",
  "start_date": "2026-12-08",
  "end_date": "2026-12-20",
  "busy_dates": [{ "start_date": "2026-12-10", "end_date": "2026-12-14" }]
}
```

Değişiklik bir **aralığın tam hâlidir**: `[start_date, end_date)` içindeki yerel doluluğu silin,
sonra `busy_dates`'i yazın. Aralığın kalanı boştur. Aynı değişikliği iki kez uygulamak sonucu
değiştirmez (idempotent). `change_id` artan bir sayıdır (metin olarak döner); aynı bağlantının
değişikliklerini `change_id` sırasıyla uygulayın.

### Değişiklik akışları

**Bağlantı akışı** — `GET /calendar-connections/{id}/changes?cursor=<snapshot.cursor>&limit=`:
yanıt `{connection_id, property_id, external_property_id, changes[], next_cursor, has_more}`.
`has_more` doğruysa hemen `next_cursor` ile devam edin; değilse `next_cursor`'ı saklayın ve
sonra (ör. birkaç dakikada bir veya webhook geldiğinde) tekrar sorun. Cursor her zaman gerekir.

**Hesap akışı** — `GET /calendar-changes?cursor=&limit=`: tüm **etkin** bağlantılarınızın
değişiklikleri tek sırada; her öğe ayrıca `connection_id`, `property_id`,
`external_property_id` içerir. Cursor verilmezse **şimdiki konumdan** başlar (boş liste +
cursor). Her bağlantı için yalnız o bağlantının **son snapshot'ından sonraki** değişiklikler
gelir; snapshot almadığınız bağlantının değişiklikleri gelmez. Kesilen, izni kaldırılan veya
duraklatılan bağlantıların değişiklikleri gelmez.

Cursor kuralları (iki akış için aynı):

- Cursor opaktır ve imzalıdır; yalnız verildiği bağlantıda (`c1.`) veya hesapta (`a1.`) geçerlidir.
  Başka bağlantının/hesabın cursor'ı, değiştirilmiş cursor veya diğer akışın cursor'ı
  `400 invalid_cursor`.
- **30 günden eski** cursor veya saklama süresini (31 gün) geçmiş konum `410 cursor_expired`:
  yeni snapshot alın.
- `limit` 1–500 (varsayılan 100).

## Webhook

Hesap başına bir HTTPS adresi. Bir değişiklik olduğunda **snapshot almış** her etkin
bağlantınız için bir olay gönderilir. Webhook yalnız "değişti" bildirimidir; kaçırılan olay
akıştan her zaman alınabilir.

| Yöntem | Yol                             | Ne yapar                                                                           |
| ------ | ------------------------------- | ---------------------------------------------------------------------------------- |
| GET    | `/api/v1/webhook`               | Adres ve tarihler (sır dönmez); yoksa `404`                                        |
| PUT    | `/api/v1/webhook` `{"url": …}`  | Oluşturur (`201`, **sır yalnız bu yanıtta**) / adresi değiştirir (`200`, sır aynı) |
| DELETE | `/api/v1/webhook`               | Siler; bekleyen teslimler iptal edilir                                             |
| POST   | `/api/v1/webhook/rotate-secret` | Yeni sır (yalnız bu yanıtta); eski sır **hemen** geçersiz                          |

Adres kuralları: `https://`, port yok veya 443, kullanıcı adı/şifre ve `#` yok, en fazla 2048
karakter, genel internette çözülen bir alan adı (yerel/özel IP ve `localhost`, `.local`,
`.internal` gibi adlar reddedilir). Gönderim anında da ad çözülür; özel ağa çözülen adrese
gönderilmez. **Yönlendirme izlenmez** (3xx başarısız sayılır).

### İstek

```http
POST /sizin/adresiniz
Content-Type: application/json
User-Agent: Kiraligim-Webhooks/1.0 (+https://kiraligim.com)
Kiraligim-Event-Id: 0198f3…
Kiraligim-Timestamp: 1767225600
Kiraligim-Signature: v1=5f2c…

{
  "id": "0198f3…",
  "type": "calendar.changed",
  "created_at": "2026-11-12T10:15:03.120Z",
  "connection_id": "0198…",
  "property_id": "0198…",
  "external_property_id": "VILLA-123",
  "change": {
    "change_id": "1842",
    "start_date": "2026-12-08",
    "end_date": "2026-12-20",
    "busy_dates": [{ "start_date": "2026-12-10", "end_date": "2026-12-14" }]
  }
}
```

### İmza doğrulama

`Kiraligim-Signature = "v1=" + hex(HMAC-SHA256(sır, Kiraligim-Timestamp + "." + ham_gövde))`.

1. Gövdeyi **ham bayt** olarak okuyun (JSON'u ayrıştırıp yeniden yazmayın).
2. Zaman damgası 5 dakikadan eskiyse/ilerideyse reddedin (yeniden oynatma koruması).
3. Beklenen imzayı hesaplayıp **sabit süreli** karşılaştırın.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verify(secret, headers, rawBody, now = Math.floor(Date.now() / 1000)) {
  const ts = headers["kiraligim-timestamp"];
  const sig = headers["kiraligim-signature"] ?? "";
  if (!/^\d+$/.test(ts ?? "") || Math.abs(now - Number(ts)) > 300) return false;
  const expected = "v1=" + createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Tam alıcı örneği: [`examples/webhook-receiver.mjs`](./examples/webhook-receiver.mjs).

### Teslim garantileri

- **En az bir kez.** Aynı olay birden fazla gelebilir; `Kiraligim-Event-Id` (= gövdedeki `id`)
  yeniden denemelerde değişmez. Olay kimliğine göre tekrarları atlayın veya değişikliği
  idempotent uygulayın (yukarıdaki kural zaten idempotenttir).
- **Bağlantı başına sıra.** Bir bağlantının olayı başarıyla teslim edilmeden aynı bağlantının
  sonraki olayı gönderilmez. Farklı bağlantıların olayları paralel gelebilir.
- **Başarı:** 10 saniye içinde `2xx`. Gövde okunmaz. Uzun işi kuyruğa alıp hemen `2xx` dönün.
- **Yeniden deneme:** başarısız denemeden sonra 1 dk, 5 dk, 15 dk, 1 sa, 3 sa, 6 sa, 12 sa,
  24 sa (toplam 9 deneme, ~2 gün). Sonra olay bırakılır; veri akıştan alınabilir. Baştaki olay
  beklerken o bağlantının sonraki olayları da bekler.
- Gönderilmez / iptal edilir: bağlantı kesildi veya izin kaldırıldı; webhook silindi; villa veya
  işletme pasif (yeniden etkinleşince tam pencere değişikliği gelir); yeni snapshot alındı
  (eski olaylar geçersiz); olay 31 günden eski.
- Hesap pasifken olaylar **bekletilir**, hesap yeniden etkinleşince gönderilir.

## Önerilen entegrasyon akışı

1. `GET /properties` ile izinli villaları bulun; her biri için
   `POST /calendar-connections {property_id, external_property_id}`.
2. (İsteğe bağlı) `PUT /webhook {url}`; dönen `secret`'ı güvenli saklayın.
3. Her bağlantı için `GET …/snapshot` → yerel takvimi tamamen değiştirin, `cursor`'ı saklayın.
4. Değişiklikleri alın — iki yoldan biri:
   - **Bağlantı başına:** `GET …/changes?cursor=` (`has_more` bitene kadar), `next_cursor`'ı saklayın.
   - **Tek akış:** snapshot'lardan **önce** `GET /calendar-changes` ile bir hesap cursor'ı alın,
     sonra bu cursor'la düzenli sorun; her öğeyi `connection_id`'sine uygulayın.
5. Webhook geldiğinde değişikliği doğrudan uygulayın (ya da yalnız tetikleyici olarak akışı
   sorun). Webhook'u tek kaynak saymayın: birkaç dakikada bir akışı da sorun.
6. `410 cursor_expired` → o bağlantı için yeniden snapshot. `404` → bağlantı duraklatılmış veya
   bitmiş: `GET /calendar-connections/{id}` ile `status`'a bakın; `paused` ise bekleyin
   (etkinleşince tam pencere gelir; cursor 30 günü geçtiyse yeniden snapshot), `disconnected`/
   `revoked` ise yerel eşlemeyi kapatın.

Örnek istemci: [`examples/sync-client.mjs`](./examples/sync-client.mjs).

```bash
export KG_API_KEY=kg_live_…
curl -s -H "Authorization: Bearer $KG_API_KEY" https://app.kiraligim.com/api/v1/properties
curl -s -X POST -H "Authorization: Bearer $KG_API_KEY" -H "Content-Type: application/json" \
  -d '{"property_id":"0198…","external_property_id":"VILLA-123"}' \
  https://app.kiraligim.com/api/v1/calendar-connections
curl -s -H "Authorization: Bearer $KG_API_KEY" \
  https://app.kiraligim.com/api/v1/calendar-connections/0198…/snapshot
```

## İstek sınırı

Anahtar başına **dakikada 120 istek** (takvim dakikası). Her yanıtta `X-RateLimit-Limit`,
`X-RateLimit-Remaining`, `X-RateLimit-Reset` (saniye) başlıkları vardır; sınır aşılınca `429` ve
`Retry-After`.

## Hatalar

Gövde her zaman `{"error": {"code": "...", "message": "..."}}`.

| HTTP | code                     | Ne zaman                                                            |
| ---- | ------------------------ | ------------------------------------------------------------------- |
| 400  | `invalid_request`        | Geçersiz/bilinmeyen parametre veya alan                             |
| 400  | `invalid_cursor`         | Cursor bu bağlantıya/hesaba ait değil, bozuk veya değiştirilmiş     |
| 401  | `unauthorized`           | Anahtar yok, geçersiz veya geri alınmış                             |
| 403  | `account_disabled`       | API hesabı pasif                                                    |
| 404  | `not_found`              | Villa/bağlantı yok, izin yok, başka acenteye ait veya duraklatılmış |
| 405  | `method_not_allowed`     | Desteklenmeyen yöntem (`Allow` başlığına bakın)                     |
| 409  | `already_connected`      | Villa farklı `external_property_id` ile zaten bağlı                 |
| 409  | `external_id_in_use`     | `external_property_id` başka etkin bağlantıda                       |
| 410  | `cursor_expired`         | Cursor 30 günden eski veya saklama süresi geçmiş: yeniden snapshot  |
| 413  | `payload_too_large`      | Gövde 4 KB'tan büyük                                                |
| 415  | `unsupported_media_type` | `Content-Type: application/json` değil                              |
| 429  | `rate_limited`           | Dakikalık sınır aşıldı                                              |
| 500  | `internal_error`         | Geçici sunucu hatası                                                |
| 503  | `webhooks_unavailable`   | Webhook oluşturma/sır yenileme geçici olarak kullanılamıyor         |

## Paylaşılmayan veriler

Açıklama, fotoğraf, özellikler, tam adres ve koordinatlar, günlük fiyatlar, ev sahibi bilgileri,
misafir adı/telefonu/kişisel bilgileri, rezervasyon tutarları, özel notlar ve kaynak kanal bilgisi
hiçbir uç noktada ve webhook'ta dönmez.
