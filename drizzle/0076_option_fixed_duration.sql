-- 0076_option_fixed_duration (Opsiyon: sabit 24 saatlik opsiyon; ayar yolları kaldırılır)
--
-- Ürün kararı (17 Kasım 2026): villa kiralamada opsiyon süresi standart 24 saattir. Ev sahibi
-- yalnız WhatsApp'a yazar ("20-23 Aralık opsiyon"); süre belirtmesi gerekmez. İşletme bazında
-- varsayılan süre ve Super Admin'den süre değiştirme YOKTUR. Opsiyon yönetimi panelden yapılmaz.
--
-- Değişenler:
--   1. app_wa_option_apply: gövde 0075'ten birebir; YALNIZ süre bloğu: mesajda açıkça yazılan süre
--      (aynen; girişe taşarsa açıklama bekler) → yoksa sabit 24 saat ('system_default').
--      workspace_option_settings.default_duration_minutes ve
--      option_automation_global.default_duration_minutes artık OKUNMAZ. Girişe çekme, 60 dakika
--      kuralı, geçmiş giriş, açıklama bekleyen (clarify) modu ve diğer tüm denetimler aynen.
--      Düzeltme: 60 dakika kuralı şimdiki an ile gönderim anının büyüğüne göre ölçülür; gönderim
--      anı (saat kayması) şimdiden ileride olduğunda kısaltılan süre 60 dakikanın altına düşüp
--      işlem kısıtına takılmaz (0075'te mesaj işlenemez kalırdı).
--      İmza, dönüş tipi, SECURITY DEFINER, sahibi, sabit search_path ve yetkileri AYNI.
--   2. 0075'in süre ayarı fonksiyonları kaldırılır (veri tutmazlar):
--      app_option_owner_set_default, app_option_admin_set_default_duration,
--      app_option_admin_default_duration.
--
-- Değişmeyenler: hiçbir tablo, sütun, kısıt, indeks, politika, tetikleyici; hiçbir satır. Ayar
-- sütunları (workspace_option_settings.default_duration_minutes / duration_choices,
-- option_automation_global.default_duration_minutes / default_duration_updated_at) verisiyle
-- yerinde kalır, kullanılmaz; kaldırılmaları ayrı bir temizlik migration'ında, ayrı onayla.
-- Opsiyonlar, geçmiş, denetim kayıtları, bekleyen işlemler, worker, ağ geçidi, ayrıştırıcı,
-- rezervasyon, API, iCal ve webhook değişmez.
--
-- Geri alma: docs/rollback-0076.sql.

-- Opsiyon karar fonksiyonu: sabit 24 saat (gövde 0075 + işaretli süre bloğu)
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
--> statement-breakpoint
DROP FUNCTION public.app_option_owner_set_default(integer);
--> statement-breakpoint
DROP FUNCTION public.app_option_admin_set_default_duration(uuid, integer);
--> statement-breakpoint
DROP FUNCTION public.app_option_admin_default_duration(uuid);
