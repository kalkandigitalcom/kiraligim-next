-- Opsiyon 0077 (Faz B: WhatsApp'tan uzatma ve tarih değişikliği) — GERİ ALMA BETİĞİ
--
-- YALNIZ GEREKİRSE. Daha eski migration'ları da geri alacaksanız ÖNCE bu betiği, sonra
-- docs/rollback-0076.sql ve öncekileri çalıştırın.
-- app_migrator (veya süper kullanıcı) ile TEK transaction'da:
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f rollback-0077.sql
--
-- 0076 durumunu birebir geri getirir: app_wa_option_apply 0076 gövdesine, opsiyon tetikleyici
-- fonksiyonları 0067 gövdelerine döner; app_option_admin_option_links kaldırılır;
-- replaces_option_id (FK + tekil indeks) ve olaylardaki
-- expires_at sütunu kaldırılır; kind / end_reason kısıtları 0068 / 0075 / 0066 biçimine döner;
-- migration kaydı silinir. Tekrar çalıştırılabilir. Uygulama kodunu da önceki sürüme döndürün.
--
-- VERİ KORUMASI: Faz B verisi varsa (extend / reschedule işlemi, date_changed nedeni ya da
-- replaces_option_id dolu opsiyon) betik HİÇBİR ŞEY DEĞİŞTİRMEDEN durur (rollback_0077_blocked_data):
-- bu kayıtlar 0076 kısıtlarına sığmaz ve silinmemelidir. O durumda yalnız uygulama kodunu geri
-- alın: 0076 kodu extend / reschedule öğesi göndermez, 0077 fonksiyonu oluşturma / iptal /
-- kesinleştirmeyi 0076 ile aynı işler. Denetim kayıtları (audit_log, değiştirilemez) korunur;
-- Faz B kaydı yoksa option.extended / option.rescheduled denetim kaydı da yoktur. Olaylardaki expires_at anlık görüntüsü (yalnız denetim
-- bilgisi) silinir; opsiyonların kendi bitişleri değişmez.

-- 0. Güvenlik kontrolleri: 0077 sonrası migration uygulanmışsa önce onlar geri alınmalı; Faz B
--    verisi varsa durulur.
DO $$
DECLARE
  v_later boolean := false;
  v_prev text := pg_catalog.current_setting('app.option_fn', true);
  v_ops bigint := 0;
  v_opts bigint := 0;
  v_events bigint := 0;
BEGIN
  IF pg_catalog.to_regclass('drizzle.__migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM drizzle.__migrations WHERE created_at > $1)'
      INTO v_later USING 1795226400000::bigint;
  END IF;
  IF v_later THEN
    RAISE EXCEPTION 'rollback_0077_blocked: 0077 sonrası migration uygulanmış'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- RLS: opsiyon tabloları yalnız fonksiyon bayrağıyla tümüyle okunur.
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  SELECT count(*) INTO v_ops FROM public.option_operations
   WHERE kind IN ('extend', 'reschedule') OR end_reason = 'date_changed';
  SELECT count(*) INTO v_events FROM public.reservation_option_events WHERE reason = 'date_changed';
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
              WHERE attrelid = 'public.reservation_options'::regclass
                AND attname = 'replaces_option_id' AND NOT attisdropped) THEN
    EXECUTE 'SELECT count(*) FROM public.reservation_options
              WHERE end_reason = ''date_changed'' OR replaces_option_id IS NOT NULL' INTO v_opts;
  ELSE
    SELECT count(*) INTO v_opts FROM public.reservation_options WHERE end_reason = 'date_changed';
  END IF;
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev, ''), true);
  IF v_ops + v_opts + v_events > 0 THEN
    RAISE EXCEPTION 'rollback_0077_blocked_data: Faz B kaydı var (işlem %, opsiyon %, olay %)',
      v_ops, v_opts, v_events
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END
$$;

-- 1. app_wa_option_apply: 0076 gövdesi (birebir).
CREATE OR REPLACE FUNCTION public.app_wa_option_apply(p_message uuid, p_items jsonb)
  RETURNS TABLE (item_no integer, operation_id uuid, status text, option_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_variable
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_prev_cal text := pg_catalog.current_setting('app.wa_calendar', true);
  v_prev_opt text := pg_catalog.current_setting('app.option_fn', true);
  v_prev_adm text := pg_catalog.current_setting('app.option_admin', true);
  v_reasons_ok constant text[] := ARRAY[
    'question', 'negated', 'hedged', 'intent_conflict', 'intent_unclear', 'date_missing',
    'date_unclear', 'date_past', 'multiple_ranges', 'villa_unclear', 'duration_unclear',
    'duration_out_of_bounds', 'duration_after_check_in'];
  m record;
  v_since timestamptz;
  v_prop_active boolean;
  it jsonb;
  v_no integer;
  v_intent text;
  v_decision text;
  v_reasons text[];
  v_in date;
  v_out date;
  v_minutes integer;
  v_source text;
  v_end text;
  v_adults integer;
  v_children integer;
  v_conflicts integer;
  v_open integer;
  v_target uuid;
  v_target_ver integer;
  v_target_exp timestamptz;
  v_target_guest text;
  v_target_adults integer;
  v_expires timestamptz;
  v_cap timestamptz;
  v_clamped boolean;
  v_opt uuid;
  v_op uuid;
  v_status text;
BEGIN
  IF p_message IS NULL OR p_items IS NULL OR pg_catalog.jsonb_typeof(p_items) <> 'array'
     OR pg_catalog.jsonb_array_length(p_items) > 20 THEN
    RAISE EXCEPTION 'option_items_invalid' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  PERFORM pg_catalog.set_config('app.wa_calendar', 'on', true);
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  PERFORM pg_catalog.set_config('app.option_admin', '', true);

  SELECT msg.id, msg.workspace_id, msg.group_id, msg.wa_message_id, msg.sent_at, msg.received_at,
         g.property_id
    INTO m
    FROM public.option_message_scans x
    JOIN public.wa_inbound_messages msg ON msg.id = x.message_id
    JOIN public.wa_groups g ON g.id = msg.group_id AND g.workspace_id = msg.workspace_id
   WHERE x.message_id = p_message AND x.status = 'claimed'
     AND msg.status IN ('processed', 'ignored')
   FOR UPDATE OF x;
  IF m.id IS NOT NULL THEN
    v_since := public.app_option_automation_since(m.group_id);
    SELECT p.status = 'active' INTO v_prop_active FROM public.properties p
     WHERE p.id = m.property_id AND p.workspace_id = m.workspace_id;
  END IF;

  IF m.id IS NOT NULL AND v_since IS NOT NULL AND m.received_at >= v_since
     AND m.property_id IS NOT NULL THEN
    FOR it IN SELECT x FROM pg_catalog.jsonb_array_elements(p_items) AS t(x) LOOP
      v_no := (it->>'item_no')::integer;
      v_intent := it->>'intent';
      v_decision := it->>'decision';
      v_reasons := ARRAY(SELECT pg_catalog.jsonb_array_elements_text(coalesce(it->'reasons', '[]'::jsonb)));
      v_in := (it->>'check_in')::date;
      v_out := (it->>'check_out')::date;
      v_minutes := (it->>'expires_in_minutes')::integer;
      v_end := it->>'end_reason';
      v_adults := (it->>'adults')::integer;
      v_children := (it->>'children')::integer;
      IF v_no IS NULL OR v_no < 0 OR v_no > 19
         OR v_intent IS NULL OR v_intent NOT IN ('create', 'cancel', 'convert', 'unknown')
         OR v_decision IS NULL OR v_decision NOT IN ('apply', 'ask', 'ignore')
         OR NOT (v_reasons <@ v_reasons_ok)
         OR ((v_in IS NULL) <> (v_out IS NULL)) OR (v_in IS NOT NULL AND v_out <= v_in)
         OR (v_minutes IS NOT NULL AND (v_minutes < 60 OR v_minutes > 20160))
         OR (v_end IS NOT NULL AND (v_intent <> 'cancel' OR v_end NOT IN ('customer_declined', 'owner_cancelled')))
         OR (v_adults IS NOT NULL AND (v_adults < 1 OR v_adults > 50))
         OR (v_children IS NOT NULL AND (v_children < 0 OR v_children > 50)) THEN
        RAISE EXCEPTION 'option_items_invalid' USING ERRCODE = 'check_violation';
      END IF;
      CONTINUE WHEN v_decision = 'ignore' OR v_intent = 'unknown';

      v_conflicts := 0; v_open := 0; v_target := NULL; v_target_ver := NULL; v_target_exp := NULL;
      v_target_guest := NULL; v_target_adults := NULL; v_expires := NULL; v_source := NULL;
      v_cap := NULL; v_clamped := false;
      v_opt := NULL; v_op := NULL;
      IF NOT coalesce(v_prop_active, false) THEN
        v_decision := 'ask'; v_reasons := v_reasons || 'property_inactive'::text;
      END IF;

      IF v_intent = 'create' THEN
        IF v_in IS NULL THEN
          v_decision := 'ask'; v_reasons := v_reasons || 'date_missing'::text;
        ELSE
          v_conflicts := public.app_option_conflict_count(m.workspace_id, m.property_id, v_in, v_out);
          SELECT count(*) INTO v_open FROM public.reservation_options o
           WHERE o.workspace_id = m.workspace_id AND o.property_id = m.property_id
             AND o.status = 'open' AND o.check_in < v_out AND o.check_out > v_in;
          IF v_conflicts > 0 THEN v_decision := 'ask'; v_reasons := v_reasons || 'calendar_conflict'::text; END IF;
          IF v_open > 0 THEN v_decision := 'ask'; v_reasons := v_reasons || 'option_overlap'::text; END IF;
        END IF;
        -- Süre (0076, sabit 24 saat): mesajda açıkça yazılan süre (değiştirilmez / kısaltılmaz;
        -- girişe taşarsa açıklama bekler) → yoksa SABİT 24 saat (sistem standardı). İşletme
        -- varsayılanı ve sistem varsayılanı ayarı artık okunmaz. Sabit süre girişe taşarsa bitiş
        -- giriş anına (Europe/Istanbul 00:00) çekilir; girişe 60 dakikadan az kalıyorsa açıklama
        -- bekler. Başlamış / geçmiş giriş otomatik işlenmez.
        IF v_minutes IS NOT NULL THEN
          v_source := 'message';
        ELSE
          v_minutes := 1440;
          v_source := 'system_default';
        END IF;
        IF v_minutes IS NULL THEN
          v_decision := 'ask'; v_reasons := v_reasons || 'duration_missing'::text;
        ELSE
          v_expires := m.sent_at + pg_catalog.make_interval(mins => v_minutes);
          IF v_in IS NOT NULL THEN
            v_cap := (v_in::timestamp AT TIME ZONE 'Europe/Istanbul');
            IF v_cap <= pg_catalog.now() THEN
              v_decision := 'ask'; v_reasons := v_reasons || 'date_past'::text;
            ELSIF v_expires > v_cap THEN
              IF v_source = 'message' THEN
                v_decision := 'ask'; v_reasons := v_reasons || 'duration_after_check_in'::text;
              -- 0076: gönderim anı saat kaymasıyla şimdiden ileride olsa da süre < 60 dk olmaz.
              ELSIF v_cap - GREATEST(pg_catalog.now(), m.sent_at) < interval '60 minutes' THEN
                v_decision := 'ask'; v_reasons := v_reasons || 'check_in_too_close'::text;
              ELSE
                v_expires := v_cap;
                v_clamped := true;
                v_minutes := pg_catalog.floor(pg_catalog.date_part('epoch', v_cap - m.sent_at) / 60)::integer;
              END IF;
            END IF;
          END IF;
          IF v_expires <= pg_catalog.now() THEN
            v_decision := 'ask'; v_reasons := v_reasons || 'option_expired'::text;
          END IF;
        END IF;
      ELSE
        -- İptal / kesinleştirme hedefi: tarih yazılıysa aynı villada birebir aynı tarihli açık
        -- opsiyon; tarihsizse aynı gruptan açılmış açık opsiyon. Tek aday olmalı.
        IF v_in IS NOT NULL THEN
          SELECT count(*) INTO v_open FROM public.reservation_options o
           WHERE o.workspace_id = m.workspace_id AND o.property_id = m.property_id
             AND o.status = 'open' AND o.check_in = v_in AND o.check_out = v_out;
        ELSE
          SELECT count(*) INTO v_open FROM public.reservation_options o
           WHERE o.workspace_id = m.workspace_id AND o.property_id = m.property_id
             AND o.status = 'open' AND o.group_id = m.group_id;
        END IF;
        IF v_open = 1 THEN
          SELECT o.id, o.version, o.expires_at, o.guest_name, o.adults, o.check_in, o.check_out
            INTO v_target, v_target_ver, v_target_exp, v_target_guest, v_target_adults, v_in, v_out
            FROM public.reservation_options o
           WHERE o.workspace_id = m.workspace_id AND o.property_id = m.property_id AND o.status = 'open'
             AND ((v_in IS NOT NULL AND o.check_in = v_in AND o.check_out = v_out)
                  OR (v_in IS NULL AND o.group_id = m.group_id))
           FOR UPDATE;
          IF v_target_exp IS NOT NULL AND v_target_exp <= pg_catalog.now() THEN
            v_decision := 'ask'; v_reasons := v_reasons || 'option_expired'::text;
          END IF;
        ELSIF v_open > 1 THEN
          v_decision := 'ask'; v_reasons := v_reasons || 'multiple_open_options'::text;
        ELSE
          v_decision := 'ask'; v_reasons := v_reasons || 'no_open_option'::text;
        END IF;
        IF v_intent = 'convert' THEN
          IF v_in IS NOT NULL THEN
            v_conflicts := public.app_option_conflict_count(m.workspace_id, m.property_id, v_in, v_out);
            IF v_conflicts > 0 THEN v_decision := 'ask'; v_reasons := v_reasons || 'calendar_conflict'::text; END IF;
          END IF;
          IF v_target IS NOT NULL AND (v_target_guest IS NULL OR coalesce(v_adults, v_target_adults) IS NULL) THEN
            v_decision := 'ask'; v_reasons := v_reasons || 'guest_info_missing'::text;
          END IF;
        END IF;
      END IF;
      IF pg_catalog.cardinality(v_reasons) > 0 THEN
        v_decision := 'ask';
      END IF;
      v_reasons := ARRAY(SELECT DISTINCT r FROM pg_catalog.unnest(v_reasons) r ORDER BY r);

      BEGIN
        IF v_intent = 'create' AND v_decision = 'apply' THEN
          v_opt := pg_catalog.gen_random_uuid();
          INSERT INTO public.reservation_options
            (id, workspace_id, property_id, source, group_id, origin_message_id, origin_wa_message_id,
             check_in, check_out, expires_at, expiry_source, adults, children)
          VALUES (v_opt, m.workspace_id, m.property_id, 'whatsapp', m.group_id, m.id, m.wa_message_id,
                  v_in, v_out, v_expires, v_source, v_adults, v_children);
          v_status := 'applied';
        ELSIF v_intent = 'cancel' AND v_decision = 'apply' THEN
          UPDATE public.reservation_options o
             SET status = 'cancelled', end_reason = coalesce(v_end, 'customer_declined'),
                 ended_by_message_id = m.id
           WHERE o.id = v_target;
          v_opt := v_target;
          v_status := 'applied';
        ELSE
          -- Onaya düşen işlem ya da kural gereği otomatik kesinleştirme adayı (uygulama 3e'de).
          v_status := 'pending';
        END IF;
        v_op := pg_catalog.gen_random_uuid();
        INSERT INTO public.option_operations
          (id, workspace_id, kind, mode, status, source, group_id, message_id, wa_message_id, item_no,
           property_id, check_in, check_out, sent_at, expires_in_minutes, expiry_source, end_reason,
           target_option_id, target_option_version, result_option_id, reasons, fingerprint,
           before_state, after_state, adults, children, applied_at)
        VALUES
          (v_op, m.workspace_id, v_intent,
           CASE WHEN v_decision = 'apply' THEN 'auto'
                WHEN v_intent = 'create' THEN 'clarify'
                ELSE 'needs_approval' END,
           v_status, 'whatsapp', m.group_id, m.id, m.wa_message_id, v_no, m.property_id, v_in, v_out,
           m.sent_at, v_minutes, v_source,
           CASE WHEN v_intent = 'cancel' THEN coalesce(v_end, 'customer_declined') END,
           v_target, v_target_ver,
           CASE WHEN v_status = 'applied' THEN v_opt END, v_reasons,
           public.app_option_fingerprint(m.workspace_id, m.property_id, v_in, v_out, v_target),
           pg_catalog.jsonb_build_object('conflicts', v_conflicts, 'open_options', v_open,
                                         'target_version', v_target_ver),
           CASE WHEN v_status = 'applied'
                THEN pg_catalog.jsonb_build_object('option', v_opt, 'status',
                       CASE WHEN v_intent = 'create' THEN 'open' ELSE 'cancelled' END)
                     || CASE WHEN v_clamped
                             THEN pg_catalog.jsonb_build_object('clamped_to_check_in', true)
                             ELSE '{}'::jsonb END END,
           v_adults, v_children,
           CASE WHEN v_status = 'applied' THEN pg_catalog.now() END);
      EXCEPTION WHEN unique_violation THEN
        -- Aynı mesaj + öğe zaten işlendi (ya da aynı mesaj opsiyon açtı): mükerrer yok.
        v_op := NULL; v_opt := NULL; v_status := 'exists';
      END;
      item_no := v_no; operation_id := v_op; status := v_status; option_id := v_opt;
      RETURN NEXT;
    END LOOP;
  END IF;

  UPDATE public.option_message_scans
     SET status = 'done', done_at = pg_catalog.now()
   WHERE message_id = p_message AND option_message_scans.status = 'claimed';

  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  PERFORM pg_catalog.set_config('app.option_admin', coalesce(v_prev_adm, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  PERFORM pg_catalog.set_config('app.option_admin', coalesce(v_prev_adm, ''), true);
  RAISE;
END
$$;

-- 2. Opsiyon tetikleyici fonksiyonları: 0067 gövdeleri (birebir). Tetikleyiciler aynen kalır.
CREATE OR REPLACE FUNCTION public.app_reservation_options_guard() RETURNS trigger
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

  IF NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.check_in IS NOT DISTINCT FROM OLD.check_in AND NEW.check_out IS NOT DISTINCT FROM OLD.check_out
     AND NEW.expires_at IS NOT DISTINCT FROM OLD.expires_at
     AND NEW.expiry_source IS NOT DISTINCT FROM OLD.expiry_source
     AND NEW.guest_name IS NOT DISTINCT FROM OLD.guest_name AND NEW.note IS NOT DISTINCT FROM OLD.note
     AND NEW.adults IS NOT DISTINCT FROM OLD.adults AND NEW.children IS NOT DISTINCT FROM OLD.children
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

CREATE OR REPLACE FUNCTION public.app_reservation_options_history() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.option_fn', true);
  v_event text;
  v_admin uuid := NULLIF(pg_catalog.current_setting('app.option_admin', true), '')::uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.version = OLD.version THEN
    RETURN NULL;
  END IF;
  v_event := CASE
    WHEN TG_OP = 'INSERT' THEN 'created'
    WHEN NEW.status <> OLD.status THEN NEW.status
    ELSE 'updated'
  END;
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  INSERT INTO public.reservation_option_events
    (id, option_id, workspace_id, event, from_status, to_status, reason, actor_user_id,
     actor_admin_id, message_id, converted_reservation_id, version, created_at)
  VALUES
    (pg_catalog.gen_random_uuid(), NEW.id, NEW.workspace_id, v_event,
     CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status, NEW.end_reason,
     CASE WHEN TG_OP = 'INSERT' THEN NEW.created_by
          ELSE coalesce(NEW.ended_by_user_id, NEW.updated_by) END,
     v_admin,
     CASE WHEN TG_OP = 'INSERT' THEN NEW.origin_message_id ELSE NEW.ended_by_message_id END,
     NEW.converted_reservation_id, NEW.version, pg_catalog.now());
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev, ''), true);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;

CREATE OR REPLACE FUNCTION public.app_reservation_option_events_guard() RETURNS trigger
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
     AND (NEW.actor_admin_id IS NOT DISTINCT FROM OLD.actor_admin_id OR NEW.actor_admin_id IS NULL)
     AND (NEW.message_id IS NOT DISTINCT FROM OLD.message_id OR NEW.message_id IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'option_history_immutable'
    USING ERRCODE = 'check_violation', DETAIL = 'Opsiyon geçmişi değiştirilemez.';
END
$$;

-- 3. Super Admin bağlantı fonksiyonu (0077'de eklendi).
DROP FUNCTION IF EXISTS public.app_option_admin_option_links(uuid, uuid);

-- 4. Şema: 0077'nin eklediği sütun, FK, indeks ve kısıt değerleri.
DROP INDEX IF EXISTS public.reservation_options_replaces_key;
ALTER TABLE public.reservation_options DROP CONSTRAINT IF EXISTS reservation_options_replaces_fk;
ALTER TABLE public.reservation_options DROP COLUMN IF EXISTS replaces_option_id;
ALTER TABLE public.reservation_option_events DROP COLUMN IF EXISTS expires_at;

ALTER TABLE public.option_operations DROP CONSTRAINT IF EXISTS option_operations_kind_check;
ALTER TABLE "option_operations" ADD CONSTRAINT "option_operations_kind_check" CHECK ("option_operations"."kind" in ('create', 'cancel', 'convert'));
ALTER TABLE public.option_operations DROP CONSTRAINT IF EXISTS option_operations_values;
ALTER TABLE "option_operations" ADD CONSTRAINT "option_operations_values" CHECK ("option_operations"."item_no" between 0 and 19 and "option_operations"."version" >= 1 and "option_operations"."attempts" >= 0
        and (("option_operations"."check_in" is null and "option_operations"."check_out" is null) or "option_operations"."check_out" > "option_operations"."check_in")
        and ("option_operations"."expires_in_minutes" is null or "option_operations"."expires_in_minutes" between 60 and 20160)
        and ("option_operations"."expiry_source" is null or "option_operations"."expiry_source" in ('message', 'workspace_default', 'manual', 'system_default'))
        and ("option_operations"."end_reason" is null or "option_operations"."end_reason" in ('payment_received', 'confirmed_in_panel', 'customer_declined', 'owner_cancelled', 'panel_cancel', 'expired'))
        and ("option_operations"."adults" is null or "option_operations"."adults" between 1 and 50)
        and ("option_operations"."children" is null or "option_operations"."children" between 0 and 50)
        and ("option_operations"."guest_name" is null or length(btrim("option_operations"."guest_name")) between 2 and 120)
        and ("option_operations"."decision_note" is null or length("option_operations"."decision_note") <= 500)
        and ("option_operations"."wa_message_id" is null or length("option_operations"."wa_message_id") between 1 and 128)
        and ("option_operations"."fingerprint" is null or "option_operations"."fingerprint" ~ '^[0-9a-f]{32}$')
        and ("option_operations"."failure_code" is null or "option_operations"."failure_code" ~ '^[a-z0-9_]{1,60}$')
        and cardinality("option_operations"."reasons") <= 20 and array_position("option_operations"."reasons", null) is null
        and (cardinality("option_operations"."reasons") = 0
             or array_to_string("option_operations"."reasons", ',') ~ '^[a-z_]{1,40}(,[a-z_]{1,40})*$')
        and ("option_operations"."before_state" is null or (jsonb_typeof("option_operations"."before_state") = 'object' and pg_column_size("option_operations"."before_state") <= 4096))
        and ("option_operations"."after_state" is null or (jsonb_typeof("option_operations"."after_state") = 'object' and pg_column_size("option_operations"."after_state") <= 4096)));
ALTER TABLE public.reservation_options DROP CONSTRAINT IF EXISTS reservation_options_end_state;
ALTER TABLE "reservation_options" ADD CONSTRAINT "reservation_options_end_state" CHECK (("reservation_options"."status" = 'open' and "reservation_options"."ended_at" is null and "reservation_options"."end_reason" is null
            and "reservation_options"."converted_reservation_id" is null and "reservation_options"."ended_by_message_id" is null
            and "reservation_options"."ended_by_user_id" is null)
        or ("reservation_options"."status" = 'converted' and "reservation_options"."ended_at" is not null and "reservation_options"."converted_reservation_id" is not null
            and "reservation_options"."end_reason" in ('payment_received', 'confirmed_in_panel'))
        or ("reservation_options"."status" = 'cancelled' and "reservation_options"."ended_at" is not null and "reservation_options"."converted_reservation_id" is null
            and "reservation_options"."end_reason" in ('customer_declined', 'owner_cancelled', 'panel_cancel'))
        or ("reservation_options"."status" = 'expired' and "reservation_options"."ended_at" is not null and "reservation_options"."converted_reservation_id" is null
            and "reservation_options"."expires_at" is not null and "reservation_options"."end_reason" in ('expired')));

-- 5. Migration kaydı: yeniden deploy'da tekrar uygulanır.
DO $$
BEGIN
  IF pg_catalog.to_regclass('drizzle.__migrations') IS NOT NULL THEN
    EXECUTE 'DELETE FROM drizzle.__migrations WHERE created_at = $1' USING 1795226400000::bigint;
  END IF;
END
$$;
