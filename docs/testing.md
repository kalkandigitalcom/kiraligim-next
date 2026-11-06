# Testler

| Tür         | Komut                                        | Veritabanı         | Nerede                              |
| ----------- | -------------------------------------------- | ------------------ | ----------------------------------- |
| Birim       | `npm run test:unit` (`npm run check` içinde) | Gerekmez           | Mac, CI                             |
| Entegrasyon | `npm run test:integration`                   | Geçici Postgres 17 | CI (otomatik), sunucu, Mac + Docker |

Entegrasyon testleri gerçek `scripts/db-bootstrap.sql` ve tüm migration'ları **boş, geçici** bir
veritabanına uygular ve şunları doğrular:

- roller ve yetki ayrımı, tablo sahipliği, RLS ve `FORCE ROW LEVEL SECURITY` davranışı (`security.test.ts`)
- kurulum script'inin parola kuralları ve mevcut veriyi koruması (`bootstrap.test.ts`)
- konteyner giriş noktası: açılış migration'ı, hata durumu, parolanın uygulamaya geçmemesi (`entrypoint.test.ts`)
- tenant izolasyonu (`tenant.test.ts`), migration (`migrate.test.ts`), `/api/health` ve rol denetimi (`health.test.ts`) Test altyapısı
  yalnız `localhost`'taki bir Postgres'e bağlanır; geliştirme veya production veritabanında
  çalışması teknik olarak engellenmiştir.

## 1. GitHub Actions (varsayılan)

`develop` ve `main`'e her push'ta ve her PR'da otomatik çalışır (`.github/workflows/ci.yml`).
Geçici Postgres 17 bir servis konteyneri olarak açılır, iş bitince silinir. Ek bir şey yapmak
gerekmez; sonuç GitHub'da **Actions** sekmesinde görünür.

## 2. Sunucuda (Hetzner, Docker kurulu)

`scripts/test-integration-server.sh` testleri sunucuda tamamen izole çalıştırır:

- Coolify'a, Coolify ağlarına, mevcut konteynerlere ve veritabanlarına dokunmaz.
- Hiçbir port dışarı açılmaz; test konteyneri Postgres konteynerinin ağını paylaşır.
- Konteynerler bellek/CPU sınırıyla çalışır (Postgres 512 MB, test 2 GB).
- İş bitince (hata olsa da) konteynerler ve geçici klon silinir.

SSH ile sunucuya bağlanıp normal kullanıcıyla (docker grubunda olmalı):

```bash
curl -fsSL https://raw.githubusercontent.com/kalkandigitalcom/kiraligim-next/develop/scripts/test-integration-server.sh -o /tmp/kg-test.sh
bash /tmp/kg-test.sh develop     # veya: bash /tmp/kg-test.sh main
rm /tmp/kg-test.sh
```

Beklenen son satır: `✓ Entegrasyon testleri başarılı.`

Arta kalan bir şey olup olmadığını kontrol etmek için:

```bash
docker ps -a --filter label=kiraligim.purpose=integration-test   # boş olmalı
```

> Not: İlk çalıştırmada `postgres:17-alpine` ve `node:24-bookworm-slim` imajları indirilir
> (~350 MB). Kaldırmak isterseniz: `docker image rm postgres:17-alpine node:24-bookworm-slim`
> (Coolify bu imajları kullanmıyorsa).

## 3. Mac'te (Docker Desktop açıkken)

```bash
npm run test:integration:docker
```

Docker çalışmıyorsa script açık bir mesajla durur.

## Sorun giderme

- `Test Postgres'ine bağlanılamadı`: Docker/Postgres konteyneri çalışmıyor.
- `db-bootstrap.sql başarısız`: `psql` istemcisi yok veya script hata verdi; mesajın devamında
  psql çıktısı yer alır.
