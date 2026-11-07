-- 0016_reservations_security
-- reservations (0015) için: RLS (ENABLE + FORCE), politikalar, kolon düzeyinde yetkiler,
-- çakışma kısıtı ve tetikleyiciler. 0015 ile aynı deploy'da uygulanır.
--
-- Kararlar (Aşama 3.0a):
--   * Owner ve manager rezervasyon/blok ekler, düzenler, onaylar ve iptal eder; staff yalnız görüntüler.
--   * Silme yoktur: iptal (status = 'cancelled') güncellemeyle yapılır; iptal edilen kayıt kesindir.
--   * Beklemede ve onaylı kayıtlar tarihleri kapatır; iptal edilen kayıt müsaitliği yeniden açar.
--   * Konaklama [giriş, çıkış) yarı açık aralıktır: çıkış günü başka kaydın giriş günü olabilir.
--   * Rezervasyon ve blok aynı çakışma kısıtına tabidir (tek tablo).
--   * Mülk ve kayıt türü sonradan değiştirilemez; pasif mülke yeni kayıt eklenemez.
--   * Giriş tarihi [bugün − 1 yıl, bugün + 3 yıl] aralığında olmalı (Europe/Istanbul).
--   * Deneme süresi biten işletmelerde rezervasyon yönetimi sürer (abonelik denetimi yok).

-- ---------------------------------------------------------------------------
-- 1. Çakışma kısıtı (btree_gist: 0000_bootstrap'ta kurulu)
-- ---------------------------------------------------------------------------
-- Dizin düzeyinde denetlendiği için her izolasyon seviyesinde ve RLS'ten bağımsız çalışır:
-- eşzamanlı iki çakışan eklemenin en fazla biri commit edilebilir.
ALTER TABLE public.reservations ADD CONSTRAINT reservations_no_overlap
  EXCLUDE USING gist (property_id WITH =, daterange(check_in, check_out, '[)') WITH &&)
  WHERE (status IN ('pending', 'confirmed'));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. RLS (ENABLE + FORCE)
-- ---------------------------------------------------------------------------
ALTER TABLE public.reservations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.reservations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Okuma: bağlamdaki AKTİF işletmenin tüm üyeleri (staff dahil). Askıdaki işletmede rol NULL.
CREATE POLICY reservations_select ON public.reservations FOR SELECT TO app_user
  USING (workspace_id = public.app_current_workspace_id()
         AND public.app_current_member_role() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY reservations_insert ON public.reservations FOR INSERT TO app_user
  WITH CHECK (workspace_id = public.app_current_workspace_id()
              AND public.app_current_member_role() IN ('owner', 'manager')
              AND created_by = public.app_current_user_id());
--> statement-breakpoint
CREATE POLICY reservations_update ON public.reservations FOR UPDATE TO app_user
  USING (workspace_id = public.app_current_workspace_id()
         AND public.app_current_member_role() IN ('owner', 'manager'))
  WITH CHECK (workspace_id = public.app_current_workspace_id());
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Yetkiler (kolon düzeyinde; PUBLIC / app_admin / app_worker: hiçbiri; DELETE yok)
-- ---------------------------------------------------------------------------
GRANT SELECT ON TABLE public.reservations TO app_user;
--> statement-breakpoint
GRANT INSERT (id, workspace_id, property_id, kind, status, source, check_in, check_out,
              guest_name, guest_phone, guest_email, adults, children,
              total_amount_minor, deposit_amount_minor, currency, note, created_by)
  ON TABLE public.reservations TO app_user;
--> statement-breakpoint
-- id, workspace_id, property_id, kind, created_by, created_at: değişmez.
-- cancelled_at / cancelled_by tetikleyicide yazılır; balance_amount_minor hesaplanır.
GRANT UPDATE (status, source, check_in, check_out, guest_name, guest_phone, guest_email,
              adults, children, total_amount_minor, deposit_amount_minor, currency, note,
              cancel_reason)
  ON TABLE public.reservations TO app_user;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Tetikleyiciler
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER (bilinçli): ekleyen owner/manager mülkü RLS ile görür; app_migrator için
-- RLS istisnası gerekmez. Kurallar:
--   INSERT: durum iptal olamaz; mülk aktif olmalı; giriş tarihi izinli aralıkta.
--   UPDATE: iptal edilmiş kayıt değiştirilemez; iptale geçişte iptal zamanı ve eden burada yazılır
--           (istemci yazamaz); tarih değişirse giriş tarihi izinli aralıkta olmalı.
CREATE FUNCTION public.app_reservations_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_today date := (pg_catalog.now() AT TIME ZONE 'Europe/Istanbul')::date;
  v_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'cancelled' THEN
      RAISE EXCEPTION 'reservation_cancelled_immutable'
        USING ERRCODE = 'check_violation', DETAIL = 'İptal edilen kayıt değiştirilemez.';
    END IF;
    IF NEW.property_id IS DISTINCT FROM OLD.property_id OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
      RAISE EXCEPTION 'reservation_immutable_field'
        USING ERRCODE = 'check_violation', DETAIL = 'Mülk ve kayıt türü değiştirilemez.';
    END IF;
    IF NEW.status = 'cancelled' THEN
      NEW.cancelled_at := pg_catalog.now();
      NEW.cancelled_by := public.app_current_user_id();
    ELSE
      NEW.cancelled_at := NULL;
      NEW.cancelled_by := NULL;
    END IF;
    IF NEW.check_in IS NOT DISTINCT FROM OLD.check_in
       AND NEW.check_out IS NOT DISTINCT FROM OLD.check_out THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.status = 'cancelled' THEN
      RAISE EXCEPTION 'reservation_insert_cancelled'
        USING ERRCODE = 'check_violation', DETAIL = 'İptal durumunda kayıt eklenemez.';
    END IF;
    NEW.cancelled_at := NULL;
    NEW.cancelled_by := NULL;
    SELECT p.status INTO v_status
      FROM public.properties p
     WHERE p.id = NEW.property_id AND p.workspace_id = NEW.workspace_id;
    IF v_status IS NULL THEN
      RAISE EXCEPTION 'reservation_property_not_found'
        USING ERRCODE = 'foreign_key_violation', DETAIL = 'Mülk bulunamadı.';
    END IF;
    IF v_status <> 'active' THEN
      RAISE EXCEPTION 'reservation_property_inactive'
        USING ERRCODE = 'check_violation', DETAIL = 'Pasif mülke yeni kayıt eklenemez.';
    END IF;
  END IF;

  IF NEW.check_in < (v_today - interval '1 year')::date
     OR NEW.check_in > (v_today + interval '3 years')::date THEN
    RAISE EXCEPTION 'reservation_date_out_of_range'
      USING ERRCODE = 'check_violation',
            DETAIL = 'Giriş tarihi en fazla 1 yıl geçmişte ve 3 yıl ileride olabilir.';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_reservations_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER reservations_guard BEFORE INSERT OR UPDATE ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.app_reservations_guard();
--> statement-breakpoint
CREATE TRIGGER reservations_set_updated_at BEFORE UPDATE ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.app_set_updated_at();
