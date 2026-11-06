# Kiralığım

Villa ve kısa dönem kiralık konaklama işletmeleri için yönetim platformu (SaaS).
Marka adı koda gömülü değildir; `APP_NAME` ortam değişkeninden gelir.

| Yüzey              | Alan adı           | Klasör          |
| ------------------ | ------------------ | --------------- |
| Ev sahibi paneli   | `app.<alan-adı>`   | `src/app/host`  |
| Super Admin paneli | `admin.<alan-adı>` | `src/app/admin` |
| Public sayfalar    | `<alan-adı>`       | `src/app/site`  |

Yönlendirme `src/proxy.ts` içinde, `Host` başlığına göre yapılır. Tanımsız host'lar 404 alır.

## Teknoloji

Next.js 16 (App Router) · TypeScript (strict) · Tailwind CSS 4 · shadcn/ui · PostgreSQL 17 ·
Drizzle ORM · Zod · Vitest. Sonraki fazlarda: Better Auth, pg-boss, Cloudflare R2, Resend,
WhatsApp Cloud API. Barındırma: Hetzner + Coolify.

## Gereksinimler (Mac)

- Node.js **24 LTS** (`.nvmrc`; `nvm use` veya `fnm use` ile). Node 25+ ve 22 desteklenmez
- Sunucudaki geliştirme veritabanına SSH erişimi (anahtarınız `~/.ssh` altında)
- Entegrasyon testleri için Docker Desktop (isteğe bağlı; CI zaten koşturur)

Mac'te Postgres kurulmaz. Geliştirme veritabanı Hetzner'dedir ve internete kapalıdır.

## İlk kurulum

```bash
npm ci
cp .env.example .env.local     # yalnız GELİŞTİRME değerlerini doldurun
npm run db:tunnel              # localhost:5433 → sunucudaki dev veritabanı
npm run dev
```

Tarayıcıda:

- http://app.localhost:3000: ev sahibi paneli
- http://admin.localhost:3000: admin paneli
- http://localhost:3000: public sayfalar
- http://localhost:3000/api/health: sağlık kontrolü

`*.localhost` adresleri macOS'ta ek ayar gerektirmeden 127.0.0.1'e çözülür.

## Komutlar

| Komut                                       | Ne yapar                                                  |
| ------------------------------------------- | --------------------------------------------------------- |
| `npm run dev`                               | Geliştirme sunucusu                                       |
| `npm run db:tunnel`                         | SSH tünelini açar (`-- stop`, `-- status`)                |
| `npm run check`                             | lint + typecheck + format kontrolü + birim testleri       |
| `npm run test:unit`                         | Birim testleri (veritabanı gerekmez)                      |
| `npm run test:integration:docker`           | Geçici Postgres konteyneriyle entegrasyon testleri        |
| `npm run db:generate`                       | Şemadan yeni migration üretir (veritabanına bağlanmaz)    |
| `npm run db:generate:custom -- --name <ad>` | Elle yazılacak boş migration (RLS, roller, kısıtlar)      |
| `npm run db:migrate`                        | Migration'ları `.env.local`'deki dev veritabanına uygular |
| `npm run build`                             | Production build (`.next/standalone`)                     |

## Veritabanı kuralları

- Roller: `app_migrator` (şema sahibi), `app_user` (web, RLS), `app_admin` (Faz 2), `app_worker` (Faz 2).
  Kurulum: `scripts/db-bootstrap.sql` (bkz. `docs/deployment.md`).
- **Emniyet kemeri:** `APP_ENV=production` yalnız `*_prod`, `local`/`development` yalnız `*_dev`,
  `test` yalnız `*_test` adlı veritabanına bağlanır. Aksi halde uygulama ve migration açılmaz.
- Tenant verisi her zaman `withTenant(db, workspaceId, fn)` içinde okunur/yazılır (`src/db/tenant.ts`).
- **Uygulanmış migration dosyası değiştirilmez.** CI, `drizzle/` altındaki mevcut dosyaların
  değişmediğini kontrol eder; düzeltme her zaman yeni bir migration'la yapılır.

## Modül sınırları (ESLint ile zorunlu)

- `pg` ve Drizzle sürücüsü yalnız `src/db` içinde kullanılır.
- `host`, `admin` ve `site` yüzeyleri birbirinden import yapamaz.
- `src/components` veritabanına doğrudan erişemez.

## Git akışı

`feature/*` → PR → `develop` (dev ortamına otomatik deploy) → PR → `main` (production, elle deploy).
CI geçmeden birleştirme yapılmaz. `.env*` dosyaları Git'e girmez (yalnız `.env.example`).

Ayrıntılı sunucu kurulumu: [docs/deployment.md](docs/deployment.md) · Testler: [docs/testing.md](docs/testing.md)
