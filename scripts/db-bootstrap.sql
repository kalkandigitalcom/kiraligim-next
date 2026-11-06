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
-- Kullanım: parolalar KOMUT SATIRINDA DEĞİL, ortam değişkeninde verilir; böylece shell geçmişine,
-- `ps` çıktısına ve psql log'una düşmez. Parolalar yalnız [A-Za-z0-9] olmalı (URL'de kaçış gerektirmesin):
--   openssl rand -hex 24
--
--   export KG_MIGRATOR_PASSWORD=...   KG_APP_PASSWORD=...     (read -rs ile girilmesi önerilir)
--   psql "$ADMIN_URL" -X -v ON_ERROR_STOP=1 -v db_name=lodging_dev -f scripts/db-bootstrap.sql
--
-- Docker içindeki psql ile (değerler `-e AD` biçiminde, değer yazılmadan aktarılır):
--   docker exec -i -e KG_MIGRATOR_PASSWORD -e KG_APP_PASSWORD <konteyner> \
--     sh -c 'psql -U "$POSTGRES_USER" -d postgres -X -v ON_ERROR_STOP=1 -v db_name=kiraligim_prod -f -' \
--     < scripts/db-bootstrap.sql
--
-- Tekrar çalıştırılabilir: veritabanı yeniden oluşturulmaz, veri silinmez. Var olan rollerin parolası
-- verilen değerlerle güncellenir (o zaman Coolify'daki bağlantı adresleri de güncellenmelidir).
-- =====================================================================

\set ON_ERROR_STOP on
\set QUIET on

-- Parola içeren ifadeler sunucu log'una yazılmasın (bu oturum için; süper kullanıcı gerekir).
SET log_statement = 'none';
SET log_min_duration_statement = -1;
SET log_min_error_statement = 'panic';

\getenv migrator_password KG_MIGRATOR_PASSWORD
\getenv app_password KG_APP_PASSWORD

\if :{?db_name}
\else
  \warn 'HATA: -v db_name=... verilmedi'
  DO $$ BEGIN RAISE EXCEPTION 'db-bootstrap durduruldu'; END $$;
\endif
\if :{?migrator_password}
\else
  \warn 'HATA: KG_MIGRATOR_PASSWORD ortam değişkeni tanımlı değil'
  DO $$ BEGIN RAISE EXCEPTION 'db-bootstrap durduruldu'; END $$;
\endif
\if :{?app_password}
\else
  \warn 'HATA: KG_APP_PASSWORD ortam değişkeni tanımlı değil'
  DO $$ BEGIN RAISE EXCEPTION 'db-bootstrap durduruldu'; END $$;
\endif

SELECT (:'db_name' ~ '_(dev|prod|test)$') AS db_name_ok \gset
\if :db_name_ok
\else
  \warn 'HATA: db_name _dev, _prod veya _test ile bitmeli'
  DO $$ BEGIN RAISE EXCEPTION 'db-bootstrap durduruldu'; END $$;
\endif

SELECT (length(:'migrator_password') >= 32 AND length(:'app_password') >= 32
        AND :'migrator_password' <> :'app_password'
        AND :'migrator_password' ~ '^[A-Za-z0-9]+$' AND :'app_password' ~ '^[A-Za-z0-9]+$') AS passwords_ok \gset
\if :passwords_ok
\else
  \warn 'HATA: parolalar en az 32 karakter, yalnız harf/rakam ve birbirinden farklı olmalı (openssl rand -hex 24)'
  DO $$ BEGIN RAISE EXCEPTION 'db-bootstrap durduruldu'; END $$;
\endif

-- Parolalar ekrana yazılmasın.
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
\echo 'Tamam: roller ve veritabanı hazır. Sıradaki adım: migration (RUN_MIGRATIONS_ON_START=true ile deploy).'
