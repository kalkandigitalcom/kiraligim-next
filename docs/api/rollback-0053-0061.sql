-- Acente API 2. aşama (0053–0061) — GERİ ALMA BETİĞİ
--
-- YALNIZ ACİL DURUMDA ve tercihen ÖNCE yedekten geri dönmeyi değerlendirdikten sonra kullanın.
-- Bu betik veritabanını 0052 sonundaki şemaya döndürür: 2. aşamanın tablo, kolon, tetikleyici,
-- politika ve fonksiyonlarını kaldırır; 0056'nın değiştirdiği iki fonksiyonu 0052'deki
-- hâline geri yazar ve migration kaydından 0053–0061'i siler (yeniden deploy'da tekrar uygulanır).
--
-- KAYBOLAN VERİ: takvim bağlantıları, değişiklik kayıtları, webhook adresleri/sırları ve teslim
-- geçmişi. Rezervasyon, harici takvim, villa, işletme, API hesabı/anahtarı/izin verisi ETKİLENMEZ.
-- Denetim kaydındaki api.calendar_* satırları kalır (denetim kaydı değiştirilemez).
--
-- Sıra: (1) uygulamayı 1. aşama koduna döndürün ve Scheduled Task'ı (api-sync) KAPATIN,
--       (2) yedek alın, (3) bu betiği app_migrator (veya süper kullanıcı) ile tek transaction'da
--       çalıştırın: psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f rollback-0053-0061.sql
--
-- 0062 (erişim kodunun ve işletme tarafında izin kaldırmanın kaldırılması) UYGULANMIŞSA bu betik
-- ÇALIŞMAZ: 0. adım hiçbir değişiklik yapmadan hata verir. Aksi hâlde 2. adım, 0062'nin kaldırdığı
-- app_api_revoke_property_grant'ı yeniden oluştururdu (süper kullanıcıyla PUBLIC'e açık olarak) ve
-- 6. adım 0062'nin migration kaydını da silerdi. Önce 0062 geri alınmalıdır (docs/deployment.md).
--
-- Bu betik test ortamında doğrulanmıştır: 0052'ye kadar migrate edilmiş, veri eklenmiş, 0061'e
-- yükseltilmiş ve kullanılmış veritabanında çalıştırıldıktan sonra şema (tablo, kolon, kısıt,
-- indeks, fonksiyon gövdesi ve yetkileri, tetikleyici, politika) temiz 0052 kurulumuyla aynıdır.

-- 0. Güvenlik kontrolü: yalnız 0061 sonundaki (0062 uygulanmamış) veritabanında devam edilir.
--    Koşullardan biri sağlanmazsa hiçbir değişiklik yapılmadan hata verilir (ON_ERROR_STOP + -1).
DO $$
DECLARE
  v_after_0061 boolean := false;
BEGIN
  -- Migration kaydı (created_at = journal "when", 0062 = 1794608103216). Tablo yoksa dinamik
  -- sorgu çalıştırılmaz (PL/pgSQL statik sorguyu tablo olmadan planlayamaz).
  IF pg_catalog.to_regclass('drizzle.__migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM drizzle.__migrations WHERE created_at >= $1)'
      INTO v_after_0061 USING 1794608103216::bigint;
  END IF;
  IF v_after_0061 THEN
    RAISE EXCEPTION 'rollback_0053_0061_blocked: 0062 veya sonrası uygulanmış; önce 0062 geri alınmalı'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF pg_catalog.to_regprocedure('public.app_api_revoke_property_grant(uuid)') IS NULL THEN
    RAISE EXCEPTION 'rollback_0053_0061_blocked: app_api_revoke_property_grant yok (0062 uygulanmış olabilir)'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'api_clients'
                    AND column_name = 'access_code_hash') THEN
    RAISE EXCEPTION 'rollback_0053_0061_blocked: api_clients.access_code_hash yok (0062 uygulanmış olabilir)'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END
$$;

-- 1. Tetikleyiciler (0054): takvim yazmaları artık "değişti" satırı bırakmaz.
DROP TRIGGER IF EXISTS external_calendar_events_api_capture_del ON public.external_calendar_events;
DROP TRIGGER IF EXISTS external_calendar_events_api_capture_ins ON public.external_calendar_events;
DROP TRIGGER IF EXISTS external_calendar_events_api_capture_upd ON public.external_calendar_events;
DROP TRIGGER IF EXISTS external_calendar_sources_api_capture_del ON public.external_calendar_sources;
DROP TRIGGER IF EXISTS external_calendar_sources_api_capture_upd ON public.external_calendar_sources;
DROP TRIGGER IF EXISTS properties_api_capture_status ON public.properties;
DROP TRIGGER IF EXISTS reservations_api_capture_del ON public.reservations;
DROP TRIGGER IF EXISTS reservations_api_capture_ins ON public.reservations;
DROP TRIGGER IF EXISTS reservations_api_capture_upd ON public.reservations;
DROP TRIGGER IF EXISTS workspaces_api_capture_status ON public.workspaces;

-- 2. 0052'deki izin kaldırma fonksiyonları (0056 bunları bağlantı bitirecek şekilde değiştirmişti).
--    CREATE OR REPLACE mevcut EXECUTE yetkilerini korur.
CREATE OR REPLACE FUNCTION public.app_api_revoke_property_grant(p_grant uuid)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
  v_ws uuid := public.app_current_workspace_id();
  v_user uuid := public.app_current_user_id();
  v_g record;
  v_out text;
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
  IF v_user IS NULL OR coalesce(public.app_current_member_role(), '') NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'api_forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.api_access_grants g
     SET status = 'revoked', revoked_at = pg_catalog.now(), revoked_by_user = v_user
   WHERE g.id = p_grant AND g.workspace_id = v_ws AND g.status = 'active'
  RETURNING g.property_id, g.client_id INTO v_g;
  IF NOT FOUND THEN
    v_out := 'not_found';
  ELSE
    INSERT INTO public.audit_log (id, workspace_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (public.app_uuid_v7(), v_ws, v_user, 'api.access_revoked', 'api_access_grant', p_grant,
            pg_catalog.jsonb_build_object('property', v_g.property_id, 'client', v_g.client_id,
                                          'by', 'owner'));
    v_out := 'revoked';
  END IF;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RETURN v_out;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;

CREATE OR REPLACE FUNCTION public.app_api_admin_revoke_grant(p_admin uuid, p_grant uuid)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
  v_g record;
  v_out text;
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
  PERFORM public.app_api_admin_assert(p_admin);
  UPDATE public.api_access_grants g
     SET status = 'revoked', revoked_at = pg_catalog.now(), revoked_by_admin = p_admin
   WHERE g.id = p_grant AND g.status = 'active'
  RETURNING g.workspace_id, g.property_id, g.client_id INTO v_g;
  IF NOT FOUND THEN
    v_out := 'not_found';
  ELSE
    INSERT INTO public.admin_audit_log (id, admin_id, action, target_type, target_id, metadata)
    VALUES (pg_catalog.gen_random_uuid(), p_admin, 'api.access_revoked', 'api_access_grant', p_grant,
            pg_catalog.jsonb_build_object('client', v_g.client_id, 'property', v_g.property_id));
    INSERT INTO public.audit_log (id, workspace_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (public.app_uuid_v7(), v_g.workspace_id, NULL, 'api.access_revoked', 'api_access_grant',
            p_grant, pg_catalog.jsonb_build_object('property', v_g.property_id,
                                                   'client', v_g.client_id, 'by', 'admin'));
    v_out := 'revoked';
  END IF;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RETURN v_out;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;

-- 2b. Yetki denetimi: CREATE OR REPLACE mevcut yetkileri korur; iki fonksiyon da PUBLIC'e açık
--     olamaz ve Super Admin fonksiyonu app_user tarafından çalıştırılamaz (0052 yetki modeli).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
              WHERE p.oid IN ('public.app_api_revoke_property_grant(uuid)'::regprocedure,
                              'public.app_api_admin_revoke_grant(uuid, uuid)'::regprocedure)
                AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                 WHERE p.oid IN ('public.app_api_revoke_property_grant(uuid)'::regprocedure,
                                 'public.app_api_admin_revoke_grant(uuid, uuid)'::regprocedure)
                   AND p.proacl IS NULL)
     OR pg_catalog.has_function_privilege('app_user',
          'public.app_api_admin_revoke_grant(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'rollback_0053_0061_blocked: izin kaldırma fonksiyonlarının yetkileri beklenenden geniş'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END
$$;

-- 3. 2. aşama fonksiyonları (0054, 0056, 0058, 0059, 0061).
DROP FUNCTION IF EXISTS public.app_api_account_changes(text, text, integer);
DROP FUNCTION IF EXISTS public.app_api_account_cursor_issue(text, uuid, bigint);
DROP FUNCTION IF EXISTS public.app_api_account_cursor_parse(text, uuid, text);
DROP FUNCTION IF EXISTS public.app_api_admin_connections(uuid, uuid);
DROP FUNCTION IF EXISTS public.app_api_busy_json(uuid, date, date);
DROP FUNCTION IF EXISTS public.app_api_cancel_deliveries(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.app_api_capture_external_event();
DROP FUNCTION IF EXISTS public.app_api_capture_external_source();
DROP FUNCTION IF EXISTS public.app_api_capture_insert(uuid, date, date, text);
DROP FUNCTION IF EXISTS public.app_api_capture_property_status();
DROP FUNCTION IF EXISTS public.app_api_capture_reservation();
DROP FUNCTION IF EXISTS public.app_api_capture_workspace_status();
DROP FUNCTION IF EXISTS public.app_api_changes(text, uuid, text, integer);
DROP FUNCTION IF EXISTS public.app_api_claim_deliveries(integer, integer);
DROP FUNCTION IF EXISTS public.app_api_connect(text, uuid, text);
DROP FUNCTION IF EXISTS public.app_api_connection(text, uuid);
DROP FUNCTION IF EXISTS public.app_api_connection_rows(uuid);
DROP FUNCTION IF EXISTS public.app_api_connections(text, uuid, integer, boolean);
DROP FUNCTION IF EXISTS public.app_api_cursor_issue(text, uuid, bigint);
DROP FUNCTION IF EXISTS public.app_api_cursor_mac(text, text);
DROP FUNCTION IF EXISTS public.app_api_cursor_parse(text, uuid, text);
DROP FUNCTION IF EXISTS public.app_api_disconnect(text, uuid);
DROP FUNCTION IF EXISTS public.app_api_end_grant_connections(uuid, text, uuid, uuid);
DROP FUNCTION IF EXISTS public.app_api_finish_delivery(uuid, uuid, boolean, integer, text);
DROP FUNCTION IF EXISTS public.app_api_hmac_sha256(bytea, bytea);
DROP FUNCTION IF EXISTS public.app_api_process_changes(integer);
DROP FUNCTION IF EXISTS public.app_api_property_connections(uuid);
DROP FUNCTION IF EXISTS public.app_api_prune_changes();
DROP FUNCTION IF EXISTS public.app_api_prune_deliveries();
DROP FUNCTION IF EXISTS public.app_api_snapshot(text, uuid);
DROP FUNCTION IF EXISTS public.app_api_webhook_delete(text);
DROP FUNCTION IF EXISTS public.app_api_webhook_get(text);
DROP FUNCTION IF EXISTS public.app_api_webhook_put(text, text, text);
DROP FUNCTION IF EXISTS public.app_api_webhook_rotate(text, text);

-- 4. Tablolar (politikalar, indeksler ve kısıtlar tabloyla birlikte gider). Bağımlılık sırası:
--    teslimler → webhook adresleri → değişiklikler → senkron durumu → bağlantılar → "değişti".
DROP TABLE IF EXISTS public.api_webhook_deliveries;
DROP TABLE IF EXISTS public.api_webhook_endpoints;
DROP TABLE IF EXISTS public.api_calendar_changes;
DROP TABLE IF EXISTS public.api_sync_state;
DROP TABLE IF EXISTS public.api_calendar_connections;
DROP TABLE IF EXISTS public.api_calendar_dirty;

-- 5. Mevcut tabloya eklenen kolon (0060).
ALTER TABLE public.api_clients DROP COLUMN IF EXISTS cursor_key;

-- 6. Migration kaydı: 0053 ve sonrası (created_at = journal "when", 0053 = 1794500965897).
DELETE FROM drizzle.__migrations WHERE created_at >= 1794500965897;
