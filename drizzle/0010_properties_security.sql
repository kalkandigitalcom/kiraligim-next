-- 0010_properties_security
-- properties (0009) için: RLS (ENABLE + FORCE), politikalar, kolon düzeyinde yetkiler, updated_at
-- ve paket limiti tetikleyicisi. 0009 ile aynı deploy'da, tek transaction'da uygulanır.
--
-- Kararlar (Aşama 2.4b):
--   * owner ve manager mülk ekler/düzenler; staff yalnız görüntüler.
--   * Silme yok (DELETE yetkisi ve politikası yok); yalnız pasife alma.
--   * Aktif ve pasif TÜM mülkler paket limitine dahildir.
--   * Abonelik geçerli değilse (deneme bitti / iptal) yeni mülk eklenemez; mevcutlar düzenlenebilir.

-- ---------------------------------------------------------------------------
-- 1. RLS (ENABLE + FORCE)
-- ---------------------------------------------------------------------------
ALTER TABLE public.properties ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.properties FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER properties_set_updated_at BEFORE UPDATE ON public.properties
  FOR EACH ROW EXECUTE FUNCTION public.app_set_updated_at();
--> statement-breakpoint
-- Okuma: bağlamdaki AKTİF işletmenin tüm üyeleri (staff dahil). Askıdaki işletmede rol NULL döner.
CREATE POLICY properties_select ON public.properties FOR SELECT TO app_user
  USING (workspace_id = public.app_current_workspace_id()
         AND public.app_current_member_role() IS NOT NULL);
--> statement-breakpoint
-- Ekleme: yalnız owner/manager, yalnız bağlamdaki işletmeye ve yalnız kendi adına.
CREATE POLICY properties_insert ON public.properties FOR INSERT TO app_user
  WITH CHECK (workspace_id = public.app_current_workspace_id()
              AND public.app_current_member_role() IN ('owner', 'manager')
              AND created_by = public.app_current_user_id());
--> statement-breakpoint
-- Düzenleme (pasife alma dahil): yalnız owner/manager; satır başka işletmeye taşınamaz.
CREATE POLICY properties_update ON public.properties FOR UPDATE TO app_user
  USING (workspace_id = public.app_current_workspace_id()
         AND public.app_current_member_role() IN ('owner', 'manager'))
  WITH CHECK (workspace_id = public.app_current_workspace_id());
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Yetkiler (kolon düzeyinde; DELETE yok; PUBLIC / app_admin / app_worker: hiçbiri)
-- ---------------------------------------------------------------------------
GRANT SELECT ON TABLE public.properties TO app_user;
--> statement-breakpoint
GRANT INSERT (id, workspace_id, created_by, name, property_type, description, status,
              max_guests, bedrooms, bathrooms, beds_double, beds_single, beds_sofa,
              country_code, province, district, neighborhood, address_line, postal_code,
              latitude, longitude)
  ON TABLE public.properties TO app_user;
--> statement-breakpoint
-- id, workspace_id, created_by, created_at, updated_at güncellenemez.
GRANT UPDATE (name, property_type, description, status,
              max_guests, bedrooms, bathrooms, beds_double, beds_single, beds_sofa,
              country_code, province, district, neighborhood, address_line, postal_code,
              latitude, longitude)
  ON TABLE public.properties TO app_user;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Paket limiti (yeni mülk eklenirken)
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER (bilinçli): ekleme yapan owner/manager, RLS ile bu işletmenin aboneliğini ve
-- TÜM mülklerini (aktif + pasif) zaten görür; böylece app_migrator için yeni RLS istisnası gerekmez.
-- Ekleme politikası rolü ayrıca denetler; başka işletmeye ait NEW.workspace_id için abonelik
-- görünmez ve ekleme reddedilir.
-- Eşzamanlılık: işletme başına advisory lock + READ COMMITTED (her sorgu yeni snapshot) veya
-- SERIALIZABLE (SSI). REPEATABLE READ eski snapshot'la sayacağı için reddedilir (fail-closed).
CREATE FUNCTION public.app_properties_enforce_limit() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_status text;
  v_trial_ends_at timestamptz;
  v_period_end timestamptz;
  v_max integer;
  v_used integer;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') NOT IN ('read committed', 'serializable') THEN
    RAISE EXCEPTION 'property_limit_isolation'
      USING ERRCODE = 'invalid_transaction_state',
            DETAIL = 'Mülk ekleme yalnız READ COMMITTED veya SERIALIZABLE transaction içinde yapılabilir.';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(NEW.workspace_id::text, 7002));

  SELECT s.status, s.trial_ends_at, s.current_period_end, p.max_properties
    INTO v_status, v_trial_ends_at, v_period_end, v_max
    FROM public.workspace_subscriptions s
    JOIN public.plans p ON p.id = s.plan_id
   WHERE s.workspace_id = NEW.workspace_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'property_subscription_missing'
      USING ERRCODE = 'check_violation', DETAIL = 'İşletmenin aboneliği bulunamadı.';
  END IF;
  IF NOT public.app_subscription_is_current(v_status, v_trial_ends_at, v_period_end) THEN
    RAISE EXCEPTION 'property_subscription_inactive'
      USING ERRCODE = 'check_violation', DETAIL = 'Abonelik geçerli değil; yeni mülk eklenemez.';
  END IF;

  SELECT pg_catalog.count(*) INTO v_used
    FROM public.properties x
   WHERE x.workspace_id = NEW.workspace_id;
  IF v_used >= v_max THEN
    RAISE EXCEPTION 'property_limit_reached'
      USING ERRCODE = 'check_violation', DETAIL = 'Paketin mülk sınırına ulaşıldı.';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_properties_enforce_limit() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER properties_enforce_limit BEFORE INSERT ON public.properties
  FOR EACH ROW EXECUTE FUNCTION public.app_properties_enforce_limit();
