-- Opsiyon 0071 (Aşama 3c: Super Admin opsiyon paneli fonksiyonları) — GERİ ALMA BETİĞİ
--
-- YALNIZ GEREKİRSE. 0066–0070'i de geri alacaksanız ÖNCE bu betiği, sonra docs/rollback-0070.sql
-- ve docs/rollback-0066-0069.sql'i çalıştırın. app_migrator (veya süper kullanıcı) ile TEK
-- transaction'da:
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f rollback-0071.sql
--
-- 0071 yalnız fonksiyon eklediği için geri alma yalnız bu fonksiyonları siler; hiçbir tabloya ve
-- veriye dokunmaz. Uygulama kodu (Super Admin opsiyon sayfaları, option-maintenance'ın onaylı işlem
-- adımı) bu fonksiyonları çağırır: geri almadan önce 3c kodunu da geri alın.

-- 0. Güvenlik kontrolü: 0071 sonrası migration uygulanmışsa önce onlar geri alınmalı.
DO $$
DECLARE
  v_later boolean := false;
BEGIN
  IF pg_catalog.to_regclass('drizzle.__migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM drizzle.__migrations WHERE created_at > $1)'
      INTO v_later USING 1794772800000::bigint;
  END IF;
  IF v_later THEN
    RAISE EXCEPTION 'rollback_0071_blocked: 0071 sonrası migration uygulanmış'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END
$$;

-- 1. 0071 fonksiyonları.
DROP FUNCTION IF EXISTS public.app_option_apply_approved_operation(uuid, uuid);
DROP FUNCTION IF EXISTS public.app_option_claim_approved_operations(integer);
DROP FUNCTION IF EXISTS public.app_option_admin_ack_alert(uuid, uuid);
DROP FUNCTION IF EXISTS public.app_option_admin_alert_list(uuid, uuid, boolean, integer);
DROP FUNCTION IF EXISTS public.app_option_admin_range_context(uuid, uuid);
DROP FUNCTION IF EXISTS public.app_option_admin_option_operations(uuid, uuid);
DROP FUNCTION IF EXISTS public.app_option_admin_operation(uuid, uuid);
DROP FUNCTION IF EXISTS public.app_option_admin_option(uuid, uuid);
DROP FUNCTION IF EXISTS public.app_option_admin_counts(uuid);

-- 2. Migration kaydı: yeniden deploy'da tekrar uygulanır.
DO $$
BEGIN
  IF pg_catalog.to_regclass('drizzle.__migrations') IS NOT NULL THEN
    EXECUTE 'DELETE FROM drizzle.__migrations WHERE created_at = $1' USING 1794772800000::bigint;
  END IF;
END
$$;
