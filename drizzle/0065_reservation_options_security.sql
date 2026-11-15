-- 0065_reservation_options_security (Opsiyon Aşama 2: güvenlik, geçmiş ve gölge mod fonksiyonu)
--
-- Tablolar 0064'te. DEĞİŞMEZ: opsiyon yalnız Kiraligim içinde izlenir. Bu migration mevcut HİÇBİR
-- tabloya, politikaya, kısıta, tetikleyiciye veya fonksiyona dokunmaz; reservations,
-- external_calendar_events, iCal, API ve webhook akışları reservation_options'ı OKUMAZ.
--
--   1. ENABLE/FORCE RLS (üç tablo). app_user yalnız OKUR (işletme üyesi; gölge kararları yalnız
--      owner/manager). Aşama 2'de app_user'ın hiçbir tabloya yazma yetkisi yoktur; opsiyon yazan
--      fonksiyonlar sonraki aşamalarda gelir.
--   2. app_reservation_options_guard (BEFORE): ekleme yalnız "open"; yalnız open → son durum
--      geçişi; son durum ve kimlik alanları değiştirilemez; silme yasak; sona eriş zamanı, sürüm ve
--      zaman damgaları veritabanında yazılır. Yabancı anahtarın SET NULL eylemi (mesaj temizliği,
--      kullanıcı silme) kimlik dışı alanlara izinlidir.
--   3. app_reservation_options_history (AFTER, SECURITY DEFINER): her ekleme ve gerçek güncelleme
--      reservation_option_events'e yazılır; geçmiş append-only (app_reservation_option_events_guard).
--   4. app_wa_store_option_shadow(mesaj, öğeler) — worker (app_user). Gölge mod: yalnız
--      wa_option_shadow_decisions'a yazar. Mesaj son 30 dakikada işlenmiş, grup bağlı, işletme
--      aktif olmalı. Villa = grubun villası. Çakışma, açık opsiyon ve hedef opsiyon veritabanında
--      denetlenir; "apply" yalnız güvenli durumda kalır, aksi "ask". Mesaj + öğe numarasıyla
--      tekil (ON CONFLICT DO NOTHING): yeniden işlemede mükerrer kayıt yok. Opsiyon, rezervasyon,
--      blok veya tepki YAZMAZ.
--
-- Geri alma (opsiyon kaydı yoksa güvenli; bkz. docs/rollback-0064-0065.sql):
--   DROP FUNCTION app_wa_store_option_shadow(uuid, jsonb); DROP TABLE wa_option_shadow_decisions,
--   reservation_option_events, reservation_options; DROP FUNCTION app_reservation_options_guard(),
--   app_reservation_options_history(), app_reservation_option_events_guard().

-- ---------------------------------------------------------------------------
-- 1. RLS ve yetkiler
-- ---------------------------------------------------------------------------
ALTER TABLE public.reservation_options ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.reservation_options FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.reservation_option_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.reservation_option_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.wa_option_shadow_decisions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.wa_option_shadow_decisions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY reservation_options_select ON public.reservation_options FOR SELECT TO app_user
  USING (workspace_id = public.app_current_workspace_id()
         AND public.app_current_member_role() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY reservation_option_events_select ON public.reservation_option_events FOR SELECT TO app_user
  USING (workspace_id = public.app_current_workspace_id()
         AND public.app_current_member_role() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY wa_option_shadow_decisions_select ON public.wa_option_shadow_decisions FOR SELECT TO app_user
  USING (workspace_id = public.app_current_workspace_id()
         AND public.app_current_member_role() IN ('owner', 'manager'));
--> statement-breakpoint
-- Geçmiş tetikleyicisi (sahip app_migrator, app.option_fn bayrağı) yalnız EKLER.
CREATE POLICY reservation_option_events_history ON public.reservation_option_events
  FOR INSERT TO app_migrator
  WITH CHECK (pg_catalog.current_setting('app.option_fn', true) = 'on');
--> statement-breakpoint
-- Gölge mod fonksiyonu (app.wa_calendar): opsiyonları yalnız OKUR (hedef / çakışma denetimi).
CREATE POLICY reservation_options_wa_calendar_read ON public.reservation_options
  FOR SELECT TO app_migrator
  USING (pg_catalog.current_setting('app.wa_calendar', true) = 'on');
--> statement-breakpoint
CREATE POLICY wa_option_shadow_decisions_fn ON public.wa_option_shadow_decisions
  FOR ALL TO app_migrator
  USING (pg_catalog.current_setting('app.wa_fn', true) = 'on')
  WITH CHECK (pg_catalog.current_setting('app.wa_fn', true) = 'on');
--> statement-breakpoint
GRANT SELECT ON TABLE public.reservation_options, public.reservation_option_events,
  public.wa_option_shadow_decisions TO app_user;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Durum geçişleri (SECURITY INVOKER)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_reservation_options_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'option_delete_forbidden'
      USING ERRCODE = 'check_violation', DETAIL = 'Opsiyon silinemez; iptal edilir (geçmiş korunur).';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION 'option_insert_not_open'
        USING ERRCODE = 'check_violation', DETAIL = 'Opsiyon yalnız açık durumda oluşturulur.';
    END IF;
    NEW.version := 1;
    NEW.created_at := pg_catalog.now();
    NEW.updated_at := NEW.created_at;
    NEW.ended_at := NULL;
    RETURN NEW;
  END IF;

  -- Kimlik alanları hiçbir durumda değişmez.
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.property_id IS DISTINCT FROM OLD.property_id OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.group_id IS DISTINCT FROM OLD.group_id
     OR NEW.origin_wa_message_id IS DISTINCT FROM OLD.origin_wa_message_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (NEW.origin_message_id IS DISTINCT FROM OLD.origin_message_id AND NEW.origin_message_id IS NOT NULL)
     OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL) THEN
    RAISE EXCEPTION 'option_immutable_field'
      USING ERRCODE = 'check_violation', DETAIL = 'Opsiyonun kimlik alanları değiştirilemez.';
  END IF;

  -- Yabancı anahtar SET NULL (mesaj temizliği, kullanıcı silme): yalnız referans alanları NULL'a
  -- iner; durum ve içerik aynı kalır. Son durumdaki opsiyonda da izinlidir; sürüm değişmez.
  IF NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.check_in IS NOT DISTINCT FROM OLD.check_in AND NEW.check_out IS NOT DISTINCT FROM OLD.check_out
     AND NEW.expires_at IS NOT DISTINCT FROM OLD.expires_at
     AND NEW.expiry_source IS NOT DISTINCT FROM OLD.expiry_source
     AND NEW.guest_name IS NOT DISTINCT FROM OLD.guest_name AND NEW.note IS NOT DISTINCT FROM OLD.note
     AND NEW.converted_reservation_id IS NOT DISTINCT FROM OLD.converted_reservation_id
     AND NEW.ended_at IS NOT DISTINCT FROM OLD.ended_at
     AND NEW.end_reason IS NOT DISTINCT FROM OLD.end_reason
     AND NEW.version IS NOT DISTINCT FROM OLD.version
     AND (NEW.origin_message_id IS NOT DISTINCT FROM OLD.origin_message_id OR NEW.origin_message_id IS NULL)
     AND (NEW.ended_by_message_id IS NOT DISTINCT FROM OLD.ended_by_message_id OR NEW.ended_by_message_id IS NULL)
     AND (NEW.ended_by_user_id IS NOT DISTINCT FROM OLD.ended_by_user_id OR NEW.ended_by_user_id IS NULL)
     AND (NEW.updated_by IS NOT DISTINCT FROM OLD.updated_by OR NEW.updated_by IS NULL)
     AND (NEW.created_by IS NOT DISTINCT FROM OLD.created_by OR NEW.created_by IS NULL)
     AND (NEW.origin_message_id IS DISTINCT FROM OLD.origin_message_id
          OR NEW.ended_by_message_id IS DISTINCT FROM OLD.ended_by_message_id
          OR NEW.ended_by_user_id IS DISTINCT FROM OLD.ended_by_user_id
          OR NEW.updated_by IS DISTINCT FROM OLD.updated_by
          OR NEW.created_by IS DISTINCT FROM OLD.created_by) THEN
    RETURN NEW;
  END IF;

  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'option_final_immutable'
      USING ERRCODE = 'check_violation', DETAIL = 'Sonuçlanmış opsiyon değiştirilemez.';
  END IF;
  IF NEW.check_in IS DISTINCT FROM OLD.check_in OR NEW.check_out IS DISTINCT FROM OLD.check_out THEN
    RAISE EXCEPTION 'option_dates_immutable'
      USING ERRCODE = 'check_violation', DETAIL = 'Opsiyon tarihleri değişmez; iptal edilip yenisi açılır.';
  END IF;
  IF NEW.version IS DISTINCT FROM OLD.version THEN
    RAISE EXCEPTION 'option_version_conflict'
      USING ERRCODE = 'serialization_failure', DETAIL = 'Opsiyon başka bir işlemle değişti.';
  END IF;
  IF NEW.status <> 'open' THEN
    NEW.ended_at := pg_catalog.now();
  ELSE
    NEW.ended_at := NULL;
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_reservation_options_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER reservation_options_guard BEFORE INSERT OR UPDATE OR DELETE ON public.reservation_options
  FOR EACH ROW EXECUTE FUNCTION public.app_reservation_options_guard();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Geçmiş (append-only)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_reservation_options_history() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.option_fn', true);
  v_event text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.version = OLD.version THEN
    RETURN NULL; -- yalnız referans alanı NULL'a indi (yabancı anahtar eylemi): olay değil
  END IF;
  v_event := CASE
    WHEN TG_OP = 'INSERT' THEN 'created'
    WHEN NEW.status <> OLD.status THEN NEW.status
    ELSE 'updated'
  END;
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  INSERT INTO public.reservation_option_events
    (id, option_id, workspace_id, event, from_status, to_status, reason, actor_user_id, message_id,
     converted_reservation_id, version, created_at)
  VALUES
    (pg_catalog.gen_random_uuid(), NEW.id, NEW.workspace_id, v_event,
     CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status, NEW.end_reason,
     CASE WHEN TG_OP = 'INSERT' THEN NEW.created_by
          ELSE coalesce(NEW.ended_by_user_id, NEW.updated_by) END,
     CASE WHEN TG_OP = 'INSERT' THEN NEW.origin_message_id ELSE NEW.ended_by_message_id END,
     NEW.converted_reservation_id, NEW.version, pg_catalog.now());
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev, ''), true);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_reservation_options_history() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER reservation_options_history AFTER INSERT OR UPDATE ON public.reservation_options
  FOR EACH ROW EXECUTE FUNCTION public.app_reservation_options_history();
--> statement-breakpoint
-- Geçmiş değiştirilemez ve silinemez; yalnız yabancı anahtarın SET NULL eylemine izin verilir.
CREATE FUNCTION public.app_reservation_option_events_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.id = OLD.id AND NEW.option_id = OLD.option_id AND NEW.workspace_id = OLD.workspace_id
     AND NEW.event = OLD.event AND NEW.from_status IS NOT DISTINCT FROM OLD.from_status
     AND NEW.to_status = OLD.to_status AND NEW.reason IS NOT DISTINCT FROM OLD.reason
     AND NEW.converted_reservation_id IS NOT DISTINCT FROM OLD.converted_reservation_id
     AND NEW.version = OLD.version AND NEW.created_at = OLD.created_at
     AND (NEW.actor_user_id IS NOT DISTINCT FROM OLD.actor_user_id OR NEW.actor_user_id IS NULL)
     AND (NEW.message_id IS NOT DISTINCT FROM OLD.message_id OR NEW.message_id IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'option_history_immutable'
    USING ERRCODE = 'check_violation', DETAIL = 'Opsiyon geçmişi değiştirilemez.';
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_reservation_option_events_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER reservation_option_events_guard BEFORE UPDATE OR DELETE ON public.reservation_option_events
  FOR EACH ROW EXECUTE FUNCTION public.app_reservation_option_events_guard();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Gölge mod (worker)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_wa_store_option_shadow(p_message uuid, p_items jsonb) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_prev_cal text := pg_catalog.current_setting('app.wa_calendar', true);
  v_reasons_ok constant text[] := ARRAY[
    'question', 'negated', 'hedged', 'intent_conflict', 'intent_unclear', 'date_missing',
    'date_unclear', 'date_past', 'multiple_ranges', 'villa_unclear', 'duration_unclear',
    'duration_out_of_bounds', 'duration_after_check_in'];
  v_ws uuid;
  v_group uuid;
  v_prop uuid;
  it jsonb;
  v_no integer;
  v_parser integer;
  v_intent text;
  v_decision text;
  v_reasons text[];
  v_in date;
  v_out date;
  v_minutes integer;
  v_conflicts integer;
  v_open integer;
  v_target uuid;
  v_target_exp timestamptz;
  v_n integer := 0;
  v_k integer;
BEGIN
  IF p_message IS NULL OR p_items IS NULL OR pg_catalog.jsonb_typeof(p_items) <> 'array'
     OR pg_catalog.jsonb_array_length(p_items) > 20 THEN
    RAISE EXCEPTION 'wa_shadow_invalid' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  PERFORM pg_catalog.set_config('app.wa_calendar', 'on', true);

  SELECT m.workspace_id, m.group_id, g.property_id INTO v_ws, v_group, v_prop
    FROM public.wa_inbound_messages m
    JOIN public.wa_groups g ON g.id = m.group_id AND g.workspace_id = m.workspace_id
    JOIN public.workspaces w ON w.id = m.workspace_id
   WHERE m.id = p_message AND m.status IN ('processed', 'ignored')
     AND m.processed_at > pg_catalog.now() - interval '30 minutes'
     AND g.status = 'linked' AND w.status = 'active';

  IF v_ws IS NOT NULL THEN
    FOR it IN SELECT x FROM pg_catalog.jsonb_array_elements(p_items) AS t(x) LOOP
      v_no := (it->>'item_no')::integer;
      v_parser := (it->>'parser_version')::integer;
      v_intent := it->>'intent';
      v_decision := it->>'decision';
      v_reasons := ARRAY(SELECT pg_catalog.jsonb_array_elements_text(coalesce(it->'reasons', '[]'::jsonb)));
      v_in := (it->>'check_in')::date;
      v_out := (it->>'check_out')::date;
      v_minutes := (it->>'expires_in_minutes')::integer;
      IF v_no IS NULL OR v_no < 0 OR v_no > 19 OR v_parser IS NULL OR v_parser < 1
         OR v_intent IS NULL OR v_intent NOT IN ('create', 'convert', 'cancel', 'unknown')
         OR v_decision IS NULL OR v_decision NOT IN ('apply', 'ask', 'ignore')
         OR NOT (v_reasons <@ v_reasons_ok)
         OR ((v_in IS NULL) <> (v_out IS NULL)) OR (v_in IS NOT NULL AND v_out <= v_in)
         OR (v_minutes IS NOT NULL AND v_minutes <= 0) THEN
        RAISE EXCEPTION 'wa_shadow_invalid' USING ERRCODE = 'check_violation';
      END IF;
      v_conflicts := 0;
      v_open := 0;
      v_target := NULL;
      v_target_exp := NULL;

      IF v_decision <> 'ignore' THEN
        IF v_prop IS NULL THEN
          v_decision := 'ask';
          v_reasons := v_reasons || 'group_without_villa'::text;
        ELSE
          IF v_in IS NOT NULL THEN
            -- Kesin doluluk: beklemede / onaylı kayıtlar ve etkin harici olaylar (app_wa_busy ile aynı).
            SELECT count(*) INTO v_conflicts FROM (
              SELECT 1 FROM public.reservations r
               WHERE r.workspace_id = v_ws AND r.property_id = v_prop
                 AND r.status IN ('pending', 'confirmed')
                 AND r.check_in < v_out AND r.check_out > v_in
              UNION ALL
              SELECT 1 FROM public.external_calendar_events e
                JOIN public.external_calendar_sources s
                  ON s.id = e.source_id AND s.workspace_id = e.workspace_id
               WHERE e.workspace_id = v_ws AND e.property_id = v_prop
                 AND e.is_active AND s.is_active
                 AND e.start_date < v_out AND e.end_date > v_in) c;
          END IF;

          IF v_intent = 'create' THEN
            IF v_in IS NOT NULL THEN
              SELECT count(*) INTO v_open FROM public.reservation_options o
               WHERE o.workspace_id = v_ws AND o.property_id = v_prop AND o.status = 'open'
                 AND o.check_in < v_out AND o.check_out > v_in;
            END IF;
            IF v_conflicts > 0 THEN
              v_decision := 'ask';
              v_reasons := v_reasons || 'calendar_conflict'::text;
            END IF;
            IF v_open > 0 THEN
              v_decision := 'ask';
              v_reasons := v_reasons || 'option_overlap'::text;
            END IF;
          ELSIF v_intent IN ('convert', 'cancel') THEN
            IF v_in IS NOT NULL THEN
              SELECT count(*) INTO v_open FROM public.reservation_options o
               WHERE o.workspace_id = v_ws AND o.property_id = v_prop AND o.status = 'open'
                 AND o.check_in < v_out AND o.check_out > v_in;
              SELECT o.id, o.expires_at INTO v_target, v_target_exp FROM public.reservation_options o
               WHERE o.workspace_id = v_ws AND o.property_id = v_prop AND o.status = 'open'
                 AND o.check_in = v_in AND o.check_out = v_out
               ORDER BY o.created_at LIMIT 1;
              IF v_target IS NULL THEN
                SELECT o.id INTO v_target FROM public.reservation_options o
                 WHERE o.workspace_id = v_ws AND o.property_id = v_prop AND o.status <> 'open'
                   AND o.check_in = v_in AND o.check_out = v_out
                 ORDER BY o.updated_at DESC LIMIT 1;
                v_decision := 'ask';
                v_reasons := v_reasons
                  || CASE WHEN v_target IS NULL THEN 'no_open_option' ELSE 'option_not_open' END;
              END IF;
            ELSE
              -- Tarihsiz bildirim: yalnız bu gruptan açılmış açık opsiyonlar. "Tek açık opsiyon"
              -- kuralı henüz karara bağlı: bulunsa da en fazla "ask".
              SELECT count(*) INTO v_open FROM public.reservation_options o
               WHERE o.workspace_id = v_ws AND o.property_id = v_prop AND o.status = 'open'
                 AND o.group_id = v_group;
              v_decision := 'ask';
              IF v_open = 0 THEN
                v_reasons := v_reasons || 'no_open_option'::text;
              ELSIF v_open > 1 THEN
                v_reasons := v_reasons || 'multiple_open_options'::text;
              ELSE
                SELECT o.id, o.expires_at INTO v_target, v_target_exp FROM public.reservation_options o
                 WHERE o.workspace_id = v_ws AND o.property_id = v_prop AND o.status = 'open'
                   AND o.group_id = v_group;
                v_reasons := v_reasons || 'dateless_target_pending'::text;
              END IF;
            END IF;
            -- Süresi geçmiş (henüz kapatılmamış) opsiyon kesinleşmez / iptal edilmez.
            IF v_target_exp IS NOT NULL AND v_target_exp <= pg_catalog.now() THEN
              v_decision := 'ask';
              v_reasons := v_reasons || 'option_expired'::text;
            END IF;
            IF v_intent = 'convert' AND v_conflicts > 0 THEN
              v_decision := 'ask';
              v_reasons := v_reasons || 'calendar_conflict'::text;
            END IF;
          ELSE
            v_decision := 'ask';
          END IF;
        END IF;
      END IF;

      INSERT INTO public.wa_option_shadow_decisions
        (id, workspace_id, group_id, message_id, item_no, parser_version, intent, decision, reasons,
         property_id, check_in, check_out, expires_in_minutes, target_option_id, conflict_count,
         open_option_count)
      VALUES
        (pg_catalog.gen_random_uuid(), v_ws, v_group, p_message, v_no, v_parser, v_intent, v_decision,
         ARRAY(SELECT DISTINCT r FROM pg_catalog.unnest(v_reasons) r ORDER BY r)::text[],
         v_prop, v_in, v_out, v_minutes, v_target, LEAST(v_conflicts, 32767), LEAST(v_open, 32767))
      ON CONFLICT (message_id, item_no) DO NOTHING;
      GET DIAGNOSTICS v_k = ROW_COUNT;
      v_n := v_n + v_k;
    END LOOP;
  END IF;

  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  RETURN v_n;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_wa_store_option_shadow(uuid, jsonb) FROM PUBLIC;
--> statement-breakpoint
-- Worker uygulamanın bağlantısını (app_user) kullanır; ağ geçidi rolüne VERİLMEZ.
GRANT EXECUTE ON FUNCTION public.app_wa_store_option_shadow(uuid, jsonb) TO app_user;
