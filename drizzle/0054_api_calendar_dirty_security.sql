-- 0054_api_calendar_dirty_security (API 2. aşama, 1. adım: takvim değişikliği yakalama)
--
-- Tablo 0053'tedir: api_calendar_dirty. Bu migration:
--
--   1. api_calendar_dirty: ENABLE + FORCE RLS; PUBLIC'ten bütün yetkiler geri alınır. Hiçbir
--      uygulama rolü (app_user, app_admin, app_worker, app_wa_gateway) tabloya doğrudan erişemez.
--      Tek yazma yolu aşağıdaki tetikleyici fonksiyonlarıdır (yalnız INSERT, yalnız kendi açtıkları
--      'app.api_capture' bayrağıyla). Okuma/silme yetkisi sonraki adımdaki işlemciyle eklenecektir.
--   2. Takvimi etkileyen yazmalarda AYNI transaction içinde "değişen aralık" satırı:
--        reservations             — beklemede/onaylı kayıt eklendi, silindi; tarih, durum veya villa
--                                   değişti (eski ve yeni aralık ayrı satır). Beklemede ↔ onaylı geçişi
--                                   doluluğu değiştirmez → satır yok.
--        external_calendar_events — etkin olay eklendi; tarih/etkinlik/villa değişti; etkin olay
--                                   silindi (kaynak hâlâ varsa ve etkinse). iCal senkronunun aynı
--                                   değerlerle yeniden yazımı (yalnız last_seen_at) satır üretmez.
--        external_calendar_sources — etkin/pasif değişti, villa değişti veya etkin kaynak silindi:
--                                   villanın tam penceresi (olaylar okunmaz).
--        properties.status, workspaces.status — durum değişti: villanın (işletmenin tüm
--                                   villalarının) tam penceresi.
--      Tam pencere: bugünden (Europe/Istanbul) 366 gün geri, 731 gün ileri (API penceresi).
--   3. Tetikleyiciler hesaplama yapmaz ve kilit almaz: yalnız INSERT (işletme durumunda yalnız
--      işletmenin villa kimlikleri okunur; olay silmede kaynağın tek birincil anahtar araması).
--      EXCEPTION bloğu (alt transaction) kullanılmaz: set_config(…, true) değerleri transaction /
--      savepoint geri alınınca PostgreSQL tarafından zaten geri alınır. Hata olursa asıl yazma da
--      geri alınır — satırlar her zaman kısıtlara uygun üretilir.
--   4. Mevcut tetikleyiciler, politikalar, kolonlar ve fonksiyonlar DEĞİŞMEZ; yalnız yeni AFTER
--      tetikleyiciler eklenir. Rezervasyon/iCal/WhatsApp davranışı değişmez.
--
-- Geri alma (veri kaybı: işlenmemiş değişiklik satırları):
--   DROP TRIGGER reservations_api_capture_ins, reservations_api_capture_upd,
--     reservations_api_capture_del ON public.reservations;
--   DROP TRIGGER external_calendar_events_api_capture_ins, …_upd, …_del ON public.external_calendar_events;
--   DROP TRIGGER external_calendar_sources_api_capture_upd, …_del ON public.external_calendar_sources;
--   DROP TRIGGER properties_api_capture_status ON public.properties;
--   DROP TRIGGER workspaces_api_capture_status ON public.workspaces;
--   DROP FUNCTION app_api_capture_reservation(), app_api_capture_external_event(),
--     app_api_capture_external_source(), app_api_capture_property_status(),
--     app_api_capture_workspace_status(), app_api_capture_insert(uuid, date, date, text);
--   DROP TABLE api_calendar_dirty.

-- ---------------------------------------------------------------------------
-- 1. RLS ve yetkiler
-- ---------------------------------------------------------------------------
ALTER TABLE public.api_calendar_dirty ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.api_calendar_dirty FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE public.api_calendar_dirty FROM PUBLIC;
--> statement-breakpoint
CREATE POLICY api_calendar_dirty_capture ON public.api_calendar_dirty FOR INSERT TO app_migrator
  WITH CHECK (pg_catalog.current_setting('app.api_capture', true) = 'on');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Ortak ekleme yardımcısı (yalnız tetikleyici fonksiyonları çağırır; kimseye EXECUTE yok)
-- ---------------------------------------------------------------------------
-- p_start/p_end NULL ise tam pencere. Bayrak açılır, satır eklenir, bayrak eski değerine döner.
CREATE FUNCTION public.app_api_capture_insert(p_property uuid, p_start date, p_end date,
                                              p_reason text)
  RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_capture', true);
  v_today date;
BEGIN
  IF p_property IS NULL THEN
    RETURN;
  END IF;
  IF p_start IS NULL OR p_end IS NULL THEN
    v_today := (pg_catalog.now() AT TIME ZONE 'Europe/Istanbul')::date;
    p_start := v_today - 366;
    p_end := v_today + 731;
  END IF;
  IF p_end <= p_start THEN
    RETURN;
  END IF;
  PERFORM pg_catalog.set_config('app.api_capture', 'on', true);
  INSERT INTO public.api_calendar_dirty (property_id, start_date, end_date, reason)
  VALUES (p_property, p_start, p_end, p_reason);
  PERFORM pg_catalog.set_config('app.api_capture', coalesce(v_prev, ''), true);
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Rezervasyon ve bloklar
-- ---------------------------------------------------------------------------
-- Doluluk kuralı (app_public_villa_busy, app_api_busy ile aynı): durum beklemede veya onaylı.
CREATE FUNCTION public.app_api_capture_reservation()
  RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_old boolean := false;
  v_new boolean := false;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    v_old := OLD.status IN ('pending', 'confirmed');
  END IF;
  IF TG_OP IN ('UPDATE', 'INSERT') THEN
    v_new := NEW.status IN ('pending', 'confirmed');
  END IF;
  -- Her iki taraf dolu ve villa/tarihler aynı → doluluk değişmedi (ör. beklemede → onaylı).
  IF TG_OP = 'UPDATE' AND v_old AND v_new
     AND OLD.property_id = NEW.property_id
     AND OLD.check_in = NEW.check_in AND OLD.check_out = NEW.check_out THEN
    RETURN NULL;
  END IF;
  IF v_old THEN
    PERFORM public.app_api_capture_insert(OLD.property_id, OLD.check_in, OLD.check_out,
                                          'reservation');
  END IF;
  IF v_new THEN
    PERFORM public.app_api_capture_insert(NEW.property_id, NEW.check_in, NEW.check_out,
                                          'reservation');
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER reservations_api_capture_ins AFTER INSERT ON public.reservations
  FOR EACH ROW WHEN (NEW.status IN ('pending', 'confirmed'))
  EXECUTE FUNCTION public.app_api_capture_reservation();
--> statement-breakpoint
CREATE TRIGGER reservations_api_capture_upd
  AFTER UPDATE OF status, check_in, check_out, property_id ON public.reservations
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status
                     OR OLD.check_in IS DISTINCT FROM NEW.check_in
                     OR OLD.check_out IS DISTINCT FROM NEW.check_out
                     OR OLD.property_id IS DISTINCT FROM NEW.property_id)
  EXECUTE FUNCTION public.app_api_capture_reservation();
--> statement-breakpoint
CREATE TRIGGER reservations_api_capture_del AFTER DELETE ON public.reservations
  FOR EACH ROW WHEN (OLD.status IN ('pending', 'confirmed'))
  EXECUTE FUNCTION public.app_api_capture_reservation();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Harici takvim olayları (Airbnb/Booking iCal)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_api_capture_external_event()
  RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
  v_source_active boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.app_api_capture_insert(NEW.property_id, NEW.start_date, NEW.end_date,
                                          'external_event');
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- Kaynak silinirken (cascade) kaynak satırı artık görünmez: kaynağın kendi tetikleyicisi tam
    -- pencereyi bildirir. Pasif kaynağın olayları doluluğu etkilemez.
    PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
    SELECT EXISTS (SELECT 1 FROM public.external_calendar_sources s
                    WHERE s.id = OLD.source_id AND s.is_active)
      INTO v_source_active;
    PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
    IF v_source_active THEN
      PERFORM public.app_api_capture_insert(OLD.property_id, OLD.start_date, OLD.end_date,
                                            'external_event');
    END IF;
    RETURN NULL;
  END IF;
  -- UPDATE: WHEN koşulu gerçek bir değişikliği garanti eder.
  IF OLD.is_active AND NEW.is_active
     AND OLD.property_id = NEW.property_id
     AND OLD.start_date = NEW.start_date AND OLD.end_date = NEW.end_date THEN
    RETURN NULL;
  END IF;
  IF OLD.is_active THEN
    PERFORM public.app_api_capture_insert(OLD.property_id, OLD.start_date, OLD.end_date,
                                          'external_event');
  END IF;
  IF NEW.is_active THEN
    PERFORM public.app_api_capture_insert(NEW.property_id, NEW.start_date, NEW.end_date,
                                          'external_event');
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER external_calendar_events_api_capture_ins
  AFTER INSERT ON public.external_calendar_events
  FOR EACH ROW WHEN (NEW.is_active)
  EXECUTE FUNCTION public.app_api_capture_external_event();
--> statement-breakpoint
-- iCal senkronu her olayı (aynı değerlerle) yeniden yazar: WHEN yalnız gerçek farkı geçirir.
CREATE TRIGGER external_calendar_events_api_capture_upd
  AFTER UPDATE OF start_date, end_date, is_active, property_id
  ON public.external_calendar_events
  FOR EACH ROW WHEN (OLD.start_date IS DISTINCT FROM NEW.start_date
                     OR OLD.end_date IS DISTINCT FROM NEW.end_date
                     OR OLD.is_active IS DISTINCT FROM NEW.is_active
                     OR OLD.property_id IS DISTINCT FROM NEW.property_id)
  EXECUTE FUNCTION public.app_api_capture_external_event();
--> statement-breakpoint
CREATE TRIGGER external_calendar_events_api_capture_del
  AFTER DELETE ON public.external_calendar_events
  FOR EACH ROW WHEN (OLD.is_active)
  EXECUTE FUNCTION public.app_api_capture_external_event();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Harici takvim kaynağı: etkinlik/villa değişimi ve etkin kaynağın silinmesi → tam pencere
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_api_capture_external_source()
  RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.app_api_capture_insert(OLD.property_id, NULL, NULL, 'external_source');
    RETURN NULL;
  END IF;
  PERFORM public.app_api_capture_insert(OLD.property_id, NULL, NULL, 'external_source');
  IF NEW.property_id IS DISTINCT FROM OLD.property_id THEN
    PERFORM public.app_api_capture_insert(NEW.property_id, NULL, NULL, 'external_source');
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER external_calendar_sources_api_capture_upd
  AFTER UPDATE OF is_active, property_id ON public.external_calendar_sources
  FOR EACH ROW WHEN (OLD.is_active IS DISTINCT FROM NEW.is_active
                     OR OLD.property_id IS DISTINCT FROM NEW.property_id)
  EXECUTE FUNCTION public.app_api_capture_external_source();
--> statement-breakpoint
CREATE TRIGGER external_calendar_sources_api_capture_del
  AFTER DELETE ON public.external_calendar_sources
  FOR EACH ROW WHEN (OLD.is_active)
  EXECUTE FUNCTION public.app_api_capture_external_source();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. Villa ve işletme durumu (API görünürlüğü: pasif villa / askıdaki işletme) → tam pencere
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_api_capture_property_status()
  RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM public.app_api_capture_insert(NEW.id, NULL, NULL, 'property_status');
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER properties_api_capture_status AFTER UPDATE OF status ON public.properties
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.app_api_capture_property_status();
--> statement-breakpoint

CREATE FUNCTION public.app_api_capture_workspace_status()
  RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.api_fn', true);
  v_prev text := pg_catalog.current_setting('app.api_capture', true);
  v_today date := (pg_catalog.now() AT TIME ZONE 'Europe/Istanbul')::date;
BEGIN
  -- İşletmenin villa kimlikleri yalnız 'app.api_fn' ile görünür (0052 properties_api_fn).
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
  PERFORM pg_catalog.set_config('app.api_capture', 'on', true);
  INSERT INTO public.api_calendar_dirty (property_id, start_date, end_date, reason)
  SELECT p.id, v_today - 366, v_today + 731, 'workspace_status'
    FROM public.properties p WHERE p.workspace_id = NEW.id;
  PERFORM pg_catalog.set_config('app.api_capture', coalesce(v_prev, ''), true);
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev_fn, ''), true);
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER workspaces_api_capture_status AFTER UPDATE OF status ON public.workspaces
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.app_api_capture_workspace_status();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. EXECUTE: hiçbir rol (tetikleyici fonksiyonları ve iç yardımcı yalnız sahibi tarafından çalışır)
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.app_api_capture_insert(uuid, date, date, text),
  public.app_api_capture_reservation(),
  public.app_api_capture_external_event(),
  public.app_api_capture_external_source(),
  public.app_api_capture_property_status(),
  public.app_api_capture_workspace_status() FROM PUBLIC;
