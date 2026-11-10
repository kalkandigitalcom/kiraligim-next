-- =====================================================================
-- Super Admin veritabanı rolü: app_admin'e LOGIN ve parola (her ortamda BİR KEZ, yönetici kullanıcıyla)
--
-- app_admin db-bootstrap.sql ile NOLOGIN olarak vardır. Bu betik yalnız girişini açar ve parolasını
-- ayarlar. Rolün yetkileri migration'larla verilir (0042: yalnız admin_* tabloları). İşletme
-- tablolarına (workspaces, properties, reservations, wa_*…) hiçbir doğrudan yetkisi yoktur.
-- SUPERUSER, CREATEDB, CREATEROLE, BYPASSRLS değildir; INHERIT kapalı; en fazla 5 bağlantı.
--
-- Ön koşul: 0041–0042 migration'ları uygulanmış olmalı.
--
-- Kullanım (parola KOMUT SATIRINDA DEĞİL, ortam değişkeninde; yalnız [A-Za-z0-9], en az 32 karakter):
--   openssl rand -hex 24
--   read -rs -p "app_admin parolası: " KG_ADMIN_DB_PASSWORD; echo; export KG_ADMIN_DB_PASSWORD
--   docker exec -i -e KG_ADMIN_DB_PASSWORD <postgres-konteyneri> \
--     sh -c 'psql -U "$POSTGRES_USER" -d postgres -X -v ON_ERROR_STOP=1 -v db_name=kiraligim_prod -f -' \
--     < scripts/admin-role.sql
--   unset KG_ADMIN_DB_PASSWORD
-- Ardından uygulamaya DATABASE_ADMIN_URL=postgres://app_admin:<parola>@<host>:5432/kiraligim_prod
-- ve ADMIN_SECRET_KEY (openssl rand -base64 32) eklenir.
--
-- Tekrar çalıştırılabilir: veri silmez; yalnız parolayı yeniden yazar.
-- Geri alma: ALTER ROLE app_admin NOLOGIN PASSWORD NULL; (DATABASE_ADMIN_URL kaldırılır).
-- =====================================================================

\set ON_ERROR_STOP on
\set QUIET on

-- Parola içeren ifadeler sunucu log'una yazılmasın (bu oturum için; süper kullanıcı gerekir).
SET log_statement = 'none';
SET log_min_duration_statement = -1;
SET log_min_error_statement = 'panic';

\getenv admin_password KG_ADMIN_DB_PASSWORD

\if :{?db_name}
\else
  \warn 'HATA: -v db_name=... verilmedi'
  DO $$ BEGIN RAISE EXCEPTION 'admin-role durduruldu'; END $$;
\endif
\if :{?admin_password}
\else
  \warn 'HATA: KG_ADMIN_DB_PASSWORD ortam değişkeni tanımlı değil'
  DO $$ BEGIN RAISE EXCEPTION 'admin-role durduruldu'; END $$;
\endif

SELECT (:'db_name' ~ '_(dev|prod|test)$') AS db_name_ok \gset
\if :db_name_ok
\else
  \warn 'HATA: db_name _dev, _prod veya _test ile bitmeli'
  DO $$ BEGIN RAISE EXCEPTION 'admin-role durduruldu'; END $$;
\endif

SELECT (length(:'admin_password') >= 32 AND :'admin_password' ~ '^[A-Za-z0-9]+$') AS password_ok \gset
\if :password_ok
\else
  \warn 'HATA: parola en az 32 karakter ve yalnız harf/rakam olmalı (openssl rand -hex 24)'
  DO $$ BEGIN RAISE EXCEPTION 'admin-role durduruldu'; END $$;
\endif

\connect :"db_name"
SET log_statement = 'none';
SET log_min_duration_statement = -1;
SET log_min_error_statement = 'panic';

SELECT to_regclass('public.admin_users') IS NOT NULL AS tables_ok \gset
\if :tables_ok
\else
  \warn 'HATA: admin_* tabloları bulunamadı; önce 0041–0042 migration''ları uygulanmalı'
  DO $$ BEGIN RAISE EXCEPTION 'admin-role durduruldu'; END $$;
\endif

SELECT format('ALTER ROLE app_admin LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT NOREPLICATION CONNECTION LIMIT 5', :'admin_password') \gexec
ALTER ROLE app_admin SET statement_timeout = '15s';
ALTER ROLE app_admin SET idle_in_transaction_session_timeout = '30s';
SELECT format('GRANT CONNECT ON DATABASE %I TO app_admin', :'db_name') \gexec
SELECT format('REVOKE TEMPORARY ON DATABASE %I FROM app_admin', :'db_name') \gexec

\set QUIET off
\echo 'Tamam: app_admin girişi açıldı (yalnız admin_* tabloları; işletme verisine doğrudan yetki yok).'
