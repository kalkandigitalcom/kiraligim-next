-- Opsiyon 0070 (A2 grup yabancı anahtarı düzeltmesi) — GERİ ALMA BETİĞİ
--
-- YALNIZ GEREKİRSE. 0066–0069'u da geri alacaksanız ÖNCE bu betiği çalıştırın (sonra
-- docs/rollback-0066-0069.sql). app_migrator (veya süper kullanıcı) ile TEK transaction'da:
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f rollback-0070.sql
--
-- İki opsiyon tablosunun grup anahtarı 0064'teki bileşik (group_id, workspace_id) hâline döner.
-- UYARI: bileşik anahtar geri gelince, opsiyonu veya gölge kaydı olan grubun bağlantısı Super
-- Admin tarafından KALDIRILAMAZ (0070'in düzelttiği sorun). Bağlantısı kaldırılmış bir grubun
-- kaydı varsa anahtar eklenemez ve betik hiçbir şey değiştirmeden hata verir.

-- 0. Güvenlik kontrolü: 0070 sonrası migration uygulanmışsa önce onlar geri alınmalı.
DO $$
DECLARE
  v_later boolean := false;
BEGIN
  IF pg_catalog.to_regclass('drizzle.__migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM drizzle.__migrations WHERE created_at > $1)'
      INTO v_later USING 1794769971945::bigint;
  END IF;
  IF v_later THEN
    RAISE EXCEPTION 'rollback_0070_blocked: 0070 sonrası migration uygulanmış'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END
$$;

-- 1. Bileşik anahtarlar (0064'teki tanım).
ALTER TABLE public.reservation_options DROP CONSTRAINT IF EXISTS reservation_options_group_fk;
ALTER TABLE public.reservation_options ADD CONSTRAINT reservation_options_group_fk
  FOREIGN KEY (group_id, workspace_id) REFERENCES public.wa_groups (id, workspace_id)
  ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.wa_option_shadow_decisions DROP CONSTRAINT IF EXISTS wa_option_shadow_decisions_group_fk;
ALTER TABLE public.wa_option_shadow_decisions ADD CONSTRAINT wa_option_shadow_decisions_group_fk
  FOREIGN KEY (group_id, workspace_id) REFERENCES public.wa_groups (id, workspace_id)
  ON DELETE RESTRICT ON UPDATE NO ACTION;

-- 2. Migration kaydı: yeniden deploy'da tekrar uygulanır.
DO $$
BEGIN
  IF pg_catalog.to_regclass('drizzle.__migrations') IS NOT NULL THEN
    EXECUTE 'DELETE FROM drizzle.__migrations WHERE created_at = $1' USING 1794769971945::bigint;
  END IF;
END
$$;
