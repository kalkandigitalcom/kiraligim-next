-- =====================================================================
-- Veritabanı kurulumu (her ortamda BİR KEZ, Coolify'ın yönetici kullanıcısıyla)
--
-- Oluşturur:
--   app_migrator  şema sahibi, yalnız migration (LOGIN)
--   app_user      web uygulaması, RLS uygulanır (LOGIN)
--   app_admin     Super Admin paneli (Faz 2'de LOGIN açılacak)
--   app_worker    pg-boss işçisi    (Faz 2'de LOGIN açılacak)
-- Hiçbiri SUPERUSER, CREATEDB, CREATEROLE veya BYPASSRLS değildir.
--
-- Kullanım (parolalar dosyada değil, çalıştırma sırasında verilir):
--   psql "$ADMIN_URL" -v ON_ERROR_STOP=1 \
--     -v db_name=lodging_dev \
--     -v migrator_password="$MIGRATOR_PASSWORD" \
--     -v app_password="$APP_PASSWORD" \
--     -f scripts/db-bootstrap.sql
--
-- Tekrar çalıştırılabilir: var olan rollerin parolası güncellenir, veritabanı yeniden oluşturulmaz.
-- =====================================================================

\set ON_ERROR_STOP on

\if :{?db_name}
\else
  \warn 'HATA: -v db_name=... verilmedi'
  DO $$ BEGIN RAISE EXCEPTION 'db-bootstrap durduruldu'; END $$;
\endif
\if :{?migrator_password}
\else
  \warn 'HATA: -v migrator_password=... verilmedi'
  DO $$ BEGIN RAISE EXCEPTION 'db-bootstrap durduruldu'; END $$;
\endif
\if :{?app_password}
\else
  \warn 'HATA: -v app_password=... verilmedi'
  DO $$ BEGIN RAISE EXCEPTION 'db-bootstrap durduruldu'; END $$;
\endif

SELECT (:'db_name' ~ '_(dev|prod|test)$') AS db_name_ok \gset
\if :db_name_ok
\else
  \warn 'HATA: db_name _dev, _prod veya _test ile bitmeli'
  DO $$ BEGIN RAISE EXCEPTION 'db-bootstrap durduruldu'; END $$;
\endif

SELECT (length(:'migrator_password') >= 24 AND length(:'app_password') >= 24
        AND :'migrator_password' <> :'app_password') AS passwords_ok \gset
\if :passwords_ok
\else
  \warn 'HATA: parolalar en az 24 karakter ve birbirinden farklı olmalı'
  DO $$ BEGIN RAISE EXCEPTION 'db-bootstrap durduruldu'; END $$;
\endif

-- Parolalar psql log'una düşmesin.
\set QUIET on
\set ECHO none

-- ---------- Roller ----------
SELECT format('CREATE ROLE app_migrator LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', :'migrator_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_migrator') \gexec
SELECT format('ALTER ROLE app_migrator LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', :'migrator_password') \gexec

SELECT format('CREATE ROLE app_user LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') \gexec
SELECT format('ALTER ROLE app_user LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', :'app_password') \gexec

SELECT 'CREATE ROLE app_admin NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') \gexec
SELECT 'CREATE ROLE app_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_worker') \gexec

-- Uygulama bağlantılarında güvenli varsayılanlar.
ALTER ROLE app_user SET statement_timeout = '15s';
ALTER ROLE app_user SET idle_in_transaction_session_timeout = '30s';

-- ---------- Veritabanı ----------
SELECT format('CREATE DATABASE %I OWNER app_migrator ENCODING ''UTF8'' TEMPLATE template0', :'db_name')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db_name') \gexec

-- PG15+: veritabanı sahipliğini değiştirmek için mevcut kullanıcının app_migrator üyesi olması gerekebilir.
GRANT app_migrator TO CURRENT_USER;
SELECT format('ALTER DATABASE %I OWNER TO app_migrator', :'db_name') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db_name') \gexec
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO app_user, app_admin, app_worker', :'db_name') \gexec

\connect :"db_name"

ALTER SCHEMA public OWNER TO app_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE app_migrator FROM CURRENT_USER;

\set QUIET off
\echo 'Tamam: roller ve veritabanı hazır. Sıradaki adım: migration (node dist/migrate.js).'
