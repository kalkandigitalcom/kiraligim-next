CREATE TABLE "wa_calendar_worker_state" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"activated_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_calendar_worker_state_singleton" CHECK ("wa_calendar_worker_state"."id" = 1)
);
--> statement-breakpoint
-- 0037_wa_calendar_worker (WhatsApp Asistanı A2c: takvim worker'ı — güvenli ilk aktivasyon ve
-- yazım anında yeniden denetim)
--
-- 1. İLK AKTİVASYON: wa_calendar_worker_state tek satırı. Worker'ın ilk iş almasında
--    (app_wa_claim_messages) satır FOR UPDATE ile kilitlenir ve activated_at bir kez doldurulur;
--    aynı transaction'da kuyrukta bekleyen tüm mesajlar "ignored" (before_activation) olur.
--    Eşzamanlı ikinci worker kilidi bekler, aktivasyonu hazır bulur. Sonrasında alınan VE
--    gönderilen zamanı aktivasyondan önce olan her mesaj (ör. aktivasyonla eşzamanlı commit edilen
--    kayıt) da öneri üretmeden "ignored" olur. 0036'daki migration anı güvenli başlangıcı korunur;
--    bu kural migration ile worker'ın ilk çalışması arasındaki mesajları da kapsar.
-- 2. app_wa_claim_messages (aynı imza): aktivasyon + kilidi dolmuş 7 günden eski işler "ignored".
-- 3. app_wa_store_proposals (aynı imza): yazımdan HEMEN ÖNCE, aynı transaction'da yeniden denetim:
--    - kilit sırası grup (FOR SHARE) → mesaj (FOR UPDATE): app_wa_unlink_group grubu FOR UPDATE
--      ile kilitlediği için bağlantı kesme ile öneri yazımı sıralanır (kesme sonrası bekleyen
--      öneri kalmaz);
--    - kilit belirteci ve süresi;
--    - grup hâlâ bağlı ve aynı işletmede, işletme aktif (değilse mesaj ignored: group_not_linked);
--    - gönderen yetkisi (değilse ignored: sender_not_authorized; staff → staff_review_required);
--    - villa bu işletmede ve AKTİF; "single" yalnız grubun GÜNCEL villası; "named" önerinin
--      villa_outside_group bayrağı grubun güncel villasıyla tutarlı. Tutarsızlık (worker'ın
--      bağlamı eskidi) → 'wa_context_changed': hiçbir şey yazılmaz, worker mesajı yeniden dener;
--    - grup dışı villa önerisine 'villa_needs_review' nedeni veritabanında eklenir.
--
-- Geri alma: app_wa_claim_messages ve app_wa_store_proposals'ı 0036'daki tanımlarına döndürün;
--   DROP TABLE wa_calendar_worker_state.

-- Tek satır, RLS açılmadan önce eklenir (etkinleştirilmemiş durum).
INSERT INTO public.wa_calendar_worker_state (id, activated_at) VALUES (1, NULL);
--> statement-breakpoint
ALTER TABLE public.wa_calendar_worker_state ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.wa_calendar_worker_state FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE public.wa_calendar_worker_state FROM PUBLIC;
--> statement-breakpoint
-- Yalnız worker fonksiyonları (sahip app_migrator, app.wa_calendar bayrağı). app_user ve ağ
-- geçidi rolüne yetki yoktur.
CREATE POLICY wa_calendar_worker_state_fn ON public.wa_calendar_worker_state FOR ALL TO app_migrator
  USING (pg_catalog.current_setting('app.wa_calendar', true) = 'on')
  WITH CHECK (pg_catalog.current_setting('app.wa_calendar', true) = 'on');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- İş alma: ilk aktivasyon + 0036 kuralları
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_wa_claim_messages(p_limit integer)
  RETURNS TABLE (message_id uuid, lock_token uuid, workspace_id uuid, group_id uuid,
                 group_property_id uuid, body text, sent_at timestamptz, sender_hash text,
                 sender_role text, sender_verified boolean, attempts integer)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_prev_cal text := pg_catalog.current_setting('app.wa_calendar', true);
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_activated timestamptz;
  r record;
  v_token uuid;
  v_hash text;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION 'wa_claim_invalid' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  PERFORM pg_catalog.set_config('app.wa_calendar', 'on', true);

  -- İlk aktivasyon (bir kez, atomik). Kilitsiz okuma hızlı yoldur; boşsa satır kilitlenip
  -- yeniden okunur (eşzamanlı worker bekler ve doldurulmuş değeri görür).
  SELECT s.activated_at INTO v_activated FROM public.wa_calendar_worker_state s WHERE s.id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wa_worker_state_missing' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_activated IS NULL THEN
    SELECT s.activated_at INTO v_activated FROM public.wa_calendar_worker_state s
     WHERE s.id = 1 FOR UPDATE;
    IF v_activated IS NULL THEN
      v_activated := v_now;
      UPDATE public.wa_calendar_worker_state s SET activated_at = v_now, updated_at = v_now
       WHERE s.id = 1;
      UPDATE public.wa_inbound_messages m
         SET status = 'ignored', processed_at = v_now, lock_token = NULL, locked_until = NULL,
             last_error = 'before_activation'
       WHERE m.status IN ('received', 'processing');
    END IF;
  END IF;

  UPDATE public.wa_inbound_messages m
     SET status = 'ignored', processed_at = v_now, lock_token = NULL, locked_until = NULL,
         last_error = CASE
           WHEN m.kind = 'backlog' THEN 'backlog'
           WHEN m.sent_at < v_now - interval '7 days' THEN 'too_old'
           WHEN m.received_at < v_activated OR m.sent_at < v_activated THEN 'before_activation'
           WHEN NOT EXISTS (
             SELECT 1 FROM public.wa_groups g
               JOIN public.workspaces w ON w.id = g.workspace_id
              WHERE g.id = m.group_id AND g.workspace_id = m.workspace_id
                AND g.status = 'linked' AND w.status = 'active') THEN 'group_not_linked'
           ELSE 'sender_not_authorized' END
   WHERE m.status = 'received'
     AND (m.kind = 'backlog' OR m.sent_at < v_now - interval '7 days'
          OR m.received_at < v_activated OR m.sent_at < v_activated
          OR NOT EXISTS (
            SELECT 1 FROM public.wa_groups g
              JOIN public.workspaces w ON w.id = g.workspace_id
             WHERE g.id = m.group_id AND g.workspace_id = m.workspace_id
               AND g.status = 'linked' AND w.status = 'active')
          OR public.app_wa_sender_role(m.workspace_id, public.app_wa_phone_hash(m.sender_pn)) IS NULL);

  UPDATE public.wa_inbound_messages m
     SET status = 'failed', processed_at = v_now, lock_token = NULL, locked_until = NULL,
         last_error = 'max_attempts'
   WHERE m.status = 'processing' AND m.locked_until <= v_now AND m.attempts >= 5;

  -- Kilidi dolmuş iş yeniden alınmadan önce yaş kuralı yeniden uygulanır.
  UPDATE public.wa_inbound_messages m
     SET status = 'ignored', processed_at = v_now, lock_token = NULL, locked_until = NULL,
         last_error = 'too_old'
   WHERE m.status = 'processing' AND m.locked_until <= v_now
     AND m.sent_at < v_now - interval '7 days';

  FOR r IN
    SELECT m.id, m.workspace_id, m.group_id, m.body, m.sent_at, m.sender_pn, m.attempts
      FROM public.wa_inbound_messages m
     WHERE (m.status = 'received' OR (m.status = 'processing' AND m.locked_until <= v_now))
       AND m.received_at >= v_activated AND m.sent_at >= v_activated
       AND m.sent_at >= v_now - interval '7 days'
     ORDER BY m.received_at, m.id
     LIMIT p_limit
     FOR UPDATE OF m SKIP LOCKED
  LOOP
    v_token := pg_catalog.gen_random_uuid();
    UPDATE public.wa_inbound_messages m
       SET status = 'processing', lock_token = v_token,
           locked_until = v_now + interval '120 seconds', attempts = m.attempts + 1
     WHERE m.id = r.id;
    v_hash := public.app_wa_phone_hash(r.sender_pn);
    message_id := r.id;
    lock_token := v_token;
    workspace_id := r.workspace_id;
    group_id := r.group_id;
    SELECT g.property_id INTO group_property_id FROM public.wa_groups g WHERE g.id = r.group_id;
    body := r.body;
    sent_at := r.sent_at;
    sender_hash := v_hash;
    sender_role := public.app_wa_sender_role(r.workspace_id, v_hash);
    sender_verified := sender_role IN ('owner', 'manager');
    attempts := r.attempts + 1;
    RETURN NEXT;
  END LOOP;

  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Öneri kaydı: yazım anında yeniden denetim
-- ---------------------------------------------------------------------------
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
  ELSE
    v_hash := public.app_wa_phone_hash(m.sender_pn);
    v_role := public.app_wa_sender_role(m.workspace_id, v_hash);
    IF v_role IS NULL THEN
      v_skip := 'sender_not_authorized';
    END IF;
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
    IF v_role = 'staff' AND NOT ('staff_review_required' = ANY (v_reasons)) THEN
      v_reasons := v_reasons || 'staff_review_required'::text;
    END IF;
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
      candidate_property_ids, check_in, check_out, reservation_status, flags, conflicts, score,
      band, review_reasons, status, superseded_by)
    VALUES (
      public.app_uuid_v7(), m.workspace_id, m.id, m.group_id, (it->>'item_no')::smallint,
      (it->>'parser_version')::smallint, it->>'message_excerpt', m.sent_at,
      v_hash, v_role, v_role IN ('owner', 'manager'), v_action, it->>'villa_name_raw', v_prop, v_res,
      v_cands, v_in, v_out, it->>'reservation_status', v_flags,
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
