-- 0012_property_photos_security
-- property_photos (0011) için: RLS (ENABLE + FORCE), politikalar, kolon düzeyinde yetkiler ve
-- 80 fotoğraf sınırı + sıra/kapak ataması tetikleyicisi. 0011 ile aynı deploy'da, tek
-- transaction'da uygulanır.
--
-- Kararlar (Aşama 2.4c):
--   * owner ve manager fotoğraf ekler, sıralar, kapak seçer ve SİLER; staff yalnız görüntüler.
--   * Mülk başına en fazla 80 fotoğraf. Deneme süresi bitmiş işletmeler de yükleyebilir
--     (fotoğraf, mevcut mülkün düzenlenmesi sayılır).
--   * Yalnız işlenmiş WebP varyantlarının yeri tutulur; orijinal dosya ve dosya adı yoktur.

-- ---------------------------------------------------------------------------
-- 1. RLS (ENABLE + FORCE)
-- ---------------------------------------------------------------------------
ALTER TABLE public.property_photos ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.property_photos FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Okuma: bağlamdaki AKTİF işletmenin tüm üyeleri (staff dahil). Askıdaki işletmede rol NULL.
CREATE POLICY property_photos_select ON public.property_photos FOR SELECT TO app_user
  USING (workspace_id = public.app_current_workspace_id()
         AND public.app_current_member_role() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY property_photos_insert ON public.property_photos FOR INSERT TO app_user
  WITH CHECK (workspace_id = public.app_current_workspace_id()
              AND public.app_current_member_role() IN ('owner', 'manager')
              AND created_by = public.app_current_user_id());
--> statement-breakpoint
CREATE POLICY property_photos_update ON public.property_photos FOR UPDATE TO app_user
  USING (workspace_id = public.app_current_workspace_id()
         AND public.app_current_member_role() IN ('owner', 'manager'))
  WITH CHECK (workspace_id = public.app_current_workspace_id());
--> statement-breakpoint
CREATE POLICY property_photos_delete ON public.property_photos FOR DELETE TO app_user
  USING (workspace_id = public.app_current_workspace_id()
         AND public.app_current_member_role() IN ('owner', 'manager'));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Yetkiler (kolon düzeyinde; PUBLIC / app_admin / app_worker: hiçbiri)
-- ---------------------------------------------------------------------------
GRANT SELECT, DELETE ON TABLE public.property_photos TO app_user;
--> statement-breakpoint
-- sort_order ve is_cover INSERT'te verilse de tetikleyici kilit altında yeniden hesaplar.
GRANT INSERT (id, workspace_id, property_id, created_by, storage_prefix, width, height, quality,
              bytes_400, bytes_1200, bytes_2000, sort_order, is_cover)
  ON TABLE public.property_photos TO app_user;
--> statement-breakpoint
-- Yalnız sıra ve kapak değişebilir; görsel bilgisi, yer ve sahiplik değiştirilemez.
GRANT UPDATE (sort_order, is_cover) ON TABLE public.property_photos TO app_user;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. 80 fotoğraf sınırı, sıra ve kapak (yeni fotoğraf eklenirken)
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER (bilinçli): ekleyen owner/manager, RLS ile bu mülkün TÜM fotoğraflarını görür;
-- app_migrator için yeni RLS istisnası gerekmez. Mülkün aynı işletmeye ait olduğunu bileşik FK,
-- işletmenin bağlamdaki işletme olduğunu ekleme politikası garanti eder.
-- Mülk başına advisory lock ALINDIKTAN SONRA sayılır; sıra (son + 1) ve kapak (mülkün ilk
-- fotoğrafıysa) da kilit altında atanır: eşzamanlı yüklemeler ne sınırı aşar ne iki kapak üretir.
-- READ COMMITTED (her sorgu yeni snapshot) ve SERIALIZABLE (SSI) güvenlidir; REPEATABLE READ
-- eski snapshot'la sayacağı için reddedilir (fail-closed).
CREATE FUNCTION public.app_property_photos_before_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_count integer;
  v_next integer;
  v_has_cover boolean;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') NOT IN ('read committed', 'serializable') THEN
    RAISE EXCEPTION 'property_photo_isolation'
      USING ERRCODE = 'invalid_transaction_state',
            DETAIL = 'Fotoğraf ekleme yalnız READ COMMITTED veya SERIALIZABLE transaction içinde yapılabilir.';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(NEW.property_id::text, 7003));

  -- Mülk, ekleyenin RLS ile görebildiği (bağlamdaki işletmenin) bir mülk olmalı. Bileşik FK de
  -- engeller, ama FK denetimi deyim sonunda çalışır; bu satır başka işletmenin mülkü hakkında
  -- (ör. kapak indeksi ihlaliyle) bilgi sızmadan önce, tek tip hatayla reddeder.
  IF NOT EXISTS (SELECT 1 FROM public.properties p
                  WHERE p.id = NEW.property_id AND p.workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'property_photo_property_not_found'
      USING ERRCODE = 'foreign_key_violation', DETAIL = 'Mülk bulunamadı.';
  END IF;

  SELECT pg_catalog.count(*), pg_catalog.max(x.sort_order), pg_catalog.bool_or(x.is_cover)
    INTO v_count, v_next, v_has_cover
    FROM public.property_photos x
   WHERE x.property_id = NEW.property_id;
  IF v_count >= 80 THEN
    RAISE EXCEPTION 'property_photo_limit_reached'
      USING ERRCODE = 'check_violation', DETAIL = 'Mülk başına en fazla 80 fotoğraf yüklenebilir.';
  END IF;

  NEW.sort_order := COALESCE(v_next + 1, 0);
  NEW.is_cover := NOT COALESCE(v_has_cover, false);
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_property_photos_before_insert() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER property_photos_before_insert BEFORE INSERT ON public.property_photos
  FOR EACH ROW EXECUTE FUNCTION public.app_property_photos_before_insert();
