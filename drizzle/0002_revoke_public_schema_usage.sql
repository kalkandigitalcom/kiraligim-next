-- 0002_revoke_public_schema_usage
-- PostgreSQL 15+ public şemasında PUBLIC'e (tüm rollere) USAGE verir; 0000 yalnız CREATE'i kaldırmıştı.
-- En az yetki: PUBLIC'in USAGE'ı da kaldırılır. Uygulama rolleri (app_user, app_admin, app_worker)
-- USAGE'ı 0000'daki açık GRANT ile korur. Şema sahibi app_migrator olduğu için süper kullanıcı gerekmez.
-- (tests/integration/security.test.ts → "public şema yetkileri")
REVOKE USAGE ON SCHEMA public FROM PUBLIC;
