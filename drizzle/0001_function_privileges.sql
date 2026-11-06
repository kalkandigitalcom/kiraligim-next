-- 0001_function_privileges
-- 0000'daki şemaya özel (IN SCHEMA public) varsayılan yetki iptali PostgreSQL'de etkisizdir:
-- şema düzeyindeki varsayılan yetkiler yalnız EKLEME yapabilir, genel varsayılanı (PUBLIC EXECUTE)
-- kaldıramaz. Genel varsayılan burada kaldırılır: app_migrator'ın bundan sonra oluşturacağı
-- fonksiyon/prosedürleri hiçbir rol, açıkça GRANT EXECUTE verilmeden çalıştıramaz.
-- (tests/integration/security.test.ts bu davranışı doğrular.)
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
