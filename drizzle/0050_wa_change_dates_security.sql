-- 0050_wa_change_dates_security (WhatsApp tarih değiştirme: eski aralığın kaydı)
--
-- 0049 wa_calendar_proposals tablosuna old_check_in / old_check_out kolonlarını ve 'change'
-- eylemini ekledi. Bu dosya yalnız worker'ın yazım fonksiyonunu günceller (imza aynı):
--   app_wa_store_proposals : öğedeki old_check_in / old_check_out alanlarını yazar; aynı villa,
--                            eylem ve aralıklarla bekleyen öneri varsa yeni öğe "superseded" olur
--                            (eski aralık da eşleşmeli).
-- app_user'a yeni kolonlar için UPDATE yetkisi VERİLMEZ: eski aralık yalnız mesajdan gelir.
-- Diğer her şey 0047'deki tanımla aynıdır.
--
-- Geri alma: fonksiyonu 0047'deki tanımına döndürün (önce 0049'u geri almak gerekmez; eski
--   tanım yeni kolonları boş bırakır).

CREATE OR REPLACE FUNCTION public.app_wa_store_proposals(p_message uuid, p_token uuid, p_items jsonb)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_prev_cal text := pg_catalog.current_setting('app.wa_calendar', true);
  v_now timestamptz := pg_catalog.clock_timestamp();
  m record;
  g record;
  it jsonb;
  v_group uuid;
  v_hash text;
  v_role text;
  v_reasons text[];
  v_action text;
  v_prop uuid;
  v_res text;
  v_pstatus text;
  v_outside boolean;
  v_in date;
  v_out date;
  v_old_in date;
  v_old_out date;
  v_flags text[];
  v_status text;
  v_super uuid;
  v_cands uuid[];
  v_n integer := 0;
  v_rows integer;
  v_total integer;
  v_skip text;
BEGIN
  IF p_items IS NULL OR pg_catalog.jsonb_typeof(p_items) <> 'array'
     OR pg_catalog.jsonb_array_length(p_items) > 10 THEN
    RAISE EXCEPTION 'wa_store_invalid' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  PERFORM pg_catalog.set_config('app.wa_calendar', 'on', true);

  -- Kilit sırası: grup → mesaj (app_wa_unlink_group ile aynı sıra; kilitlenme yok).
  SELECT x.group_id INTO v_group FROM public.wa_inbound_messages x WHERE x.id = p_message;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wa_claim_lost' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT gg.id, gg.workspace_id, gg.property_id, gg.status INTO g
    FROM public.wa_groups gg WHERE gg.id = v_group FOR SHARE;

  SELECT * INTO m FROM public.wa_inbound_messages x WHERE x.id = p_message FOR UPDATE;
  IF NOT FOUND OR m.status <> 'processing' OR m.lock_token IS DISTINCT FROM p_token
     OR m.locked_until <= v_now OR m.group_id IS DISTINCT FROM v_group THEN
    RAISE EXCEPTION 'wa_claim_lost' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  -- Grup hâlâ bu işletmeye bağlı ve işletme aktif mi?
  IF g.id IS NULL OR g.status <> 'linked' OR g.workspace_id IS DISTINCT FROM m.workspace_id
     OR NOT EXISTS (SELECT 1 FROM public.workspaces w
                     WHERE w.id = m.workspace_id AND w.status = 'active') THEN
    v_skip := 'group_not_linked';
  ELSIF g.property_id IS NULL THEN
    v_skip := 'group_without_villa';
  ELSE
    -- B aşaması: engellenmemiş ve numarası belirlenebilen her grup katılımcısı yetkilidir.
    v_skip := public.app_wa_sender_block(m.group_id, m.sender_pn);
    v_hash := public.app_wa_phone_hash(m.sender_pn);
    v_role := coalesce(public.app_wa_sender_role(m.workspace_id, v_hash), 'participant');
  END IF;
  IF v_skip IS NOT NULL THEN
    UPDATE public.wa_inbound_messages x
       SET status = 'ignored', processed_at = v_now, lock_token = NULL, locked_until = NULL,
           last_error = v_skip
     WHERE x.id = m.id;
    PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
    PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
    RETURN 0;
  END IF;

  FOR it IN SELECT e FROM pg_catalog.jsonb_array_elements(p_items) e LOOP
    v_action := it->>'action';
    v_prop := (it->>'property_id')::uuid;
    v_res := it->>'villa_resolution';
    v_in := (it->>'check_in')::date;
    v_out := (it->>'check_out')::date;
    -- 0050: tarih değiştirme (action = 'change') için eski aralık; diğer eylemlerde boş kalır
    -- (wa_calendar_proposals_old_dates kısıtı denetler).
    v_old_in := (it->>'old_check_in')::date;
    v_old_out := (it->>'old_check_out')::date;
    v_flags := ARRAY(SELECT pg_catalog.jsonb_array_elements_text(coalesce(it->'flags', '[]'::jsonb)));
    v_reasons := ARRAY(SELECT pg_catalog.jsonb_array_elements_text(
                         coalesce(it->'review_reasons', '[]'::jsonb)));

    -- Villa: çözüm türü ile villa alanı tutarlı olmalı.
    IF (v_res IN ('named', 'single')) <> (v_prop IS NOT NULL) THEN
      RAISE EXCEPTION 'wa_store_invalid' USING ERRCODE = 'check_violation';
    END IF;
    IF v_prop IS NOT NULL THEN
      SELECT p.status INTO v_pstatus FROM public.properties p
       WHERE p.id = v_prop AND p.workspace_id = m.workspace_id;
      -- Başka işletmenin villası: bileşik yabancı anahtar aşağıda reddeder.
      IF FOUND THEN
        IF v_pstatus <> 'active' THEN
          RAISE EXCEPTION 'wa_context_changed' USING ERRCODE = 'object_not_in_prerequisite_state';
        END IF;
        v_outside := g.property_id IS NOT NULL AND v_prop <> g.property_id;
        IF v_res = 'single' AND v_prop IS DISTINCT FROM g.property_id THEN
          RAISE EXCEPTION 'wa_context_changed' USING ERRCODE = 'object_not_in_prerequisite_state';
        END IF;
        IF v_res = 'named' AND v_outside <> ('villa_outside_group' = ANY (v_flags)) THEN
          RAISE EXCEPTION 'wa_context_changed' USING ERRCODE = 'object_not_in_prerequisite_state';
        END IF;
        IF v_outside AND NOT ('villa_needs_review' = ANY (v_reasons)) THEN
          v_reasons := v_reasons || 'villa_needs_review'::text;
        END IF;
      END IF;
    END IF;

    v_cands := ARRAY(
      SELECT p.id FROM public.properties p
       WHERE p.workspace_id = m.workspace_id AND p.status = 'active'
         AND p.id IN (SELECT (pg_catalog.jsonb_array_elements_text(
                                coalesce(it->'candidate_property_ids', '[]'::jsonb)))::uuid)
       ORDER BY p.id);
    v_super := NULL;
    IF v_action IS NULL AND 'question' = ANY (v_flags) THEN
      v_status := 'noop';
    ELSE
      v_status := 'pending';
      IF v_action IS NOT NULL AND v_prop IS NOT NULL AND v_in IS NOT NULL AND v_out IS NOT NULL THEN
        SELECT pr.id INTO v_super FROM public.wa_calendar_proposals pr
         WHERE pr.workspace_id = m.workspace_id AND pr.status = 'pending'
           AND pr.property_id = v_prop AND pr.action = v_action
           AND pr.check_in = v_in AND pr.check_out = v_out
           AND pr.old_check_in IS NOT DISTINCT FROM v_old_in
           AND pr.old_check_out IS NOT DISTINCT FROM v_old_out
         ORDER BY pr.created_at, pr.id
         LIMIT 1;
        IF v_super IS NOT NULL THEN
          v_status := 'superseded';
        END IF;
      END IF;
    END IF;

    INSERT INTO public.wa_calendar_proposals AS pr (
      id, workspace_id, message_id, group_id, item_no, parser_version, message_excerpt, sent_at,
      sender_hash, sender_role, sender_verified, action, villa_name_raw, property_id, villa_resolution,
      candidate_property_ids, check_in, check_out, old_check_in, old_check_out, reservation_status,
      flags, conflicts, score,
      band, review_reasons, status, superseded_by)
    VALUES (
      public.app_uuid_v7(), m.workspace_id, m.id, m.group_id, (it->>'item_no')::smallint,
      (it->>'parser_version')::smallint, it->>'message_excerpt', m.sent_at,
      v_hash, v_role, v_role IN ('owner', 'manager'), v_action, it->>'villa_name_raw', v_prop, v_res,
      v_cands, v_in, v_out, v_old_in, v_old_out, it->>'reservation_status', v_flags,
      coalesce(it->'conflicts', '[]'::jsonb), (it->>'score')::smallint, it->>'band',
      v_reasons, v_status, v_super)
    ON CONFLICT (message_id, item_no) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_n := v_n + v_rows;
  END LOOP;

  SELECT pg_catalog.count(*)::integer INTO v_total FROM public.wa_calendar_proposals pr
   WHERE pr.message_id = m.id;
  UPDATE public.wa_inbound_messages x
     SET status = CASE WHEN v_total > 0 THEN 'processed' ELSE 'ignored' END,
         processed_at = v_now, lock_token = NULL, locked_until = NULL,
         last_error = CASE WHEN v_total > 0 THEN NULL ELSE 'no_proposal' END
   WHERE x.id = m.id;

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
