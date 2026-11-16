-- Opsiyon 0074 (tek ve ortak opsiyon sistemi) — GERİ ALMA BETİĞİ
--
-- YALNIZ GEREKİRSE. Daha eski migration'ları da geri alacaksanız ÖNCE bu betiği, sonra
-- docs/rollback-0073.sql ve öncekileri çalıştırın.
-- app_migrator (veya süper kullanıcı) ile TEK transaction'da:
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f rollback-0074.sql
--
-- 0074 yalnız app_option_automation_since(uuid) gövdesini değiştirdiği için geri alma yalnız 0067
-- gövdesini birebir geri yükler: üç anahtar kuralı (global + işletme + grup) yeniden geçerli olur.
-- Hiçbir tabloya ve veriye dokunmaz. Geri almadan sonra işletme ve grup anahtarı açık olmayan
-- gruplarda otomasyon DURUR; uygulama kodunu da önceki sürüme döndürün.

-- 0. Güvenlik kontrolü: 0074 sonrası migration uygulanmışsa önce onlar geri alınmalı.
DO $$
DECLARE
  v_later boolean := false;
BEGIN
  IF pg_catalog.to_regclass('drizzle.__migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM drizzle.__migrations WHERE created_at > $1)'
      INTO v_later USING 1794967200000::bigint;
  END IF;
  IF v_later THEN
    RAISE EXCEPTION 'rollback_0074_blocked: 0074 sonrası migration uygulanmış'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END
$$;

-- 1. 0067 gövdesi (birebir).
CREATE OR REPLACE FUNCTION public.app_option_automation_since(p_group uuid) RETURNS timestamptz
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_prev_opt text := pg_catalog.current_setting('app.option_fn', true);
  v_since timestamptz;
BEGIN
  IF p_group IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  SELECT GREATEST(o.updated_at, s.updated_at, gs.updated_at, g.linked_at)
    INTO v_since
    FROM public.wa_groups g
    JOIN public.workspaces w ON w.id = g.workspace_id
    JOIN public.option_automation_global o ON o.id = 1
    JOIN public.workspace_option_settings s ON s.workspace_id = g.workspace_id
    JOIN public.wa_group_option_settings gs ON gs.group_id = g.id
   WHERE g.id = p_group AND g.status = 'linked' AND g.property_id IS NOT NULL
     AND g.linked_at IS NOT NULL AND w.status = 'active'
     AND o.enabled AND s.automation_enabled AND gs.enabled
     AND gs.workspace_id = g.workspace_id AND gs.updated_at >= g.linked_at;
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RETURN v_since;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RAISE;
END
$$;

-- 2. Migration kaydı: yeniden deploy'da tekrar uygulanır.
DO $$
BEGIN
  IF pg_catalog.to_regclass('drizzle.__migrations') IS NOT NULL THEN
    EXECUTE 'DELETE FROM drizzle.__migrations WHERE created_at = $1' USING 1794967200000::bigint;
  END IF;
END
$$;
