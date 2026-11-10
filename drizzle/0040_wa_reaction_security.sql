-- 0040_wa_reaction_security (WhatsApp Asistanı A2f: mesaj tepkileri — güvenlik ve fonksiyonlar)
--
-- Amaç: worker'ın mesaj başına verdiği tepki kararı (✅ / ☑️ / ⚠️) kuyruğa yazılır; ağ geçidi
-- kendi bağlantısının tepkilerini alıp mesajın üzerine REACTION olarak gönderir (gruba metin
-- yazılmaz). Takvim ve öneriler bu tablodan hiç etkilenmez: tepki gönderilemese de hiçbir işlem
-- geri alınmaz.
--
--   1. ENABLE/FORCE RLS: app_user ve ağ geçidinin TABLO yetkisi yoktur; yalnız fonksiyonlar.
--   2. app_wa_queue_reaction(mesaj, tür) — worker (app_user). Kararı veritabanında YENİDEN DOĞRULAR:
--        * mesaj işlenmiş (processed) ve son 30 dakikada işlenmiş;
--        * grup hâlâ bağlı ve aynı işletmede, işletme aktif;
--        * gönderen işletmede owner veya manager (yetkisize tepki YOK);
--        * done (✅): mesajın en az bir önerisi OTOMATİK uygulanmış (quick) ve bekleyen öneri yok —
--          gerçek blok oluşmadan yeşil tik yazılamaz;
--        * submitted (☑️): mesajın bekleyen (pending) önerisi var;
--        * warning (⚠️): mesajın bekleyen veya uygulanmış önerisi var;
--      Mesaj başına tek satır (birincil anahtar): aynı mesaja ikinci tepki yazılmaz.
--   3. app_wa_claim_reactions(bağlantı, sınır) — ağ geçidi. Yalnız o bağlantının, bağlı grubun
--      tepkileri; FOR UPDATE SKIP LOCKED; 60 sn kilit; 24 saatten eski tepki "expired".
--   4. app_wa_finish_reaction(mesaj, kilit, başarı, kod) — ağ geçidi. Başarı → sent; hata → artan
--      bekleme ile yeniden (en fazla 5 deneme) → failed. Kilit belirteci uyuşmazsa hiçbir şey yazılmaz.
--
-- Döngü yok: ağ geçidi kendi gönderdiği tepkileri (fromMe, reactionMessage) zaten işlemez.
--
-- Geri alma: DROP FUNCTION app_wa_queue_reaction(uuid, text), app_wa_claim_reactions(uuid, integer),
--   app_wa_finish_reaction(uuid, uuid, boolean, text); DROP TABLE wa_message_reactions (0039).

ALTER TABLE public.wa_message_reactions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.wa_message_reactions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Yalnız fonksiyonlar (sahip app_migrator, app.wa_fn bayrağı). app_user ve ağ geçidine tablo yetkisi yok.
CREATE POLICY wa_message_reactions_fn ON public.wa_message_reactions FOR ALL TO app_migrator
  USING (pg_catalog.current_setting('app.wa_fn', true) = 'on')
  WITH CHECK (pg_catalog.current_setting('app.wa_fn', true) = 'on');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Kuyruğa yazma (worker)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_wa_queue_reaction(p_message uuid, p_kind text) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_prev_cal text := pg_catalog.current_setting('app.wa_calendar', true);
  v_ws uuid;
  v_ok boolean := false;
  v_role text;
  v_emoji text;
  v_n integer;
BEGIN
  v_emoji := CASE p_kind
    WHEN 'done' THEN U&'\2705'
    WHEN 'submitted' THEN U&'\2611\FE0F'
    WHEN 'warning' THEN U&'\26A0\FE0F'
  END;
  IF p_message IS NULL OR v_emoji IS NULL THEN
    RAISE EXCEPTION 'wa_reaction_invalid' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  PERFORM pg_catalog.set_config('app.wa_calendar', 'on', true);

  SELECT m.workspace_id, public.app_wa_sender_role(m.workspace_id, public.app_wa_phone_hash(m.sender_pn))
    INTO v_ws, v_role
    FROM public.wa_inbound_messages m
    JOIN public.wa_groups g ON g.id = m.group_id AND g.workspace_id = m.workspace_id
    JOIN public.workspaces w ON w.id = m.workspace_id
   WHERE m.id = p_message AND m.status = 'processed'
     AND m.processed_at > pg_catalog.now() - interval '30 minutes'
     AND g.status = 'linked' AND w.status = 'active';

  IF v_ws IS NOT NULL AND v_role IN ('owner', 'manager') THEN
    IF p_kind = 'done' THEN
      v_ok := EXISTS (SELECT 1 FROM public.wa_calendar_proposals pr
                       WHERE pr.message_id = p_message AND pr.status = 'applied'
                         AND pr.decision_mode = 'quick')
              AND NOT EXISTS (SELECT 1 FROM public.wa_calendar_proposals pr
                               WHERE pr.message_id = p_message AND pr.status = 'pending');
    ELSIF p_kind = 'submitted' THEN
      v_ok := EXISTS (SELECT 1 FROM public.wa_calendar_proposals pr
                       WHERE pr.message_id = p_message AND pr.status = 'pending');
    ELSE
      v_ok := EXISTS (SELECT 1 FROM public.wa_calendar_proposals pr
                       WHERE pr.message_id = p_message AND pr.status IN ('pending', 'applied'));
    END IF;
  END IF;

  IF NOT v_ok THEN
    PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
    PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
    RETURN 'rejected';
  END IF;

  INSERT INTO public.wa_message_reactions (message_id, workspace_id, kind, emoji)
  VALUES (p_message, v_ws, p_kind, v_emoji)
  ON CONFLICT (message_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  RETURN CASE WHEN v_n = 1 THEN 'queued' ELSE 'exists' END;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Gönderim için alma (ağ geçidi)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_wa_claim_reactions(p_connection uuid, p_limit integer)
  RETURNS TABLE (message_id uuid, lock_token uuid, group_jid text, wa_message_id text,
                 sender_jid text, emoji text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_now timestamptz := pg_catalog.clock_timestamp();
  r record;
  v_token uuid;
BEGIN
  IF p_connection IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 20 THEN
    RAISE EXCEPTION 'wa_reaction_claim_invalid' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);

  -- Eski tepki gönderilmez; tükenmiş ve kilidi dolmuş denemeler sonuçlandırılır.
  UPDATE public.wa_message_reactions x
     SET status = 'expired', lock_token = NULL, locked_until = NULL
   WHERE x.status IN ('pending', 'sending') AND x.created_at < v_now - interval '24 hours';
  UPDATE public.wa_message_reactions x
     SET status = 'failed', lock_token = NULL, locked_until = NULL, last_error = 'max_attempts'
   WHERE x.status = 'sending' AND x.locked_until <= v_now AND x.attempts >= 5;

  FOR r IN
    SELECT x.message_id AS mid, g.jid AS gjid, m.wa_message_id AS wid, m.sender_jid AS sjid,
           x.emoji AS em
      FROM public.wa_message_reactions x
      JOIN public.wa_inbound_messages m ON m.id = x.message_id
      JOIN public.wa_groups g ON g.id = m.group_id AND g.workspace_id = m.workspace_id
     WHERE m.connection_id = p_connection AND g.status = 'linked'
       AND ((x.status = 'pending' AND x.next_attempt_at <= v_now)
            OR (x.status = 'sending' AND x.locked_until <= v_now))
     ORDER BY x.created_at, x.message_id
     LIMIT p_limit
     FOR UPDATE OF x SKIP LOCKED
  LOOP
    v_token := pg_catalog.gen_random_uuid();
    UPDATE public.wa_message_reactions x
       SET status = 'sending', lock_token = v_token,
           locked_until = v_now + interval '60 seconds', attempts = x.attempts + 1
     WHERE x.message_id = r.mid;
    message_id := r.mid;
    lock_token := v_token;
    group_jid := r.gjid;
    wa_message_id := r.wid;
    sender_jid := r.sjid;
    emoji := r.em;
    RETURN NEXT;
  END LOOP;

  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Gönderim sonucu (ağ geçidi)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_wa_finish_reaction(p_message uuid, p_token uuid, p_ok boolean,
                                              p_error text) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_attempts integer;
  v_out text;
  v_err text := CASE WHEN p_error ~ '^[a-z0-9_]{1,60}$' THEN p_error ELSE 'send_error' END;
BEGIN
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  SELECT x.attempts INTO v_attempts FROM public.wa_message_reactions x
   WHERE x.message_id = p_message AND x.status = 'sending' AND x.lock_token = p_token
   FOR UPDATE;
  IF NOT FOUND THEN
    v_out := 'lost';
  ELSIF p_ok THEN
    UPDATE public.wa_message_reactions x
       SET status = 'sent', sent_at = pg_catalog.now(), lock_token = NULL, locked_until = NULL,
           last_error = NULL
     WHERE x.message_id = p_message;
    v_out := 'sent';
  ELSIF v_attempts >= 5 THEN
    UPDATE public.wa_message_reactions x
       SET status = 'failed', lock_token = NULL, locked_until = NULL, last_error = v_err
     WHERE x.message_id = p_message;
    v_out := 'failed';
  ELSE
    -- 30 sn, 1, 2, 4 dk… (en fazla 30 dk)
    UPDATE public.wa_message_reactions x
       SET status = 'pending', lock_token = NULL, locked_until = NULL, last_error = v_err,
           next_attempt_at = pg_catalog.now()
             + LEAST(interval '30 minutes', interval '30 seconds' * power(2, v_attempts - 1))
     WHERE x.message_id = p_message;
    v_out := 'retry';
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  RETURN v_out;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.app_wa_queue_reaction(uuid, text),
  public.app_wa_claim_reactions(uuid, integer),
  public.app_wa_finish_reaction(uuid, uuid, boolean, text) FROM PUBLIC;
--> statement-breakpoint
-- Worker uygulamanın bağlantısını (app_user) kullanır. Geliştirmede ağ geçidi de app_user'dır.
GRANT EXECUTE ON FUNCTION public.app_wa_queue_reaction(uuid, text),
  public.app_wa_claim_reactions(uuid, integer),
  public.app_wa_finish_reaction(uuid, uuid, boolean, text) TO app_user;
--> statement-breakpoint
-- Ayrı ağ geçidi rolü varsa (production: scripts/wa-gateway-role.sql) yalnız alma ve sonuç
-- fonksiyonları verilir; kuyruğa yazma (worker kararı) VERİLMEZ. Rol yoksa (test) atlanır.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_wa_gateway') THEN
    GRANT EXECUTE ON FUNCTION public.app_wa_claim_reactions(uuid, integer),
      public.app_wa_finish_reaction(uuid, uuid, boolean, text) TO app_wa_gateway;
  END IF;
END
$$;
