-- Opsiyon 0073 (Aşama 3e: kesinleştirme fonksiyonları) — GERİ ALMA BETİĞİ
--
-- YALNIZ GEREKİRSE. Daha eski migration'ları da geri alacaksanız ÖNCE bu betiği, sonra
-- docs/rollback-0072.sql, rollback-0071.sql, rollback-0070.sql ve rollback-0066-0069.sql'i çalıştırın.
-- app_migrator (veya süper kullanıcı) ile TEK transaction'da:
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f rollback-0073.sql
--
-- 0073 yalnız fonksiyon eklediği için geri alma yalnız onları siler; hiçbir tabloya ve veriye
-- dokunmaz. option-maintenance'ın kesinleştirme adımı bu fonksiyonları çağırır: geri almadan önce 3e
-- kodunu da geri alın (ya da görevi çalıştırmayın).

-- 0. Güvenlik kontrolü: 0073 sonrası migration uygulanmışsa önce onlar geri alınmalı.
DO $$
DECLARE
  v_later boolean := false;
BEGIN
  IF pg_catalog.to_regclass('drizzle.__migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM drizzle.__migrations WHERE created_at > $1)'
      INTO v_later USING 1794880800000::bigint;
  END IF;
  IF v_later THEN
    RAISE EXCEPTION 'rollback_0073_blocked: 0073 sonrası migration uygulanmış'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END
$$;

-- 1. 0073 fonksiyonları.
DROP FUNCTION IF EXISTS public.app_option_convert_finish(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.app_option_convert_begin(uuid, uuid);
DROP FUNCTION IF EXISTS public.app_option_convert_owner(uuid, uuid);
DROP FUNCTION IF EXISTS public.app_option_claim_approved_conversions(integer);

-- 2. Migration kaydı: yeniden deploy'da tekrar uygulanır.
DO $$
BEGIN
  IF pg_catalog.to_regclass('drizzle.__migrations') IS NOT NULL THEN
    EXECUTE 'DELETE FROM drizzle.__migrations WHERE created_at = $1' USING 1794880800000::bigint;
  END IF;
END
$$;
