-- Opsiyon 0072 (Aşama 3d: mesaj öğelerini okuma fonksiyonu) — GERİ ALMA BETİĞİ
--
-- YALNIZ GEREKİRSE. Daha eski migration'ları da geri alacaksanız ÖNCE bu betiği, sonra
-- docs/rollback-0071.sql, docs/rollback-0070.sql ve docs/rollback-0066-0069.sql'i çalıştırın.
-- app_migrator (veya süper kullanıcı) ile TEK transaction'da:
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f rollback-0072.sql
--
-- 0072 yalnız bir fonksiyon eklediği için geri alma yalnız onu siler; hiçbir tabloya ve veriye
-- dokunmaz. option-maintenance'ın mesaj işleyicisi bu fonksiyonu çağırır: geri almadan önce 3d
-- kodunu da geri alın (ya da görevi çalıştırmayın).

-- 0. Güvenlik kontrolü: 0072 sonrası migration uygulanmışsa önce onlar geri alınmalı.
DO $$
DECLARE
  v_later boolean := false;
BEGIN
  IF pg_catalog.to_regclass('drizzle.__migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM drizzle.__migrations WHERE created_at > $1)'
      INTO v_later USING 1794826800000::bigint;
  END IF;
  IF v_later THEN
    RAISE EXCEPTION 'rollback_0072_blocked: 0072 sonrası migration uygulanmış'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END
$$;

-- 1. 0072 fonksiyonu.
DROP FUNCTION IF EXISTS public.app_option_message_items(uuid);

-- 2. Migration kaydı: yeniden deploy'da tekrar uygulanır.
DO $$
BEGIN
  IF pg_catalog.to_regclass('drizzle.__migrations') IS NOT NULL THEN
    EXECUTE 'DELETE FROM drizzle.__migrations WHERE created_at = $1' USING 1794826800000::bigint;
  END IF;
END
$$;
