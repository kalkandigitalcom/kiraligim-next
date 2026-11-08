-- 0029_ical_security (Aşama 3.1: iki yönlü iCal)
-- 0028'de oluşturulan tabloların güvenliği, senkron/dışa aktarma fonksiyonları ve müsaitlik
-- entegrasyonu. Mevcut tablo ve kayıtlar DEĞİŞMEZ; rezervasyon tablosuna yalnız yeni bir
-- tetikleyici eklenir, app_public_villa_busy aynı imzayla yeniden tanımlanır.
--
-- Güvenlik modeli (0024/0027 ile aynı):
--   * app_user kaynakları RLS altında yönetir (owner/manager ekler, düzenler, siler; tüm üyeler
--     okur). Olaylar ve senkron kayıtları app_user tarafından YAZILAMAZ: tek yazma noktası
--     SECURITY DEFINER app_ical_claim_sources (kilit) ve app_ical_apply_sync (sonuç) fonksiyonlarıdır.
--   * Fonksiyonlar app_migrator sahipliğindedir; tablolar FORCE RLS olduğu için app_migrator'a
--     yalnız fonksiyonun transaction içinde açtığı ayarla (app.ical_sync / app.ical_guard /
--     app.ical_export / app.public_read) geçerli dar politikalar verilir.
--   * Dışa aktarma (app_ical_export) yalnız reservations tablosunu okur: harici olaylar hiçbir
--     zaman dışa aktarılmaz (senkron döngüsü yapısal olarak oluşamaz). Misafir alanları okunmaz.
--
-- Müsaitlik:
--   * reservations_guard_external tetikleyicisi: yeni kayıt (rezervasyon/blok, beklemede/onaylı)
--     veya tarih değişikliği, ETKİN kaynağın ETKİN olayıyla çakışırsa 23P01 (exclusion_violation,
--     mesaj 'reservation_external_overlap'). Mevcut çakışma hata yolu (mapWriteError,
--     F3 talebi) aynen çalışır. Yalnız durum değişikliği (beklemede → onaylı, iptal) denetlenmez:
--     tarihler zaten Kiraligim'de kapalıdır; sonradan gelen çakışma panelde gösterilir.
--   * Senkron ve tetikleyici aynı mülk kilidini (pg_advisory_xact_lock) kullanır.
--   * Harici olay Kiraligim kaydıyla çakışsa da içe alınır (dış platformdaki doluluk bir
--     gerçektir); çakışma sayısı kaynakta tutulur ve panelde uyarı olarak gösterilir.
--
-- Geri alma (veri kaybı: harici takvim kayıtları ve dışa aktarma belirteçleri):
--   DROP TRIGGER reservations_guard_external ON public.reservations;
--   app_public_villa_busy'yi 0024'teki tanımla yeniden oluşturma;
--   DROP FUNCTION app_ical_claim_sources(uuid, text, integer), app_ical_apply_sync(uuid, uuid, text,
--     timestamptz, jsonb, text), app_ical_export(text), app_reservations_external_guard(),
--     app_ical_sources_before_write();
--   DROP POLICY … (aşağıdaki *_ical_* ve *_public_read politikaları);
--   DROP TABLE external_calendar_sync_runs, external_calendar_events, external_calendar_sources,
--     property_ical_exports.

-- ---------------------------------------------------------------------------
-- 1. RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.external_calendar_sources ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.external_calendar_sources FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.external_calendar_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.external_calendar_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.external_calendar_sync_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.external_calendar_sync_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.property_ical_exports ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.property_ical_exports FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- app_user: kaynaklar (tüm üyeler okur; owner/manager yazar)
CREATE POLICY external_calendar_sources_select ON public.external_calendar_sources
  FOR SELECT TO app_user
  USING (workspace_id = public.app_current_workspace_id()
         AND public.app_current_member_role() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY external_calendar_sources_insert ON public.external_calendar_sources
  FOR INSERT TO app_user
  WITH CHECK (workspace_id = public.app_current_workspace_id()
              AND public.app_current_member_role() IN ('owner', 'manager')
              AND created_by = public.app_current_user_id());
--> statement-breakpoint
CREATE POLICY external_calendar_sources_update ON public.external_calendar_sources
  FOR UPDATE TO app_user
  USING (workspace_id = public.app_current_workspace_id()
         AND public.app_current_member_role() IN ('owner', 'manager'))
  WITH CHECK (workspace_id = public.app_current_workspace_id());
--> statement-breakpoint
CREATE POLICY external_calendar_sources_delete ON public.external_calendar_sources
  FOR DELETE TO app_user
  USING (workspace_id = public.app_current_workspace_id()
         AND public.app_current_member_role() IN ('owner', 'manager'));
--> statement-breakpoint
-- app_user: olaylar ve senkron kayıtları yalnız okunur
CREATE POLICY external_calendar_events_select ON public.external_calendar_events
  FOR SELECT TO app_user
  USING (workspace_id = public.app_current_workspace_id()
         AND public.app_current_member_role() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY external_calendar_sync_runs_select ON public.external_calendar_sync_runs
  FOR SELECT TO app_user
  USING (workspace_id = public.app_current_workspace_id()
         AND public.app_current_member_role() IS NOT NULL);
--> statement-breakpoint
-- app_user: dışa aktarma belirteci yalnız owner/manager'a görünür (adres bir erişim anahtarıdır)
CREATE POLICY property_ical_exports_select ON public.property_ical_exports
  FOR SELECT TO app_user
  USING (workspace_id = public.app_current_workspace_id()
         AND public.app_current_member_role() IN ('owner', 'manager'));
--> statement-breakpoint
CREATE POLICY property_ical_exports_insert ON public.property_ical_exports
  FOR INSERT TO app_user
  WITH CHECK (workspace_id = public.app_current_workspace_id()
              AND public.app_current_member_role() IN ('owner', 'manager')
              AND created_by = public.app_current_user_id());
--> statement-breakpoint
CREATE POLICY property_ical_exports_update ON public.property_ical_exports
  FOR UPDATE TO app_user
  USING (workspace_id = public.app_current_workspace_id()
         AND public.app_current_member_role() IN ('owner', 'manager'))
  WITH CHECK (workspace_id = public.app_current_workspace_id());
--> statement-breakpoint

-- app_migrator: yalnız fonksiyonların açtığı ayarlarla
CREATE POLICY external_calendar_sources_ical_sync ON public.external_calendar_sources
  FOR ALL TO app_migrator
  USING (pg_catalog.current_setting('app.ical_sync', true) = 'on')
  WITH CHECK (pg_catalog.current_setting('app.ical_sync', true) = 'on');
--> statement-breakpoint
CREATE POLICY external_calendar_events_ical_sync ON public.external_calendar_events
  FOR ALL TO app_migrator
  USING (pg_catalog.current_setting('app.ical_sync', true) = 'on')
  WITH CHECK (pg_catalog.current_setting('app.ical_sync', true) = 'on');
--> statement-breakpoint
CREATE POLICY external_calendar_sync_runs_ical_sync ON public.external_calendar_sync_runs
  FOR ALL TO app_migrator
  USING (pg_catalog.current_setting('app.ical_sync', true) = 'on')
  WITH CHECK (pg_catalog.current_setting('app.ical_sync', true) = 'on');
--> statement-breakpoint
CREATE POLICY reservations_ical_sync_read ON public.reservations FOR SELECT TO app_migrator
  USING (pg_catalog.current_setting('app.ical_sync', true) = 'on'
         AND status IN ('pending', 'confirmed'));
--> statement-breakpoint
CREATE POLICY workspaces_ical_sync_read ON public.workspaces FOR SELECT TO app_migrator
  USING (pg_catalog.current_setting('app.ical_sync', true) = 'on');
--> statement-breakpoint
-- Çakışma tetikleyicisi (yalnız okuma)
CREATE POLICY external_calendar_sources_ical_guard ON public.external_calendar_sources
  FOR SELECT TO app_migrator
  USING (pg_catalog.current_setting('app.ical_guard', true) = 'on');
--> statement-breakpoint
CREATE POLICY external_calendar_events_ical_guard ON public.external_calendar_events
  FOR SELECT TO app_migrator
  USING (pg_catalog.current_setting('app.ical_guard', true) = 'on');
--> statement-breakpoint
-- Public müsaitlik (app_public_villa_busy; görünürlük fonksiyonda denetlenir)
CREATE POLICY external_calendar_sources_public_read ON public.external_calendar_sources
  FOR SELECT TO app_migrator
  USING (pg_catalog.current_setting('app.public_read', true) = 'on' AND is_active);
--> statement-breakpoint
CREATE POLICY external_calendar_events_public_read ON public.external_calendar_events
  FOR SELECT TO app_migrator
  USING (pg_catalog.current_setting('app.public_read', true) = 'on' AND is_active);
--> statement-breakpoint
-- Dışa aktarma akışı (app_ical_export)
CREATE POLICY property_ical_exports_ical_export ON public.property_ical_exports
  FOR ALL TO app_migrator
  USING (pg_catalog.current_setting('app.ical_export', true) = 'on')
  WITH CHECK (pg_catalog.current_setting('app.ical_export', true) = 'on');
--> statement-breakpoint
CREATE POLICY reservations_ical_export_read ON public.reservations FOR SELECT TO app_migrator
  USING (pg_catalog.current_setting('app.ical_export', true) = 'on'
         AND status IN ('pending', 'confirmed'));
--> statement-breakpoint
CREATE POLICY properties_ical_export_read ON public.properties FOR SELECT TO app_migrator
  USING (pg_catalog.current_setting('app.ical_export', true) = 'on');
--> statement-breakpoint
CREATE POLICY workspaces_ical_export_read ON public.workspaces FOR SELECT TO app_migrator
  USING (pg_catalog.current_setting('app.ical_export', true) = 'on');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Yetkiler (kolon düzeyinde; PUBLIC / app_admin / app_worker: hiçbiri)
-- ---------------------------------------------------------------------------
GRANT SELECT, DELETE ON TABLE public.external_calendar_sources TO app_user;
--> statement-breakpoint
GRANT INSERT (id, workspace_id, property_id, name, url, is_active, created_by)
  ON TABLE public.external_calendar_sources TO app_user;
--> statement-breakpoint
GRANT UPDATE (name, url, is_active) ON TABLE public.external_calendar_sources TO app_user;
--> statement-breakpoint
GRANT SELECT ON TABLE public.external_calendar_events TO app_user;
--> statement-breakpoint
GRANT SELECT ON TABLE public.external_calendar_sync_runs TO app_user;
--> statement-breakpoint
GRANT SELECT ON TABLE public.property_ical_exports TO app_user;
--> statement-breakpoint
GRANT INSERT (property_id, workspace_id, token, created_by)
  ON TABLE public.property_ical_exports TO app_user;
--> statement-breakpoint
GRANT UPDATE (token, rotated_at) ON TABLE public.property_ical_exports TO app_user;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Kaynak tetikleyicisi: mülk başına en fazla 10 kaynak; adres değişince veya kaynak yeniden
--    etkinleşince senkron durumu sıfırlanır (bir sonraki cron hemen alır).
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_ical_sources_before_write() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT pg_catalog.count(*) INTO v_count
      FROM public.external_calendar_sources s
     WHERE s.property_id = NEW.property_id AND s.workspace_id = NEW.workspace_id;
    IF v_count >= 10 THEN
      RAISE EXCEPTION 'ical_source_limit_reached'
        USING ERRCODE = 'check_violation', DETAIL = 'Bir mülke en fazla 10 takvim eklenebilir.';
    END IF;
    NEW.status := 'pending';
    NEW.last_synced_at := NULL;
    NEW.last_success_at := NULL;
    NEW.last_error_code := NULL;
    NEW.event_count := 0;
    NEW.conflict_count := 0;
    NEW.consecutive_failures := 0;
    NEW.locked_until := NULL;
    NEW.lock_token := NULL;
    RETURN NEW;
  END IF;
  IF NEW.property_id IS DISTINCT FROM OLD.property_id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION 'ical_source_immutable_field' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.url IS DISTINCT FROM OLD.url OR (NEW.is_active AND NOT OLD.is_active) THEN
    NEW.status := 'pending';
    NEW.last_synced_at := NULL;
    NEW.last_error_code := NULL;
    NEW.consecutive_failures := 0;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_ical_sources_before_write() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER external_calendar_sources_before_write
  BEFORE INSERT OR UPDATE ON public.external_calendar_sources
  FOR EACH ROW EXECUTE FUNCTION public.app_ical_sources_before_write();
--> statement-breakpoint
CREATE TRIGGER external_calendar_sources_set_updated_at
  BEFORE UPDATE ON public.external_calendar_sources
  FOR EACH ROW EXECUTE FUNCTION public.app_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER external_calendar_events_set_updated_at
  BEFORE UPDATE ON public.external_calendar_events
  FOR EACH ROW EXECUTE FUNCTION public.app_set_updated_at();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Rezervasyon çakışma tetikleyicisi (harici doluluk)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_reservations_external_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.ical_guard', true);
  v_hit boolean;
BEGIN
  IF NEW.status NOT IN ('pending', 'confirmed') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.check_in IS NOT DISTINCT FROM OLD.check_in
     AND NEW.check_out IS NOT DISTINCT FROM OLD.check_out THEN
    RETURN NEW;
  END IF;
  -- Senkronla aynı mülk kilidi: eşzamanlı içe aktarma ile yarış olmaz.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('kiraligim:availability:' || NEW.property_id::text, 0));
  PERFORM pg_catalog.set_config('app.ical_guard', 'on', true);
  SELECT EXISTS (
    SELECT 1
      FROM public.external_calendar_events e
      JOIN public.external_calendar_sources s
        ON s.id = e.source_id AND s.workspace_id = e.workspace_id
     WHERE e.property_id = NEW.property_id
       AND e.workspace_id = NEW.workspace_id
       AND e.is_active AND s.is_active
       AND e.start_date < NEW.check_out AND e.end_date > NEW.check_in)
    INTO v_hit;
  PERFORM pg_catalog.set_config('app.ical_guard', coalesce(v_prev, ''), true);
  IF v_hit THEN
    RAISE EXCEPTION 'reservation_external_overlap'
      USING ERRCODE = 'exclusion_violation',
            DETAIL = 'Seçilen tarihler harici bir takvimde (iCal) dolu.';
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.ical_guard', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_reservations_external_guard() FROM PUBLIC;
--> statement-breakpoint
-- BEFORE tetikleyicileri ada göre sıralanır: reservations_guard (mülk/tarih kuralları) önce çalışır.
CREATE TRIGGER reservations_guard_external
  BEFORE INSERT OR UPDATE OF check_in, check_out ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.app_reservations_external_guard();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Senkron: kilit alma (cron toplu / panel tek kaynak)
-- ---------------------------------------------------------------------------
-- Dönüş: claimed (kilit alındı, adres ve kilit belirteci döner) | locked (başka senkron sürüyor)
--        | too_soon (elle senkron için 60 sn bekleme) | inactive | not_found.
-- Cron (p_source NULL): etkin işletmelerdeki etkin, kilitsiz ve son denemesi 4 saatten (5 dk pay)
-- eski kaynaklardan en fazla p_limit (≤ 50) tanesi; FOR UPDATE SKIP LOCKED ile iki cron çakışmaz.
CREATE FUNCTION public.app_ical_claim_sources(p_source uuid, p_trigger text, p_limit integer)
  RETURNS TABLE (source_id uuid, url text, lock_token uuid, outcome text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev text := pg_catalog.current_setting('app.ical_sync', true);
  v_now timestamptz := pg_catalog.clock_timestamp();
  r record;
  v_token uuid;
BEGIN
  IF p_trigger NOT IN ('cron', 'manual') OR (p_trigger = 'manual' AND p_source IS NULL)
     OR p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION 'ical_claim_invalid' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.set_config('app.ical_sync', 'on', true);
  IF p_trigger = 'manual' THEN
    SELECT s.id, s.url, s.is_active, s.locked_until, s.last_synced_at INTO r
      FROM public.external_calendar_sources s
     WHERE s.id = p_source
     FOR UPDATE;
    IF NOT FOUND THEN
      source_id := p_source; url := NULL; lock_token := NULL; outcome := 'not_found';
      RETURN NEXT;
    ELSIF NOT r.is_active THEN
      source_id := r.id; url := NULL; lock_token := NULL; outcome := 'inactive';
      RETURN NEXT;
    ELSIF r.locked_until IS NOT NULL AND r.locked_until > v_now THEN
      source_id := r.id; url := NULL; lock_token := NULL; outcome := 'locked';
      RETURN NEXT;
    ELSIF r.last_synced_at IS NOT NULL AND r.last_synced_at > v_now - interval '60 seconds' THEN
      source_id := r.id; url := NULL; lock_token := NULL; outcome := 'too_soon';
      RETURN NEXT;
    ELSE
      v_token := pg_catalog.gen_random_uuid();
      UPDATE public.external_calendar_sources s
         SET locked_until = v_now + interval '120 seconds', lock_token = v_token
       WHERE s.id = r.id;
      source_id := r.id; url := r.url; lock_token := v_token; outcome := 'claimed';
      RETURN NEXT;
    END IF;
  ELSE
    FOR r IN
      SELECT s.id, s.url
        FROM public.external_calendar_sources s
        JOIN public.workspaces w ON w.id = s.workspace_id
       WHERE s.is_active AND w.status = 'active'
         AND (s.locked_until IS NULL OR s.locked_until <= v_now)
         AND (s.last_synced_at IS NULL
              OR s.last_synced_at <= v_now - interval '4 hours' + interval '5 minutes')
       ORDER BY s.last_synced_at NULLS FIRST, s.id
       LIMIT p_limit
       FOR UPDATE OF s SKIP LOCKED
    LOOP
      v_token := pg_catalog.gen_random_uuid();
      UPDATE public.external_calendar_sources s
         SET locked_until = v_now + interval '120 seconds', lock_token = v_token
       WHERE s.id = r.id;
      source_id := r.id; url := r.url; lock_token := v_token; outcome := 'claimed';
      RETURN NEXT;
    END LOOP;
  END IF;
  PERFORM pg_catalog.set_config('app.ical_sync', coalesce(v_prev, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.ical_sync', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. Senkron: sonucu uygulama
-- ---------------------------------------------------------------------------
-- p_events: [{"uid": "...", "start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD"}, …]
-- (ayrıştırma ve SSRF denetimi uygulamada yapılır; burada sınırlar yeniden denetlenir).
-- Başarıda: olaylar UID ile upsert edilir; akışta olmayan ESKİ olaylar yalnız BU kaynakta
-- pasifleştirilir; kaynak durumu, sayılar ve senkron kaydı yazılır, kilit bırakılır.
-- Hatada (p_error_code dolu): olaylara DOKUNULMAZ (geçici hata tarihleri açmaz); yalnız durum.
-- Kilit belirteci eşleşmezse (kilit başka senkrona geçmiş) 'ical_lock_lost'.
CREATE FUNCTION public.app_ical_apply_sync(
    p_source uuid, p_lock_token uuid, p_trigger text, p_started_at timestamptz,
    p_events jsonb, p_error_code text)
  RETURNS TABLE (outcome text, events_total integer, events_added integer,
                 events_updated integer, events_deactivated integer, conflict_count integer)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev text := pg_catalog.current_setting('app.ical_sync', true);
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_src record;
  v_total integer := 0;
  v_added integer := 0;
  v_updated integer := 0;
  v_deact integer := 0;
  v_conflicts integer := 0;
BEGIN
  IF p_source IS NULL OR p_lock_token IS NULL OR p_trigger NOT IN ('cron', 'manual')
     OR p_started_at IS NULL THEN
    RAISE EXCEPTION 'ical_apply_invalid' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.set_config('app.ical_sync', 'on', true);
  SELECT s.id, s.workspace_id, s.property_id INTO v_src
    FROM public.external_calendar_sources s
   WHERE s.id = p_source AND s.lock_token = p_lock_token
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ical_lock_lost' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF p_error_code IS NOT NULL THEN
    UPDATE public.external_calendar_sources s
       SET status = 'error', last_synced_at = v_now, last_error_code = p_error_code,
           consecutive_failures = s.consecutive_failures + 1,
           locked_until = NULL, lock_token = NULL
     WHERE s.id = v_src.id;
    INSERT INTO public.external_calendar_sync_runs (
        id, workspace_id, source_id, trigger, started_at, finished_at, outcome, error_code)
      VALUES (public.app_uuid_v7(), v_src.workspace_id, v_src.id, p_trigger, p_started_at, v_now,
              'error', p_error_code);
    outcome := 'error';
  ELSE
    IF p_events IS NULL OR pg_catalog.jsonb_typeof(p_events) <> 'array'
       OR pg_catalog.jsonb_array_length(p_events) > 2000 THEN
      RAISE EXCEPTION 'ical_apply_events_invalid' USING ERRCODE = 'check_violation';
    END IF;
    -- Rezervasyon tetikleyicisiyle aynı mülk kilidi.
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('kiraligim:availability:' || v_src.property_id::text, 0));

    -- Gelen olaylar (aynı UID bir kez; ayrıştırıcı zaten tekilleştirir).
    IF EXISTS (SELECT 1
                 FROM pg_catalog.jsonb_to_recordset(p_events)
                        AS x(uid text, start_date date, end_date date)
                WHERE x.uid IS NULL OR pg_catalog.length(x.uid) NOT BETWEEN 1 AND 255
                   OR x.start_date IS NULL OR x.end_date IS NULL
                   OR x.end_date <= x.start_date) THEN
      RAISE EXCEPTION 'ical_apply_events_invalid' USING ERRCODE = 'check_violation';
    END IF;

    WITH i AS (
      SELECT DISTINCT ON (x.uid) x.uid, x.start_date, x.end_date
        FROM pg_catalog.jsonb_to_recordset(p_events) AS x(uid text, start_date date, end_date date)
       ORDER BY x.uid, x.start_date
    )
    SELECT pg_catalog.count(*),
           pg_catalog.count(*) FILTER (WHERE e.id IS NULL),
           pg_catalog.count(*) FILTER (WHERE e.id IS NOT NULL
                                         AND (NOT e.is_active OR e.start_date <> i.start_date
                                              OR e.end_date <> i.end_date))
      INTO v_total, v_added, v_updated
      FROM i
      LEFT JOIN public.external_calendar_events e
        ON e.source_id = v_src.id AND e.uid = i.uid;

    WITH i AS (
      SELECT DISTINCT ON (x.uid) x.uid, x.start_date, x.end_date
        FROM pg_catalog.jsonb_to_recordset(p_events) AS x(uid text, start_date date, end_date date)
       ORDER BY x.uid, x.start_date
    )
    INSERT INTO public.external_calendar_events AS e (
        id, workspace_id, property_id, source_id, uid, start_date, end_date, is_active,
        first_seen_at, last_seen_at)
      SELECT public.app_uuid_v7(), v_src.workspace_id, v_src.property_id, v_src.id, i.uid,
             i.start_date, i.end_date, true, v_now, v_now
        FROM i
      ON CONFLICT (source_id, uid) DO UPDATE
        SET start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date, is_active = true,
            last_seen_at = v_now;

    -- Bu senkronda görülmeyen olaylar (last_seen_at eski kaldı) yalnız BU kaynakta pasifleşir.
    UPDATE public.external_calendar_events e
       SET is_active = false
     WHERE e.source_id = v_src.id AND e.is_active AND e.last_seen_at < v_now;
    GET DIAGNOSTICS v_deact = ROW_COUNT;

    -- Bilgi amaçlı: bu kaynağın etkin olaylarından Kiraligim kayıtlarıyla çakışanların sayısı.
    SELECT pg_catalog.count(*) INTO v_conflicts
      FROM public.external_calendar_events e
     WHERE e.source_id = v_src.id AND e.is_active
       AND EXISTS (SELECT 1 FROM public.reservations r
                    WHERE r.property_id = v_src.property_id
                      AND r.workspace_id = v_src.workspace_id
                      AND r.status IN ('pending', 'confirmed')
                      AND r.check_in < e.end_date AND r.check_out > e.start_date);

    UPDATE public.external_calendar_sources s
       SET status = 'ok', last_synced_at = v_now, last_success_at = v_now,
           last_error_code = NULL, consecutive_failures = 0,
           event_count = v_total, conflict_count = v_conflicts,
           locked_until = NULL, lock_token = NULL
     WHERE s.id = v_src.id;
    INSERT INTO public.external_calendar_sync_runs (
        id, workspace_id, source_id, trigger, started_at, finished_at, outcome,
        events_total, events_added, events_updated, events_deactivated)
      VALUES (public.app_uuid_v7(), v_src.workspace_id, v_src.id, p_trigger, p_started_at, v_now,
              'ok', v_total, v_added, v_updated, v_deact);
    outcome := 'ok';
  END IF;

  -- Kaynak başına son 20 senkron kaydı tutulur.
  DELETE FROM public.external_calendar_sync_runs x
   WHERE x.source_id = v_src.id
     AND x.id NOT IN (SELECT y.id FROM public.external_calendar_sync_runs y
                       WHERE y.source_id = v_src.id
                       ORDER BY y.finished_at DESC, y.id DESC LIMIT 20);

  PERFORM pg_catalog.set_config('app.ical_sync', coalesce(v_prev, ''), true);
  events_total := v_total;
  events_added := v_added;
  events_updated := v_updated;
  events_deactivated := v_deact;
  conflict_count := v_conflicts;
  RETURN NEXT;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.ical_sync', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. Dışa aktarma akışı
-- ---------------------------------------------------------------------------
-- Belirteç geçerliyse (etkin işletme) en az bir satır döner: kayıt yoksa uid NULL olan tek satır
-- (akış boş ama geçerli). Geçersiz belirteçte hiç satır dönmez (uygulama 404 verir).
-- Yalnız reservations okunur (beklemede + onaylı rezervasyon ve bloklar; iptal hariç);
-- misafir/tutar/not kolonları okunmaz. Pencere: çıkışı son 30 günden sonra, girişi 3 yıl içinde.
CREATE FUNCTION public.app_ical_export(p_token text)
  RETURNS TABLE (calendar_name text, uid uuid, check_in text, check_out text,
                 created_at timestamptz, updated_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev text := pg_catalog.current_setting('app.ical_export', true);
  v_today date := (pg_catalog.now() AT TIME ZONE 'Europe/Istanbul')::date;
  v_prop uuid;
  v_ws uuid;
  v_name text;
  v_found boolean := false;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{43}$' THEN
    RETURN;
  END IF;
  PERFORM pg_catalog.set_config('app.ical_export', 'on', true);
  SELECT x.property_id, x.workspace_id, p.name INTO v_prop, v_ws, v_name
    FROM public.property_ical_exports x
    JOIN public.properties p ON p.id = x.property_id AND p.workspace_id = x.workspace_id
    JOIN public.workspaces w ON w.id = x.workspace_id
   WHERE x.token = p_token AND w.status = 'active';
  IF v_prop IS NOT NULL THEN
    UPDATE public.property_ical_exports x
       SET last_fetched_at = pg_catalog.now()
     WHERE x.property_id = v_prop
       AND (x.last_fetched_at IS NULL OR x.last_fetched_at < pg_catalog.now() - interval '10 minutes');
    FOR calendar_name, uid, check_in, check_out, created_at, updated_at IN
      SELECT v_name, r.id, pg_catalog.to_char(r.check_in, 'YYYY-MM-DD'),
             pg_catalog.to_char(r.check_out, 'YYYY-MM-DD'), r.created_at, r.updated_at
        FROM public.reservations r
       WHERE r.property_id = v_prop AND r.workspace_id = v_ws
         AND r.status IN ('pending', 'confirmed')
         AND r.check_out > v_today - 30
         AND r.check_in < (v_today + interval '3 years')::date
       ORDER BY r.check_in, r.id
    LOOP
      v_found := true;
      RETURN NEXT;
    END LOOP;
    IF NOT v_found THEN
      calendar_name := v_name; uid := NULL; check_in := NULL; check_out := NULL;
      created_at := NULL; updated_at := NULL;
      RETURN NEXT;
    END IF;
  END IF;
  PERFORM pg_catalog.set_config('app.ical_export', coalesce(v_prev, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.ical_export', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 8. Public müsaitlik: harici doluluklar da dolu (imza ve dönüş aynı; 0024 tanımının yerine)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_public_villa_busy(p_property uuid, p_from date, p_to date)
  RETURNS TABLE (start_date text, end_date text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev text := pg_catalog.current_setting('app.public_read', true);
  v_today date := (pg_catalog.now() AT TIME ZONE 'Europe/Istanbul')::date;
  v_from date;
  v_to date;
BEGIN
  IF p_from IS NULL OR p_to IS NULL THEN
    RETURN;
  END IF;
  v_from := GREATEST(p_from, v_today - 1);
  v_to := LEAST(p_to, (v_today + interval '18 months')::date + 61);
  IF v_from >= v_to THEN
    RETURN;
  END IF;
  PERFORM pg_catalog.set_config('app.public_read', 'on', true);
  IF public.app_public_villa_visible(p_property) THEN
    RETURN QUERY
      WITH spans AS (
        SELECT pg_catalog.daterange(r.check_in, r.check_out, '[)') AS d
          FROM public.reservations r
         WHERE r.property_id = p_property
           AND r.status IN ('pending', 'confirmed')
           AND r.check_in < v_to AND r.check_out > v_from
        UNION ALL
        SELECT pg_catalog.daterange(e.start_date, e.end_date, '[)')
          FROM public.external_calendar_events e
          JOIN public.external_calendar_sources s
            ON s.id = e.source_id AND s.workspace_id = e.workspace_id
         WHERE e.property_id = p_property
           AND e.is_active AND s.is_active
           AND e.start_date < v_to AND e.end_date > v_from
      ), merged AS (
        SELECT pg_catalog.unnest(pg_catalog.range_agg(
                 sp.d * pg_catalog.daterange(v_from, v_to, '[)'))) AS b
          FROM spans sp
      )
      SELECT pg_catalog.to_char(pg_catalog.lower(m.b), 'YYYY-MM-DD'),
             pg_catalog.to_char(pg_catalog.upper(m.b), 'YYYY-MM-DD')
        FROM merged m
       WHERE NOT pg_catalog.isempty(m.b)
       ORDER BY pg_catalog.lower(m.b);
  END IF;
  PERFORM pg_catalog.set_config('app.public_read', coalesce(v_prev, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.public_read', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 9. EXECUTE yetkileri
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.app_ical_claim_sources(uuid, text, integer),
  public.app_ical_apply_sync(uuid, uuid, text, timestamptz, jsonb, text),
  public.app_ical_export(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_ical_claim_sources(uuid, text, integer),
  public.app_ical_apply_sync(uuid, uuid, text, timestamptz, jsonb, text),
  public.app_ical_export(text) TO app_user;
