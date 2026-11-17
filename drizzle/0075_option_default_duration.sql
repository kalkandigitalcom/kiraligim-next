-- 0075_option_default_duration (Opsiyon Faz A: varsayılan süre)
--
-- Süre önceliği: WhatsApp mesajında yazan süre → işletmenin varsayılanı → SİSTEM varsayılanı
-- (yeni; 24 saat, Super Admin değiştirir). Mesajda yazılı süre ASLA değiştirilmez / kısaltılmaz:
-- girişe taşarsa opsiyon açılmaz, işlem "açıklama bekliyor" olur. Varsayılan (işletme / sistem)
-- girişe taşarsa bitiş giriş anına (Europe/Istanbul 00:00) çekilir; girişe 60 dakikadan az
-- kalıyorsa açıklama bekler. Başlamış / geçmiş giriş otomatik işlenmez.
--
-- Değişenler:
--   1. option_automation_global: default_duration_minutes (NOT NULL, 1440, 60–20160) ve
--      default_duration_updated_at. Mevcut updated_at / updated_by_admin YALNIZ anahtarındır
--      (app_option_automation_since onu okur) ve süre değişikliğinde DEĞİŞMEZ.
--   2. expiry_source kısıtları (reservation_options, option_operations): + 'system_default'.
--   3. option_operations.mode kısıtı: + 'clarify' (açıklama bekliyor). Faz A'da yalnız WhatsApp
--      kaynaklı OLUŞTURMA "ask" kararları clarify olur; iptal / kesinleştirme "ask" kararları
--      needs_approval kalır. clarify işlemini hiçbir görev almaz (claim fonksiyonları yalnız
--      approved ve pending+auto+convert alır — DEĞİŞMEZ), Super Admin onaylayamaz
--      (app_option_admin_decide yalnız needs_approval kabul eder — DEĞİŞMEZ). Kapatma Faz C.
--   4. app_wa_option_apply: gövde 0069'dan birebir; yalnız süre bloğu, mod ifadesi ve uygulanan
--      oluşturmanın after_state'ine "clamped_to_check_in" eklenir. İmza, dönüş tipi, SECURITY
--      DEFINER, sahibi, sabit search_path ve yetkileri AYNI.
--   5. Yeni fonksiyonlar: app_option_admin_default_duration / app_option_admin_set_default_duration
--      (Super Admin, app_admin; admin_audit_log), app_option_owner_set_default (YALNIZ işletme
--      sahibi, app_user; audit_log). İşletme panelinde okuma mevcut RLS
--      politikalarıyla yapılır (option_automation_global: herkes; workspace_option_settings ve
--      option_operations: owner / manager, kendi işletmesi).
--
-- Veri: hiçbir mevcut satır güncellenmez / silinmez; mevcut opsiyon bitişleri ve bekleyen
-- işlemler (needs_approval) aynen kalır. Worker, ağ geçidi, ayrıştırıcı, rezervasyon, API, iCal,
-- webhook ve diğer tüm fonksiyonlar değişmez.
--
-- Geri alma: docs/rollback-0075.sql.

ALTER TABLE "option_operations" DROP CONSTRAINT "option_operations_mode_check";--> statement-breakpoint
ALTER TABLE "option_operations" DROP CONSTRAINT "option_operations_values";--> statement-breakpoint
ALTER TABLE "reservation_options" DROP CONSTRAINT "reservation_options_expiry";--> statement-breakpoint
ALTER TABLE "option_automation_global" ADD COLUMN "default_duration_minutes" integer DEFAULT 1440 NOT NULL;--> statement-breakpoint
ALTER TABLE "option_automation_global" ADD COLUMN "default_duration_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "option_automation_global" ADD CONSTRAINT "option_automation_global_default_duration" CHECK ("option_automation_global"."default_duration_minutes" between 60 and 20160);--> statement-breakpoint
ALTER TABLE "option_operations" ADD CONSTRAINT "option_operations_mode_check" CHECK ("option_operations"."mode" in ('auto', 'needs_approval', 'clarify'));--> statement-breakpoint
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
        and ("option_operations"."after_state" is null or (jsonb_typeof("option_operations"."after_state") = 'object' and pg_column_size("option_operations"."after_state") <= 4096)));--> statement-breakpoint
ALTER TABLE "reservation_options" ADD CONSTRAINT "reservation_options_expiry" CHECK (("reservation_options"."expires_at" is null) = ("reservation_options"."expiry_source" is null)
        and ("reservation_options"."expiry_source" is null or "reservation_options"."expiry_source" in ('message', 'workspace_default', 'manual', 'system_default')));
--> statement-breakpoint

-- Opsiyon karar fonksiyonu: süre zinciri ve "açıklama bekliyor" modu (gövde 0069 + işaretli farklar)
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
        -- Süre (Faz A, 0075): mesajda yazan → işletme varsayılanı → sistem varsayılanı. Mesajda
        -- yazılı süre ASLA değiştirilmez / kısaltılmaz: girişe taşarsa açıklama bekler. Varsayılan
        -- (işletme / sistem) girişe taşarsa bitiş giriş anına (Europe/Istanbul 00:00) çekilir;
        -- girişe 60 dakikadan az kalıyorsa açıklama bekler. Başlamış / geçmiş giriş otomatik
        -- işlenmez.
        IF v_minutes IS NOT NULL THEN
          v_source := 'message';
        ELSE
          SELECT s.default_duration_minutes INTO v_minutes FROM public.workspace_option_settings s
           WHERE s.workspace_id = m.workspace_id;
          IF v_minutes IS NOT NULL THEN
            v_source := 'workspace_default';
          ELSE
            SELECT o.default_duration_minutes INTO v_minutes FROM public.option_automation_global o
             WHERE o.id = 1;
            IF v_minutes IS NOT NULL THEN v_source := 'system_default'; END IF;
          END IF;
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
              ELSIF v_cap - pg_catalog.now() < interval '60 minutes' THEN
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
--> statement-breakpoint

-- Sistem varsayılan süresi ve son değişiklik zamanı (Super Admin ekranı).
CREATE FUNCTION public.app_option_admin_default_duration(p_admin uuid)
  RETURNS TABLE (minutes integer, updated_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev_opt text := pg_catalog.current_setting('app.option_fn', true);
BEGIN
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  PERFORM public.app_option_admin_check(p_admin);
  RETURN QUERY
    SELECT o.default_duration_minutes, o.default_duration_updated_at
      FROM public.option_automation_global o WHERE o.id = 1;
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- Sistem varsayılan süresi (dakika, 60–20160). Dönüş: changed | unchanged
CREATE FUNCTION public.app_option_admin_set_default_duration(p_admin uuid, p_minutes integer)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_opt text := pg_catalog.current_setting('app.option_fn', true);
  v_old integer;
  v_out text;
BEGIN
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  PERFORM public.app_option_admin_check(p_admin);
  IF p_minutes IS NULL OR p_minutes < 60 OR p_minutes > 20160 THEN
    RAISE EXCEPTION 'option_settings_invalid' USING ERRCODE = 'check_violation';
  END IF;
  SELECT o.default_duration_minutes INTO v_old FROM public.option_automation_global o
   WHERE o.id = 1 FOR UPDATE;
  IF v_old IS NOT DISTINCT FROM p_minutes THEN
    v_out := 'unchanged';
  ELSE
    -- updated_at / updated_by_admin anahtarındır: DEĞİŞMEZ (otomasyon başlangıcını etkilemez).
    UPDATE public.option_automation_global
       SET default_duration_minutes = p_minutes, default_duration_updated_at = pg_catalog.now()
     WHERE id = 1;
    INSERT INTO public.admin_audit_log (id, admin_id, action, target_type, target_id, metadata)
    VALUES (pg_catalog.gen_random_uuid(), p_admin, 'option.default_duration_system',
            'option_settings', NULL,
            pg_catalog.jsonb_build_object('from', v_old, 'to', p_minutes));
    v_out := 'changed';
  END IF;
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RETURN v_out;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- İşletmenin varsayılan süresi (dakika; null = sistem varsayılanını kullan). YALNIZ işletme
-- sahibi (owner; yönetici değil), yalnız kendi (bağlamdaki, aktif) işletmesi. Super Admin'in
-- girdiği süre seçenekleri ve eski anahtar sütunu korunur; seçenek listesi boş değilse varsayılan
-- listeden olmalı. Dönüş: changed | unchanged
CREATE FUNCTION public.app_option_owner_set_default(p_minutes integer) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_prev_opt text := pg_catalog.current_setting('app.option_fn', true);
  v_ws uuid := public.app_current_workspace_id();
  v_user uuid := public.app_current_user_id();
  v_found boolean;
  v_old integer;
  v_choices integer[];
  v_out text;
BEGIN
  -- app.wa_fn: rol denetimi (app_current_member_role) işletmenin durumunu okur.
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  IF v_user IS NULL OR v_ws IS NULL OR coalesce(public.app_current_member_role(), '') <> 'owner' THEN
    RAISE EXCEPTION 'option_owner_forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_minutes IS NOT NULL AND (p_minutes < 60 OR p_minutes > 20160) THEN
    RAISE EXCEPTION 'option_settings_invalid' USING ERRCODE = 'check_violation';
  END IF;
  SELECT x.default_duration_minutes, x.duration_choices INTO v_old, v_choices
    FROM public.workspace_option_settings x WHERE x.workspace_id = v_ws FOR UPDATE;
  v_found := FOUND;
  IF p_minutes IS NOT NULL AND v_found AND pg_catalog.cardinality(v_choices) > 0
     AND NOT (p_minutes = ANY (v_choices)) THEN
    RAISE EXCEPTION 'option_settings_invalid' USING ERRCODE = 'check_violation';
  END IF;
  IF v_old IS NOT DISTINCT FROM p_minutes THEN
    v_out := 'unchanged';
  ELSE
    INSERT INTO public.workspace_option_settings AS x
      (workspace_id, default_duration_minutes, updated_at, updated_by_admin)
    VALUES (v_ws, p_minutes, pg_catalog.now(), NULL)
    ON CONFLICT (workspace_id) DO UPDATE
      SET default_duration_minutes = EXCLUDED.default_duration_minutes,
          updated_at = EXCLUDED.updated_at, updated_by_admin = NULL;
    INSERT INTO public.audit_log (id, workspace_id, actor_user_id, action, target_type,
                                  target_id, metadata)
    VALUES (pg_catalog.gen_random_uuid(), v_ws, v_user, 'option.default_duration_changed',
            'workspace', v_ws,
            pg_catalog.jsonb_build_object('from', v_old, 'to', p_minutes));
    v_out := 'changed';
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RETURN v_out;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_option_admin_default_duration(uuid),
  public.app_option_admin_set_default_duration(uuid, integer),
  public.app_option_owner_set_default(integer) FROM PUBLIC;
--> statement-breakpoint
-- Super Admin fonksiyonları YALNIZ app_admin; işletme sahibi fonksiyonu YALNIZ app_user
-- (oturum bağlamı withTenant). Ağ geçidi ve worker rollerine verilmez.
GRANT EXECUTE ON FUNCTION public.app_option_admin_default_duration(uuid),
  public.app_option_admin_set_default_duration(uuid, integer) TO app_admin;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_option_owner_set_default(integer) TO app_user;
