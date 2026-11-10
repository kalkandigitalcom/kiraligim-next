-- =====================================================================
-- WhatsApp ağ geçidi veritabanı rolü: app_wa_gateway (her ortamda BİR KEZ, yönetici kullanıcıyla)
--
-- Ağ geçidi web uygulamasının app_user rolünü KULLANMAZ. Bu rol yalnız şunları yapabilir:
--   * veritabanına bağlanmak (CONNECT; TEMPORARY yok),
--   * public şemasındaki ağ geçidi fonksiyonlarını çalıştırmak (hepsi SECURITY DEFINER, 0031–0034):
--       app_wa_heartbeat (3 ve 4 parametreli), app_wa_sync_group (7 ve 9 parametreli),
--       app_wa_ingest_message, app_wa_purge_messages (yalnız 90–365 gün), app_wa_verify_phone,
--       app_wa_claim_reactions ve app_wa_finish_reaction (0040: mesaj tepkisi gönderimi).
--   Eski kodlu bağlama (app_wa_redeem_link_code) A1.1'de kullanılmaz; bu betik yetkisini KALDIRIR.
-- Hiçbir tabloyu okuyamaz/yazamaz; app.user_id / app.workspace_id ayarlayarak işletme verisi
-- göremez (tablo yetkisi yok); panel fonksiyonlarını (app_wa_unlink_group) çalıştıramaz.
-- SUPERUSER, CREATEDB, CREATEROLE, BYPASSRLS değildir; INHERIT kapalı; en fazla 5 bağlantı.
--
-- Ön koşul: 0030–0040 migration'ları bu veritabanında uygulanmış olmalı (fonksiyonlar yoksa durur).
--
-- Kullanım (parola KOMUT SATIRINDA DEĞİL, ortam değişkeninde; yalnız [A-Za-z0-9], en az 32 karakter):
--   openssl rand -hex 24
--   read -rs -p "app_wa_gateway parolası: " KG_WA_GATEWAY_PASSWORD; echo; export KG_WA_GATEWAY_PASSWORD
--   docker exec -i -e KG_WA_GATEWAY_PASSWORD <postgres-konteyneri> \
--     sh -c 'psql -U "$POSTGRES_USER" -d postgres -X -v ON_ERROR_STOP=1 -v db_name=kiraligim_prod -f -' \
--     < scripts/wa-gateway-role.sql
--   unset KG_WA_GATEWAY_PASSWORD
--
-- Tekrar çalıştırılabilir: veri silmez; yalnız rolün parolasını ve yetkilerini yeniden yazar.
-- Mevcut tablolara, rollere (app_user, app_migrator) ve verilere dokunmaz.
--
-- Geri alma (ağ geçidi durdurulduktan sonra):
--   REVOKE EXECUTE ON FUNCTION <yukarıdaki fonksiyonlar> FROM app_wa_gateway;
--   REVOKE USAGE ON SCHEMA public FROM app_wa_gateway;
--   REVOKE CONNECT ON DATABASE <db> FROM app_wa_gateway; DROP ROLE app_wa_gateway;
-- =====================================================================

\set ON_ERROR_STOP on
\set QUIET on

-- Parola içeren ifadeler sunucu log'una yazılmasın (bu oturum için; süper kullanıcı gerekir).
SET log_statement = 'none';
SET log_min_duration_statement = -1;
SET log_min_error_statement = 'panic';

\getenv gateway_password KG_WA_GATEWAY_PASSWORD

\if :{?db_name}
\else
  \warn 'HATA: -v db_name=... verilmedi'
  DO $$ BEGIN RAISE EXCEPTION 'wa-gateway-role durduruldu'; END $$;
\endif
\if :{?gateway_password}
\else
  \warn 'HATA: KG_WA_GATEWAY_PASSWORD ortam değişkeni tanımlı değil'
  DO $$ BEGIN RAISE EXCEPTION 'wa-gateway-role durduruldu'; END $$;
\endif

SELECT (:'db_name' ~ '_(dev|prod|test)$') AS db_name_ok \gset
\if :db_name_ok
\else
  \warn 'HATA: db_name _dev, _prod veya _test ile bitmeli'
  DO $$ BEGIN RAISE EXCEPTION 'wa-gateway-role durduruldu'; END $$;
\endif

SELECT (length(:'gateway_password') >= 32 AND :'gateway_password' ~ '^[A-Za-z0-9]+$') AS password_ok \gset
\if :password_ok
\else
  \warn 'HATA: parola en az 32 karakter ve yalnız harf/rakam olmalı (openssl rand -hex 24)'
  DO $$ BEGIN RAISE EXCEPTION 'wa-gateway-role durduruldu'; END $$;
\endif

\connect :"db_name"
SET log_statement = 'none';
SET log_min_duration_statement = -1;
SET log_min_error_statement = 'panic';

-- Ön koşul: A1 fonksiyonları var mı? (migration 0030–0034)
SELECT count(*) = 7 AS functions_ok
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
   AND p.oid::regprocedure::text IN (
     'app_wa_heartbeat(text,text,text)',
     'app_wa_heartbeat(text,text,text,text)',
     'app_wa_sync_group(uuid,text,text,integer,boolean,boolean,boolean)',
     'app_wa_sync_group(uuid,text,text,integer,boolean,boolean,boolean,text,text)',
     'app_wa_ingest_message(uuid,text,text,text,text,text,text,timestamp with time zone,text)',
     'app_wa_purge_messages(integer)',
     'app_wa_verify_phone(text,text)') \gset
\if :functions_ok
\else
  \warn 'HATA: app_wa_* fonksiyonları bulunamadı; önce 0030–0034 migration''ları uygulanmalı'
  DO $$ BEGIN RAISE EXCEPTION 'wa-gateway-role durduruldu'; END $$;
\endif

-- ---------- Rol ----------
SELECT format('CREATE ROLE app_wa_gateway LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT NOREPLICATION CONNECTION LIMIT 5', :'gateway_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_wa_gateway') \gexec
SELECT format('ALTER ROLE app_wa_gateway LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT NOREPLICATION CONNECTION LIMIT 5', :'gateway_password') \gexec

ALTER ROLE app_wa_gateway SET statement_timeout = '15s';
ALTER ROLE app_wa_gateway SET idle_in_transaction_session_timeout = '30s';

-- ---------- Yetkiler (yalnız bu veritabanında) ----------
SELECT format('GRANT CONNECT ON DATABASE %I TO app_wa_gateway', :'db_name') \gexec
SELECT format('REVOKE TEMPORARY ON DATABASE %I FROM app_wa_gateway', :'db_name') \gexec
GRANT USAGE ON SCHEMA public TO app_wa_gateway;
-- Savunma: tablo ve dizi yetkisi olmadığından emin ol (varsa kaldırır).
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM app_wa_gateway;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM app_wa_gateway;
GRANT EXECUTE ON FUNCTION
  public.app_wa_heartbeat(text, text, text),
  public.app_wa_heartbeat(text, text, text, text),
  public.app_wa_sync_group(uuid, text, text, integer, boolean, boolean, boolean),
  public.app_wa_sync_group(uuid, text, text, integer, boolean, boolean, boolean, text, text),
  public.app_wa_ingest_message(uuid, text, text, text, text, text, text, timestamptz, text),
  public.app_wa_purge_messages(integer),
  public.app_wa_verify_phone(text, text),
  public.app_wa_claim_reactions(uuid, integer),
  public.app_wa_finish_reaction(uuid, uuid, boolean, text)
  TO app_wa_gateway;
-- Eski kodlu bağlama A1.1'de kullanılmaz (en az yetki).
REVOKE EXECUTE ON FUNCTION public.app_wa_redeem_link_code(uuid, text, text, text) FROM app_wa_gateway;

\set QUIET off
\echo 'Tamam: app_wa_gateway rolü hazır (yalnız app_wa_* ağ geçidi fonksiyonları).'
