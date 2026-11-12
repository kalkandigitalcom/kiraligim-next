# Kiraligim Acente API'si — v1 (1. aşama, yalnız okuma)

Acenteler, ev sahibinin **izin verdiği** villaların yalnız kimliğini, adını ve dolu tarih
aralıklarını okur. Rezervasyon yazma, webhook ve takvim bağlama bu aşamada yoktur.

Sözleşme: [`openapi.yaml`](./openapi.yaml).

## Erişim nasıl verilir?

1. Kiraligim ekibi (Super Admin) acente için API hesabı açar, bir **API anahtarı** ve bir
   **acente erişim kodu** (`KG-XXXX-XXXX`) oluşturur. İkisi de yalnız bir kez gösterilir.
2. Acente kodu ev sahibine verir.
3. Ev sahibi (veya işletme yöneticisi) panelde **Villalar → villa → API erişimi** sekmesinde kodu
   girer, acentenin adını görür ve onaylar. İzin yalnız o villa içindir.
4. Ev sahibi izni aynı ekrandan istediği zaman kaldırır; acente bir sonraki istekte villayı
   göremez. Kiraligim ekibi de izin verebilir/kaldırabilir.

## Kimlik doğrulama

```
Authorization: Bearer kg_live_xxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Anahtar sorgu dizgisinde kabul edilmez. Kiraligim anahtarın yalnız özetini saklar; kaybolursa
geri alınıp yenisi oluşturulur.

## Uç noktalar

| Yöntem | Yol                                              | Dönen                            |
| ------ | ------------------------------------------------ | -------------------------------- |
| GET    | `/api/v1/me`                                     | Hesap kimliği, adı, istek sınırı |
| GET    | `/api/v1/properties?limit=&cursor=`              | İzinli villalar: `id`, `name`    |
| GET    | `/api/v1/properties/{id}`                        | `id`, `name`                     |
| GET    | `/api/v1/properties/{id}/availability?from=&to=` | Dolu aralıklar                   |

### Müsaitlik

```json
{
  "property_id": "0198…",
  "from": "2027-07-01",
  "to": "2027-08-01",
  "busy_dates": [
    { "start_date": "2027-07-10", "end_date": "2027-07-14" },
    { "start_date": "2027-07-20", "end_date": "2027-07-25" }
  ]
}
```

- Aralıklar **yarı açıktır: `[start_date, end_date)`**. `end_date` çıkış günüdür ve dolu
  **değildir**; o gün yeni giriş yapılabilir (Kiraligim takviminin kuralıyla aynı).
- Bitişik ve çakışan kayıtlar tek aralıkta birleştirilir; aralıklar `[from, to)` penceresine
  kırpılır. Kaydın türü (rezervasyon, blok, harici takvim) ve kaynağı gösterilmez.
- `from` varsayılanı bugün (Europe/Istanbul), `to` varsayılanı `from + 90 gün`. Pencere en fazla
  366 gün; `from` bugünden en fazla 12 ay geri, `to` en fazla 24 ay ileri olabilir.

### Sayfalama

`/properties` villa kimliğine göre sıralıdır. `limit` 1–500 (varsayılan 100). Yanıttaki
`next_cursor` doluysa bir sonraki sayfa için `?cursor=<next_cursor>` gönderilir.

## İstek sınırı

Anahtar başına **dakikada 120 istek** (takvim dakikası). Her yanıtta `X-RateLimit-Limit`,
`X-RateLimit-Remaining`, `X-RateLimit-Reset` (saniye) başlıkları vardır; sınır aşılınca `429` ve
`Retry-After`.

## Hatalar

Gövde her zaman `{"error": {"code": "...", "message": "..."}}`.

| HTTP | code                 | Ne zaman                                                 |
| ---- | -------------------- | -------------------------------------------------------- |
| 400  | `invalid_request`    | Geçersiz/bilinmeyen parametre                            |
| 401  | `unauthorized`       | Anahtar yok, geçersiz veya geri alınmış                  |
| 403  | `account_disabled`   | API hesabı pasif                                         |
| 404  | `not_found`          | Villa yok, izin yok veya başka acenteye ait (aynı yanıt) |
| 405  | `method_not_allowed` | GET dışı yöntem                                          |
| 429  | `rate_limited`       | Dakikalık sınır aşıldı                                   |
| 500  | `internal_error`     | Geçici sunucu hatası                                     |

## Paylaşılmayan veriler

Açıklama, fotoğraf, özellikler, tam adres ve koordinatlar, günlük fiyatlar, ev sahibi bilgileri,
misafir adı/telefonu/kişisel bilgileri, rezervasyon tutarları, özel notlar ve kaynak kanal bilgisi
hiçbir uç noktada dönmez.
