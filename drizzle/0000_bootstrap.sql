-- 0000_bootstrap
-- Rolleri OLUŞTURMAZ (bkz. scripts/db-bootstrap.sql); yalnız uzantı ve şema yetkileri.
-- Rol yoksa bu migration hata verir: önce db-bootstrap.sql çalıştırılmalıdır.

-- Rezervasyon çakışma kısıtı (GiST exclusion, daterange) için gerekli. PG13+ "trusted" uzantı:
-- veritabanı sahibi (app_migrator) süper kullanıcı olmadan kurabilir.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint

-- Uygulama rolleri şemayı kullanabilir ama nesne oluşturamaz.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_user, app_admin, app_worker;
--> statement-breakpoint

-- app_migrator'ın ileride oluşturacağı fonksiyonlar herkese açık çalıştırılamaz;
-- gereken yetki her migration'da açıkça verilir (SECURITY DEFINER fonksiyonları için önemli).
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--> statement-breakpoint

-- Tablo yetkileri varsayılan olarak verilmez: her tablo kendi migration'ında,
-- hangi rolün neye erişeceği açıkça yazılarak yetkilendirilir.
SELECT 1;
