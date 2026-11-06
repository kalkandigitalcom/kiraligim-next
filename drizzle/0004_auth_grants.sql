-- 0004_auth_grants
-- Ev sahibi kimlik tabloları (0003_auth_tables) için app_user yetkileri.
--
-- RLS UYGULANMAZ (bilinçli karar): Better Auth bu tabloları tenant bağlamı olmadan
-- (app.workspace_id ayarlanmadan) sorgular; RLS açık olsaydı her sorgu boş dönerdi. Koruma:
--   * yalnız app_user'a, Better Auth'un gerçekten kullandığı en dar yetkiler verilir;
--   * PUBLIC'e, app_admin'e ve app_worker'a hiçbir yetki verilmez (tablolar yeni oluşturulduğu
--     için PostgreSQL varsayılanında da yoktur);
--   * Super Admin bu tabloları kullanmaz (ayrı admin_* tabloları, Aşama 2.3);
--   * tenant verisi (workspace, mülk, rezervasyon...) ayrı tablolarda ENABLE + FORCE RLS altındadır.
-- Gerekçe ve test: docs/deployment.md "Kimlik tabloları", tests/integration/auth-tables.test.ts
--
-- users: DELETE yok. Hesap silme Better Auth'ta kapalı (user.deleteUser.enabled = false);
-- KVKK kapsamında ayrı bir süreçle tasarlanacak.
GRANT SELECT, INSERT, UPDATE ON TABLE public.users TO app_user;
--> statement-breakpoint
-- sessions: çıkış/oturum iptali ve süresi geçen oturumların temizliği DELETE gerektirir.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sessions TO app_user;
--> statement-breakpoint
-- accounts: şifre özeti burada; şifre değişimi UPDATE, hesap bağlantısı kaldırma DELETE.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.accounts TO app_user;
--> statement-breakpoint
-- verifications: kullanılan/süresi geçen belirteçler silinir.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.verifications TO app_user;
--> statement-breakpoint
-- rate_limits: okuma, ekleme, atomik sayaç güncellemesi, süresi geçen satırların silinmesi
-- (better-auth/dist/api/rate-limiter: findMany, create, incrementOne, deleteMany).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rate_limits TO app_user;
