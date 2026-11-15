-- Opsiyon Aşama 3a (0066–0069: otomasyon ayarları, işlemler, uyarılar, imleç) — GERİ ALMA BETİĞİ
--
-- YALNIZ GEREKİRSE. Önce option-maintenance görevinin devre dışı olduğundan emin olun ve
-- uygulamayı 0065 koduna (88ae8c1) döndürün; sonra yedek alın ve bu betiği app_migrator (veya
-- süper kullanıcı) ile TEK transaction'da çalıştırın:
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f rollback-0066-0069.sql
--
-- 0066–0069 mevcut çalışan sistemin hiçbir nesnesini değiştirmez; geri alma yalnız Opsiyon
-- Sistemi nesnelerini kaldırır ve A2 opsiyon nesnelerini (reservation_options kısıtı ve sütunları,
-- reservation_option_events.actor_admin_id, üç A2 tetikleyici fonksiyonu) 0065'teki hâline
-- döndürür. Rezervasyon, blok, harici takvim, iCal, API, webhook, WhatsApp ve tepki verisi
-- ETKİLENMEZ. Mevcut tablolara eklenen üç politika (admin_users_option_fn,
-- admin_audit_log_option_fn, audit_log_option_fn) kaldırılır.
--
-- KAYBOLAN VERİ: otomasyon ayarları, çakışma uyarıları, mesaj imleci. Opsiyon (reservation_options)
-- veya işlem (option_operations) kaydı VARSA betik hiçbir şey yapmadan durur: kayıtlar yeni iptal
-- nedeni adlarını taşıyabilir ve 0065 kısıtına uymaz; elle incelenmelidir.

-- 0. Güvenlik kontrolü (koşul sağlanmazsa hiçbir değişiklik yapılmadan hata).
DO $$
DECLARE
  v_later boolean := false;
  v_rows bigint := 0;
BEGIN
  IF pg_catalog.to_regclass('drizzle.__migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM drizzle.__migrations WHERE created_at > $1)'
      INTO v_later USING 1794768752533::bigint;
  END IF;
  IF v_later THEN
    RAISE EXCEPTION 'rollback_0066_0069_blocked: 0069 sonrası migration uygulanmış'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- FORCE RLS: app_migrator tabloları yalnız bayraklarla görür; bayraksız sayım 0 döner.
  PERFORM pg_catalog.set_config('app.wa_calendar', 'on', true);
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  IF pg_catalog.to_regclass('public.reservation_options') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.reservation_options' INTO v_rows;
  END IF;
  IF v_rows = 0 AND pg_catalog.to_regclass('public.option_operations') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.option_operations' INTO v_rows;
  END IF;
  IF v_rows > 0 THEN
    RAISE EXCEPTION 'rollback_0066_0069_blocked: opsiyon veya işlem kaydı var (% kayıt)', v_rows
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END
$$;

-- 1. 0069: işlem fonksiyonları, tetikleyici, tablolar (0068).
DROP FUNCTION IF EXISTS public.app_option_admin_cancel(uuid, uuid, integer, text);
DROP FUNCTION IF EXISTS public.app_option_admin_decide(uuid, uuid, integer, boolean, text, date, date,
  integer, text, integer, integer);
DROP FUNCTION IF EXISTS public.app_option_admin_alerts(uuid, integer);
DROP FUNCTION IF EXISTS public.app_option_admin_option_events(uuid, uuid);
DROP FUNCTION IF EXISTS public.app_option_admin_operations(uuid, text, integer);
DROP FUNCTION IF EXISTS public.app_option_admin_options(uuid, text, integer);
DROP FUNCTION IF EXISTS public.app_option_finish_operation(uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.app_option_apply_operation(uuid, uuid);
DROP FUNCTION IF EXISTS public.app_option_claim_operations(integer);
DROP FUNCTION IF EXISTS public.app_option_scan_conflicts(integer);
DROP FUNCTION IF EXISTS public.app_option_expire_due(integer);
DROP FUNCTION IF EXISTS public.app_wa_option_apply(uuid, jsonb);
DROP FUNCTION IF EXISTS public.app_option_claim_messages(integer);
DROP FUNCTION IF EXISTS public.app_option_conflict_count(uuid, uuid, date, date);
DROP FUNCTION IF EXISTS public.app_option_fingerprint(uuid, uuid, date, date, uuid);
DROP TRIGGER IF EXISTS option_operations_guard ON public.option_operations;
DROP FUNCTION IF EXISTS public.app_option_operations_guard();
DROP POLICY IF EXISTS reservation_options_option_fn ON public.reservation_options;
DROP POLICY IF EXISTS reservation_option_events_option_read ON public.reservation_option_events;
DROP TABLE IF EXISTS public.option_message_scans;
DROP TABLE IF EXISTS public.option_conflict_alerts;
DROP TABLE IF EXISTS public.option_operations;

-- 2. 0067: ayar fonksiyonları ve mevcut tablolara eklenen politikalar.
DROP FUNCTION IF EXISTS public.app_option_admin_set_group(uuid, uuid, boolean);
DROP FUNCTION IF EXISTS public.app_option_admin_set_workspace(uuid, uuid, boolean, integer, integer[]);
DROP FUNCTION IF EXISTS public.app_option_admin_set_global(uuid, boolean);
DROP FUNCTION IF EXISTS public.app_option_admin_settings(uuid);
DROP FUNCTION IF EXISTS public.app_option_admin_check(uuid);
DROP FUNCTION IF EXISTS public.app_option_automation_enabled(uuid);
DROP FUNCTION IF EXISTS public.app_option_automation_since(uuid);
DROP POLICY IF EXISTS admin_users_option_fn ON public.admin_users;
DROP POLICY IF EXISTS admin_audit_log_option_fn ON public.admin_audit_log;
DROP POLICY IF EXISTS audit_log_option_fn ON public.audit_log;

-- 3. A2 tetikleyici fonksiyonları 0065'teki hâline (gövdeler 0065'ten birebir).
CREATE OR REPLACE FUNCTION public.app_reservation_options_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'option_delete_forbidden'
      USING ERRCODE = 'check_violation', DETAIL = 'Opsiyon silinemez; iptal edilir (geçmiş korunur).';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION 'option_insert_not_open'
        USING ERRCODE = 'check_violation', DETAIL = 'Opsiyon yalnız açık durumda oluşturulur.';
    END IF;
    NEW.version := 1;
    NEW.created_at := pg_catalog.now();
    NEW.updated_at := NEW.created_at;
    NEW.ended_at := NULL;
    RETURN NEW;
  END IF;

  -- Kimlik alanları hiçbir durumda değişmez.
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.property_id IS DISTINCT FROM OLD.property_id OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.group_id IS DISTINCT FROM OLD.group_id
     OR NEW.origin_wa_message_id IS DISTINCT FROM OLD.origin_wa_message_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (NEW.origin_message_id IS DISTINCT FROM OLD.origin_message_id AND NEW.origin_message_id IS NOT NULL)
     OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL) THEN
    RAISE EXCEPTION 'option_immutable_field'
      USING ERRCODE = 'check_violation', DETAIL = 'Opsiyonun kimlik alanları değiştirilemez.';
  END IF;

  -- Yabancı anahtar SET NULL (mesaj temizliği, kullanıcı silme): yalnız referans alanları NULL'a
  -- iner; durum ve içerik aynı kalır. Son durumdaki opsiyonda da izinlidir; sürüm değişmez.
  IF NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.check_in IS NOT DISTINCT FROM OLD.check_in AND NEW.check_out IS NOT DISTINCT FROM OLD.check_out
     AND NEW.expires_at IS NOT DISTINCT FROM OLD.expires_at
     AND NEW.expiry_source IS NOT DISTINCT FROM OLD.expiry_source
     AND NEW.guest_name IS NOT DISTINCT FROM OLD.guest_name AND NEW.note IS NOT DISTINCT FROM OLD.note
     AND NEW.converted_reservation_id IS NOT DISTINCT FROM OLD.converted_reservation_id
     AND NEW.ended_at IS NOT DISTINCT FROM OLD.ended_at
     AND NEW.end_reason IS NOT DISTINCT FROM OLD.end_reason
     AND NEW.version IS NOT DISTINCT FROM OLD.version
     AND (NEW.origin_message_id IS NOT DISTINCT FROM OLD.origin_message_id OR NEW.origin_message_id IS NULL)
     AND (NEW.ended_by_message_id IS NOT DISTINCT FROM OLD.ended_by_message_id OR NEW.ended_by_message_id IS NULL)
     AND (NEW.ended_by_user_id IS NOT DISTINCT FROM OLD.ended_by_user_id OR NEW.ended_by_user_id IS NULL)
     AND (NEW.updated_by IS NOT DISTINCT FROM OLD.updated_by OR NEW.updated_by IS NULL)
     AND (NEW.created_by IS NOT DISTINCT FROM OLD.created_by OR NEW.created_by IS NULL)
     AND (NEW.origin_message_id IS DISTINCT FROM OLD.origin_message_id
          OR NEW.ended_by_message_id IS DISTINCT FROM OLD.ended_by_message_id
          OR NEW.ended_by_user_id IS DISTINCT FROM OLD.ended_by_user_id
          OR NEW.updated_by IS DISTINCT FROM OLD.updated_by
          OR NEW.created_by IS DISTINCT FROM OLD.created_by) THEN
    RETURN NEW;
  END IF;

  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'option_final_immutable'
      USING ERRCODE = 'check_violation', DETAIL = 'Sonuçlanmış opsiyon değiştirilemez.';
  END IF;
  IF NEW.check_in IS DISTINCT FROM OLD.check_in OR NEW.check_out IS DISTINCT FROM OLD.check_out THEN
    RAISE EXCEPTION 'option_dates_immutable'
      USING ERRCODE = 'check_violation', DETAIL = 'Opsiyon tarihleri değişmez; iptal edilip yenisi açılır.';
  END IF;
  IF NEW.version IS DISTINCT FROM OLD.version THEN
    RAISE EXCEPTION 'option_version_conflict'
      USING ERRCODE = 'serialization_failure', DETAIL = 'Opsiyon başka bir işlemle değişti.';
  END IF;
  IF NEW.status <> 'open' THEN
    NEW.ended_at := pg_catalog.now();
  ELSE
    NEW.ended_at := NULL;
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END
$$;;

CREATE OR REPLACE FUNCTION public.app_reservation_options_history() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.option_fn', true);
  v_event text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.version = OLD.version THEN
    RETURN NULL; -- yalnız referans alanı NULL'a indi (yabancı anahtar eylemi): olay değil
  END IF;
  v_event := CASE
    WHEN TG_OP = 'INSERT' THEN 'created'
    WHEN NEW.status <> OLD.status THEN NEW.status
    ELSE 'updated'
  END;
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  INSERT INTO public.reservation_option_events
    (id, option_id, workspace_id, event, from_status, to_status, reason, actor_user_id, message_id,
     converted_reservation_id, version, created_at)
  VALUES
    (pg_catalog.gen_random_uuid(), NEW.id, NEW.workspace_id, v_event,
     CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status, NEW.end_reason,
     CASE WHEN TG_OP = 'INSERT' THEN NEW.created_by
          ELSE coalesce(NEW.ended_by_user_id, NEW.updated_by) END,
     CASE WHEN TG_OP = 'INSERT' THEN NEW.origin_message_id ELSE NEW.ended_by_message_id END,
     NEW.converted_reservation_id, NEW.version, pg_catalog.now());
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev, ''), true);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;;

CREATE OR REPLACE FUNCTION public.app_reservation_option_events_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.id = OLD.id AND NEW.option_id = OLD.option_id AND NEW.workspace_id = OLD.workspace_id
     AND NEW.event = OLD.event AND NEW.from_status IS NOT DISTINCT FROM OLD.from_status
     AND NEW.to_status = OLD.to_status AND NEW.reason IS NOT DISTINCT FROM OLD.reason
     AND NEW.converted_reservation_id IS NOT DISTINCT FROM OLD.converted_reservation_id
     AND NEW.version = OLD.version AND NEW.created_at = OLD.created_at
     AND (NEW.actor_user_id IS NOT DISTINCT FROM OLD.actor_user_id OR NEW.actor_user_id IS NULL)
     AND (NEW.message_id IS NOT DISTINCT FROM OLD.message_id OR NEW.message_id IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'option_history_immutable'
    USING ERRCODE = 'check_violation', DETAIL = 'Opsiyon geçmişi değiştirilemez.';
END
$$;;

-- 4. 0066: ayar tabloları, yeni sütunlar ve A2 kısıtı (0065 adlarıyla).
DROP TABLE IF EXISTS public.wa_group_option_settings;
DROP TABLE IF EXISTS public.workspace_option_settings;
DROP TABLE IF EXISTS public.option_automation_global;
ALTER TABLE public.reservation_option_events DROP COLUMN IF EXISTS actor_admin_id;
ALTER TABLE public.reservation_options DROP CONSTRAINT IF EXISTS reservation_options_guests;
ALTER TABLE public.reservation_options DROP COLUMN IF EXISTS adults;
ALTER TABLE public.reservation_options DROP COLUMN IF EXISTS children;
ALTER TABLE public.reservation_options DROP CONSTRAINT IF EXISTS reservation_options_end_state;
ALTER TABLE public.reservation_options ADD CONSTRAINT reservation_options_end_state CHECK ((status = 'open' AND ended_at IS NULL AND end_reason IS NULL
            AND converted_reservation_id IS NULL AND ended_by_message_id IS NULL
            AND ended_by_user_id IS NULL)
        OR (status = 'converted' AND ended_at IS NOT NULL AND converted_reservation_id IS NOT NULL
            AND end_reason IN ('payment_received', 'confirmed_in_panel'))
        OR (status = 'cancelled' AND ended_at IS NOT NULL AND converted_reservation_id IS NULL
            AND end_reason IN ('customer_withdrew', 'cancelled_by_owner', 'cancelled_in_panel'))
        OR (status = 'expired' AND ended_at IS NOT NULL AND converted_reservation_id IS NULL
            AND expires_at IS NOT NULL AND end_reason IN ('expired')));

-- 5. Migration kayıtları: yeniden deploy'da tekrar uygulanır.
DO $$
BEGIN
  IF pg_catalog.to_regclass('drizzle.__migrations') IS NOT NULL THEN
    EXECUTE 'DELETE FROM drizzle.__migrations WHERE created_at IN ($1, $2, $3, $4)'
      USING 1794768480214::bigint, 1794768486612::bigint, 1794768672933::bigint, 1794768752533::bigint;
  END IF;
END
$$;
