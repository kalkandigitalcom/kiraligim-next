-- 0069_option_operations_security (Opsiyon Aşama 3a: işlem, uyarı ve imleç güvenliği)
--
-- Tablolar 0068'de. Bu migration YALNIZ Opsiyon Sistemi nesnelerini ekler: mevcut hiçbir
-- fonksiyon yeniden tanımlanmaz; worker, ayrıştırıcı, otomatik kapat / aç / değiştir, tepki kuyruğu
-- (wa_message_reactions ve fonksiyonları), ağ geçidi, rezervasyon, API, iCal ve webhook akışları
-- DEĞİŞMEZ. Rezervasyon, blok, harici takvim ve mesaj tabloları yalnız OKUNUR (mevcut
-- app.wa_fn / app.wa_calendar okuma politikalarıyla); hiçbirine yazılmaz. WhatsApp'a tepki YOK
-- (K-A, K-B).
--
--   1. ENABLE/FORCE RLS: option_operations, option_conflict_alerts (app_user yalnız okur:
--      kendi işletmesinin owner/manager'ı), option_message_scans (kimse doğrudan erişemez).
--      Fonksiyonlar (sahip app_migrator) app.option_fn bayrağıyla yazar. reservation_options'a
--      ilk kez YAZMA politikası eklenir (yalnız bu bayrakla).
--   2. app_option_operations_guard: işlem silinemez; kimlik alanları değişmez; durum geçişleri
--      denetlenir (pending → approved | rejected | applied | stale | failed; approved → applied |
--      stale | failed); son durumlar değişmez (yalnız yabancı anahtarın SET NULL eylemi).
--   3. option-maintenance görevi (app_user; görev devre dışıyken hiçbiri çağrılmaz):
--        app_option_claim_messages   — işlenmiş mesajları OKUR (imleç: option_message_scans),
--        app_wa_option_apply         — oluştur / iptal (otomatik ya da Super Admin onayına),
--                                      kesinleştirme yalnız işlem kaydı (uygulama 3e),
--        app_option_expire_due       — süresi dolan açık opsiyon → expired (kill switch'ten bağımsız),
--        app_option_scan_conflicts   — açık opsiyonla çakışan kesin kayıt / harici olay uyarısı,
--        app_option_claim_operations / app_option_apply_operation / app_option_finish_operation
--                                    — onaylanan işlemleri parmak izini yeniden hesaplayarak uygular.
--   4. Super Admin (YALNIZ app_admin): app_option_admin_options, _operations, _option_events,
--      _alerts, _decide, _cancel. Onay işlemi yalnız "approved" yapar; uygulamayı görev yapar.
--
-- Geri alma: docs/rollback-0066-0069.sql.

-- ---------------------------------------------------------------------------
-- 1. RLS ve yetkiler
-- ---------------------------------------------------------------------------
ALTER TABLE public.option_operations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.option_operations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.option_conflict_alerts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.option_conflict_alerts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.option_message_scans ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.option_message_scans FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY option_operations_select ON public.option_operations FOR SELECT TO app_user
  USING (workspace_id = public.app_current_workspace_id()
         AND public.app_current_member_role() IN ('owner', 'manager'));
--> statement-breakpoint
CREATE POLICY option_conflict_alerts_select ON public.option_conflict_alerts FOR SELECT TO app_user
  USING (workspace_id = public.app_current_workspace_id()
         AND public.app_current_member_role() IN ('owner', 'manager'));
--> statement-breakpoint
CREATE POLICY option_operations_fn ON public.option_operations FOR ALL TO app_migrator
  USING (pg_catalog.current_setting('app.option_fn', true) = 'on')
  WITH CHECK (pg_catalog.current_setting('app.option_fn', true) = 'on');
--> statement-breakpoint
CREATE POLICY option_conflict_alerts_fn ON public.option_conflict_alerts FOR ALL TO app_migrator
  USING (pg_catalog.current_setting('app.option_fn', true) = 'on')
  WITH CHECK (pg_catalog.current_setting('app.option_fn', true) = 'on');
--> statement-breakpoint
CREATE POLICY option_message_scans_fn ON public.option_message_scans FOR ALL TO app_migrator
  USING (pg_catalog.current_setting('app.option_fn', true) = 'on')
  WITH CHECK (pg_catalog.current_setting('app.option_fn', true) = 'on');
--> statement-breakpoint
-- Opsiyon yazma: yalnız opsiyon fonksiyonları (app_user'ın tablo yetkisi yok; silme tetikleyiciyle yasak).
CREATE POLICY reservation_options_option_fn ON public.reservation_options FOR ALL TO app_migrator
  USING (pg_catalog.current_setting('app.option_fn', true) = 'on')
  WITH CHECK (pg_catalog.current_setting('app.option_fn', true) = 'on');
--> statement-breakpoint
CREATE POLICY reservation_option_events_option_read ON public.reservation_option_events
  FOR SELECT TO app_migrator
  USING (pg_catalog.current_setting('app.option_fn', true) = 'on');
--> statement-breakpoint
GRANT SELECT ON TABLE public.option_operations, public.option_conflict_alerts TO app_user;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. İşlem durum makinesi (SECURITY INVOKER)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_option_operations_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'option_operation_delete_forbidden' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('pending', 'applied', 'failed') THEN
      RAISE EXCEPTION 'option_operation_insert_status' USING ERRCODE = 'check_violation';
    END IF;
    NEW.version := 1;
    NEW.created_at := pg_catalog.now();
    NEW.updated_at := NEW.created_at;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.mode IS DISTINCT FROM OLD.mode
     OR NEW.source IS DISTINCT FROM OLD.source OR NEW.group_id IS DISTINCT FROM OLD.group_id
     OR NEW.wa_message_id IS DISTINCT FROM OLD.wa_message_id OR NEW.item_no IS DISTINCT FROM OLD.item_no
     OR NEW.property_id IS DISTINCT FROM OLD.property_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.sent_at IS DISTINCT FROM OLD.sent_at
     OR (NEW.message_id IS DISTINCT FROM OLD.message_id AND NEW.message_id IS NOT NULL) THEN
    RAISE EXCEPTION 'option_operation_immutable_field' USING ERRCODE = 'check_violation';
  END IF;
  -- Yabancı anahtar SET NULL (mesaj temizliği, rezervasyon / yönetici silme): başka alan değişmez.
  IF NEW.status = OLD.status AND NEW.version = OLD.version
     AND NEW.check_in IS NOT DISTINCT FROM OLD.check_in AND NEW.check_out IS NOT DISTINCT FROM OLD.check_out
     AND NEW.target_option_id IS NOT DISTINCT FROM OLD.target_option_id
     AND NEW.result_option_id IS NOT DISTINCT FROM OLD.result_option_id
     AND NEW.decided_at IS NOT DISTINCT FROM OLD.decided_at
     AND NEW.applied_at IS NOT DISTINCT FROM OLD.applied_at
     AND NEW.fingerprint IS NOT DISTINCT FROM OLD.fingerprint
     AND NEW.lock_token IS NOT DISTINCT FROM OLD.lock_token
     AND (NEW.result_reservation_id IS NOT DISTINCT FROM OLD.result_reservation_id OR NEW.result_reservation_id IS NULL)
     AND (NEW.decided_by_admin IS NOT DISTINCT FROM OLD.decided_by_admin OR NEW.decided_by_admin IS NULL)
     AND (NEW.message_id IS DISTINCT FROM OLD.message_id
          OR NEW.result_reservation_id IS DISTINCT FROM OLD.result_reservation_id
          OR NEW.decided_by_admin IS DISTINCT FROM OLD.decided_by_admin) THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('applied', 'rejected', 'stale', 'failed') THEN
    RAISE EXCEPTION 'option_operation_final' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version IS DISTINCT FROM OLD.version THEN
    RAISE EXCEPTION 'option_operation_version_conflict' USING ERRCODE = 'serialization_failure';
  END IF;
  IF NOT ((OLD.status = 'pending' AND NEW.status IN ('pending', 'approved', 'rejected', 'applied', 'stale', 'failed'))
          OR (OLD.status = 'approved' AND NEW.status IN ('approved', 'applied', 'stale', 'failed'))) THEN
    RAISE EXCEPTION 'option_operation_transition' USING ERRCODE = 'check_violation';
  END IF;
  -- Yalnız kilit alanları değiştiyse (claim) sürüm artmaz.
  IF NEW.status = OLD.status AND NEW.check_in IS NOT DISTINCT FROM OLD.check_in
     AND NEW.check_out IS NOT DISTINCT FROM OLD.check_out
     AND NEW.decided_at IS NOT DISTINCT FROM OLD.decided_at
     AND NEW.fingerprint IS NOT DISTINCT FROM OLD.fingerprint THEN
    NEW.updated_at := pg_catalog.now();
    RETURN NEW;
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_option_operations_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER option_operations_guard BEFORE INSERT OR UPDATE OR DELETE ON public.option_operations
  FOR EACH ROW EXECUTE FUNCTION public.app_option_operations_guard();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. İç yardımcılar (kimseye EXECUTE yok; yalnız aynı sahipli fonksiyonlar çağırır)
-- ---------------------------------------------------------------------------
-- Takvim parmak izi: aralıktaki beklemede / onaylı kayıtlar ve bloklar, etkin harici olaylar, açık
-- opsiyonlar ve hedef opsiyonun durumu + sürümü. Kişisel veri içermez (yalnız kimlik, tarih, sürüm).
-- Çağıranda app.wa_calendar ve app.option_fn açık olmalı.
CREATE FUNCTION public.app_option_fingerprint(p_ws uuid, p_property uuid, p_in date, p_out date,
    p_target uuid) RETURNS text
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.md5(pg_catalog.concat_ws('|',
    'r:' || coalesce((SELECT pg_catalog.string_agg(r.id::text || '/' || r.status || '/' || r.check_in
                               || '/' || r.check_out || '/' || r.updated_at::text, ',' ORDER BY r.id)
                        FROM public.reservations r
                       WHERE p_in IS NOT NULL AND r.workspace_id = p_ws AND r.property_id = p_property
                         AND r.status IN ('pending', 'confirmed')
                         AND r.check_in < p_out AND r.check_out > p_in), ''),
    'e:' || coalesce((SELECT pg_catalog.string_agg(e.id::text || '/' || e.start_date || '/' || e.end_date
                               || '/' || e.updated_at::text, ',' ORDER BY e.id)
                        FROM public.external_calendar_events e
                        JOIN public.external_calendar_sources s
                          ON s.id = e.source_id AND s.workspace_id = e.workspace_id
                       WHERE p_in IS NOT NULL AND e.workspace_id = p_ws AND e.property_id = p_property
                         AND e.is_active AND s.is_active
                         AND e.start_date < p_out AND e.end_date > p_in), ''),
    'o:' || coalesce((SELECT pg_catalog.string_agg(o.id::text || '/' || o.version, ',' ORDER BY o.id)
                        FROM public.reservation_options o
                       WHERE p_in IS NOT NULL AND o.workspace_id = p_ws AND o.property_id = p_property
                         AND o.status = 'open' AND o.check_in < p_out AND o.check_out > p_in), ''),
    't:' || coalesce((SELECT o.id::text || '/' || o.status || '/' || o.version
                        FROM public.reservation_options o WHERE o.id = p_target), '')))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_option_fingerprint(uuid, uuid, date, date, uuid) FROM PUBLIC;
--> statement-breakpoint
-- Kesin doluluk sayısı (beklemede / onaylı kayıt ve blok + etkin harici olay): app_wa_busy ile aynı.
CREATE FUNCTION public.app_option_conflict_count(p_ws uuid, p_property uuid, p_in date, p_out date)
  RETURNS integer
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT (SELECT count(*) FROM public.reservations r
           WHERE r.workspace_id = p_ws AND r.property_id = p_property
             AND r.status IN ('pending', 'confirmed') AND r.check_in < p_out AND r.check_out > p_in)::integer
       + (SELECT count(*) FROM public.external_calendar_events e
            JOIN public.external_calendar_sources s
              ON s.id = e.source_id AND s.workspace_id = e.workspace_id
           WHERE e.workspace_id = p_ws AND e.property_id = p_property AND e.is_active AND s.is_active
             AND e.start_date < p_out AND e.end_date > p_in)::integer
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_option_conflict_count(uuid, uuid, date, date) FROM PUBLIC;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. option-maintenance: mesaj okuma (K-D)
-- ---------------------------------------------------------------------------
-- Otomasyonu AÇIK grupların, otomasyon açıldıktan SONRA gelmiş, worker'ın son 24 saatte işlediği
-- (processed / ignored) ve 7 günden yeni mesajlarını imleçle alır. Mesajın durumuna DOKUNMAZ.
-- Kilidi 5 dakikadan eski "claimed" kayıt en fazla 3 kez yeniden alınır.
CREATE FUNCTION public.app_option_claim_messages(p_limit integer)
  RETURNS TABLE (message_id uuid, workspace_id uuid, group_id uuid, property_id uuid,
                 wa_message_id text, body text, sent_at timestamptz, attempts smallint)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_prev_opt text := pg_catalog.current_setting('app.option_fn', true);
  v_limit integer := LEAST(GREATEST(coalesce(p_limit, 0), 0), 50);
BEGIN
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  RETURN QUERY
  WITH cand AS (
    SELECT m.id, m.workspace_id, m.group_id, g.property_id, m.wa_message_id, m.body, m.sent_at,
           m.processed_at
      FROM public.wa_inbound_messages m
      JOIN public.wa_groups g ON g.id = m.group_id AND g.workspace_id = m.workspace_id
      LEFT JOIN public.option_message_scans x ON x.message_id = m.id
     WHERE m.status IN ('processed', 'ignored')
       AND m.processed_at > pg_catalog.now() - interval '24 hours'
       AND m.sent_at > pg_catalog.now() - interval '7 days'
       AND (x.message_id IS NULL
            OR (x.status = 'claimed' AND x.claimed_at < pg_catalog.now() - interval '5 minutes'
                AND x.attempts < 3))
       AND m.received_at >= public.app_option_automation_since(m.group_id)
     ORDER BY m.processed_at
     LIMIT v_limit
  ), claimed AS (
    INSERT INTO public.option_message_scans AS s (message_id, workspace_id, status, attempts, claimed_at)
    SELECT c.id, c.workspace_id, 'claimed', 1, pg_catalog.now() FROM cand c
    ON CONFLICT (message_id) DO UPDATE
       SET attempts = s.attempts + 1, claimed_at = pg_catalog.now()
     WHERE s.status = 'claimed' AND s.claimed_at < pg_catalog.now() - interval '5 minutes'
       AND s.attempts < 3
    RETURNING s.message_id, s.attempts
  )
  SELECT c.id, c.workspace_id, c.group_id, c.property_id, c.wa_message_id, c.body, c.sent_at,
         k.attempts
    FROM cand c JOIN claimed k ON k.message_id = c.id
   ORDER BY c.processed_at;
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. option-maintenance: mesajdan işlem (oluştur / iptal; kesinleştirme yalnız kayıt)
-- ---------------------------------------------------------------------------
-- p_items: decide.ts çıktısı (en fazla 20 öğe). Öğe: item_no, intent (create | cancel | convert |
-- unknown), decision (apply | ask | ignore), reasons (ayrıştırıcı / metin nedenleri), check_in,
-- check_out, expires_in_minutes, end_reason (iptal: customer_declined | owner_cancelled), adults,
-- children. Veritabanı her şeyi YENİDEN denetler ve "apply"ı gerekirse onaya düşürür; asla
-- yükseltmez. Mesaj claimed değilse veya otomasyon kapandıysa hiçbir işlem yazılmaz; imleç
-- "done" olur. unknown / ignore öğeleri işlem üretmez (mevcut ⚠️ ve gölge kayıt aynen kalır).
CREATE FUNCTION public.app_wa_option_apply(p_message uuid, p_items jsonb)
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
        -- Süre: mesajda yazan → işletme varsayılanı → yoksa onay (uydurulmaz).
        IF v_minutes IS NOT NULL THEN
          v_source := 'message';
        ELSE
          SELECT s.default_duration_minutes INTO v_minutes FROM public.workspace_option_settings s
           WHERE s.workspace_id = m.workspace_id;
          IF v_minutes IS NOT NULL THEN v_source := 'workspace_default'; END IF;
        END IF;
        IF v_minutes IS NULL THEN
          v_decision := 'ask'; v_reasons := v_reasons || 'duration_missing'::text;
        ELSE
          v_expires := m.sent_at + pg_catalog.make_interval(mins => v_minutes);
          IF v_in IS NOT NULL
             AND v_expires > (v_in::timestamp AT TIME ZONE 'Europe/Istanbul') THEN
            v_decision := 'ask'; v_reasons := v_reasons || 'duration_after_check_in'::text;
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
           CASE WHEN v_decision = 'apply' THEN 'auto' ELSE 'needs_approval' END,
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
                       CASE WHEN v_intent = 'create' THEN 'open' ELSE 'cancelled' END) END,
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

-- ---------------------------------------------------------------------------
-- 6. option-maintenance: süre dolumu ve çakışma uyarısı
-- ---------------------------------------------------------------------------
-- Süresi dolan açık opsiyon → expired. Kill switch'ten bağımsızdır (müsaitliği etkilemez).
CREATE FUNCTION public.app_option_expire_due(p_limit integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_opt text := pg_catalog.current_setting('app.option_fn', true);
  v_prev_adm text := pg_catalog.current_setting('app.option_admin', true);
  v_n integer;
BEGIN
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  PERFORM pg_catalog.set_config('app.option_admin', '', true);
  UPDATE public.reservation_options o
     SET status = 'expired', end_reason = 'expired'
   WHERE o.id IN (SELECT x.id FROM public.reservation_options x
                   WHERE x.status = 'open' AND x.expires_at IS NOT NULL
                     AND x.expires_at <= pg_catalog.now()
                   ORDER BY x.expires_at
                   LIMIT LEAST(GREATEST(coalesce(p_limit, 0), 0), 200)
                   FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  PERFORM pg_catalog.set_config('app.option_admin', coalesce(v_prev_adm, ''), true);
  RETURN v_n;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  PERFORM pg_catalog.set_config('app.option_admin', coalesce(v_prev_adm, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint
-- Açık opsiyonla çakışan beklemede / onaylı kayıt veya blok ve etkin harici olay → uyarı (idempotent).
-- Opsiyon ve rezervasyon DEĞİŞMEZ.
CREATE FUNCTION public.app_option_scan_conflicts(p_limit integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_cal text := pg_catalog.current_setting('app.wa_calendar', true);
  v_prev_opt text := pg_catalog.current_setting('app.option_fn', true);
  v_n integer;
BEGIN
  PERFORM pg_catalog.set_config('app.wa_calendar', 'on', true);
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  INSERT INTO public.option_conflict_alerts
    (id, workspace_id, option_id, property_id, source_kind, source_id)
  SELECT pg_catalog.gen_random_uuid(), c.workspace_id, c.option_id, c.property_id, c.kind, c.source_id
    FROM (
      SELECT o.workspace_id, o.id AS option_id, o.property_id, 'reservation'::text AS kind, r.id AS source_id
        FROM public.reservation_options o
        JOIN public.reservations r
          ON r.workspace_id = o.workspace_id AND r.property_id = o.property_id
         AND r.status IN ('pending', 'confirmed')
         AND r.check_in < o.check_out AND r.check_out > o.check_in
       WHERE o.status = 'open'
      UNION ALL
      SELECT o.workspace_id, o.id, o.property_id, 'external_event'::text, e.id
        FROM public.reservation_options o
        JOIN public.external_calendar_events e
          ON e.workspace_id = o.workspace_id AND e.property_id = o.property_id AND e.is_active
         AND e.start_date < o.check_out AND e.end_date > o.check_in
        JOIN public.external_calendar_sources s
          ON s.id = e.source_id AND s.workspace_id = e.workspace_id AND s.is_active
       WHERE o.status = 'open'
    ) c
   WHERE NOT EXISTS (SELECT 1 FROM public.option_conflict_alerts a
                      WHERE a.option_id = c.option_id AND a.source_kind = c.kind
                        AND a.source_id = c.source_id)
   LIMIT LEAST(GREATEST(coalesce(p_limit, 0), 0), 500)
  ON CONFLICT (option_id, source_kind, source_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RETURN v_n;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. option-maintenance: onaylanan / otomatik bekleyen işlemleri uygulama
-- ---------------------------------------------------------------------------
-- Alınabilir: Super Admin onaylı (approved) ya da kural gereği otomatik kesinleştirme adayı
-- (pending + auto + convert). Global kill switch kapalıysa veya WhatsApp grubunun otomasyonu
-- kapandıysa HİÇBİRİ alınmaz. 2 dakikalık kilit, en fazla 5 deneme.
CREATE FUNCTION public.app_option_claim_operations(p_limit integer)
  RETURNS TABLE (id uuid, lock_token uuid, kind text, workspace_id uuid, property_id uuid,
                 check_in date, check_out date, target_option_id uuid, target_option_version integer,
                 guest_name text, adults smallint, children smallint, attempts smallint)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev_opt text := pg_catalog.current_setting('app.option_fn', true);
BEGIN
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  RETURN QUERY
  UPDATE public.option_operations op
     SET lock_token = pg_catalog.gen_random_uuid(),
         locked_until = pg_catalog.now() + interval '2 minutes',
         attempts = op.attempts + 1
   WHERE op.id IN (
     SELECT x.id FROM public.option_operations x
      WHERE (x.status = 'approved' OR (x.status = 'pending' AND x.mode = 'auto' AND x.kind = 'convert'))
        AND (x.locked_until IS NULL OR x.locked_until < pg_catalog.now())
        AND x.attempts < 5
        AND EXISTS (SELECT 1 FROM public.option_automation_global g WHERE g.id = 1 AND g.enabled)
        AND (x.group_id IS NULL OR public.app_option_automation_enabled(x.group_id))
      ORDER BY x.created_at
      LIMIT LEAST(GREATEST(coalesce(p_limit, 0), 0), 20)
      FOR UPDATE SKIP LOCKED)
  RETURNING op.id, op.lock_token, op.kind, op.workspace_id, op.property_id, op.check_in,
            op.check_out, op.target_option_id, op.target_option_version, op.guest_name, op.adults,
            op.children, op.attempts;
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint
-- Alınmış OLUŞTUR / İPTAL işlemini uygular. Takvim parmak izi karar anındakiyle aynı değilse
-- uygulanmaz (stale). Kesinleştirme burada uygulanmaz ('convert_requires_service'; 3e).
-- Dönüş: applied | stale | failed | lost | convert_requires_service
CREATE FUNCTION public.app_option_apply_operation(p_op uuid, p_token uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_prev_cal text := pg_catalog.current_setting('app.wa_calendar', true);
  v_prev_opt text := pg_catalog.current_setting('app.option_fn', true);
  v_prev_adm text := pg_catalog.current_setting('app.option_admin', true);
  op record;
  t record;
  v_out text;
  v_opt uuid;
  v_expires timestamptz;
  v_active boolean;
BEGIN
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  PERFORM pg_catalog.set_config('app.wa_calendar', 'on', true);
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  SELECT * INTO op FROM public.option_operations x WHERE x.id = p_op FOR UPDATE;
  IF op.id IS NULL OR op.lock_token IS DISTINCT FROM p_token OR p_token IS NULL
     OR op.locked_until < pg_catalog.now() OR op.status NOT IN ('approved', 'pending') THEN
    v_out := 'lost';
  ELSIF op.kind = 'convert' THEN
    v_out := 'convert_requires_service';
  ELSIF op.status <> 'approved' THEN
    v_out := 'lost';
  ELSIF public.app_option_fingerprint(op.workspace_id, op.property_id, op.check_in, op.check_out,
                                      op.target_option_id) IS DISTINCT FROM op.fingerprint THEN
    UPDATE public.option_operations SET status = 'stale', failure_code = 'calendar_changed',
           lock_token = NULL, locked_until = NULL
     WHERE id = op.id;
    v_out := 'stale';
  ELSE
    PERFORM pg_catalog.set_config('app.option_admin', coalesce(op.decided_by_admin::text, ''), true);
    SELECT p.status = 'active' INTO v_active FROM public.properties p
     WHERE p.id = op.property_id AND p.workspace_id = op.workspace_id;
    IF op.kind = 'create' THEN
      v_expires := CASE WHEN op.expiry_source = 'message' AND op.sent_at IS NOT NULL
                        THEN op.sent_at ELSE pg_catalog.now() END
                   + pg_catalog.make_interval(mins => op.expires_in_minutes);
      IF NOT coalesce(v_active, false) OR op.check_in IS NULL OR op.expires_in_minutes IS NULL
         OR v_expires <= pg_catalog.now()
         OR v_expires > (op.check_in::timestamp AT TIME ZONE 'Europe/Istanbul') THEN
        v_out := 'failed';
      ELSE
        v_opt := pg_catalog.gen_random_uuid();
        BEGIN
          INSERT INTO public.reservation_options
            (id, workspace_id, property_id, source, group_id, origin_message_id, origin_wa_message_id,
             check_in, check_out, expires_at, expiry_source, adults, children, guest_name)
          VALUES (v_opt, op.workspace_id, op.property_id,
                  CASE WHEN op.group_id IS NULL THEN 'panel' ELSE 'whatsapp' END,
                  op.group_id, op.message_id, op.wa_message_id, op.check_in, op.check_out, v_expires,
                  op.expiry_source, op.adults, op.children, op.guest_name);
          v_out := 'applied';
        EXCEPTION WHEN unique_violation THEN
          v_out := 'failed';
        END;
      END IF;
    ELSE -- cancel
      SELECT o.id, o.status, o.version INTO t FROM public.reservation_options o
       WHERE o.id = op.target_option_id FOR UPDATE;
      IF t.id IS NULL OR t.status <> 'open' OR t.version IS DISTINCT FROM op.target_option_version THEN
        v_out := 'stale';
      ELSE
        UPDATE public.reservation_options
           SET status = 'cancelled', end_reason = coalesce(op.end_reason, 'customer_declined'),
               ended_by_message_id = op.message_id
         WHERE id = t.id;
        v_opt := t.id;
        v_out := 'applied';
      END IF;
    END IF;
    UPDATE public.option_operations
       SET status = v_out,
           result_option_id = CASE WHEN v_out = 'applied' THEN v_opt END,
           applied_at = CASE WHEN v_out = 'applied' THEN pg_catalog.now() END,
           failure_code = CASE WHEN v_out = 'failed' THEN 'not_applicable'
                               WHEN v_out = 'stale' THEN 'target_changed' END,
           after_state = CASE WHEN v_out = 'applied'
                              THEN pg_catalog.jsonb_build_object('option', v_opt, 'status',
                                     CASE WHEN op.kind = 'create' THEN 'open' ELSE 'cancelled' END) END,
           lock_token = NULL, locked_until = NULL
     WHERE id = op.id;
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  PERFORM pg_catalog.set_config('app.option_admin', coalesce(v_prev_adm, ''), true);
  RETURN v_out;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  PERFORM pg_catalog.set_config('app.option_admin', coalesce(v_prev_adm, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint
-- Alınmış işlemi uygulanamadı / eskidi olarak kapatır ya da kilidi bırakır (yeniden denenir).
-- "applied" BU fonksiyonla yazılamaz (opsiyon değişikliği yalnız apply / 3e servisiyle).
-- Dönüş: stale | failed | released | lost
CREATE FUNCTION public.app_option_finish_operation(p_op uuid, p_token uuid, p_outcome text,
    p_code text) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_opt text := pg_catalog.current_setting('app.option_fn', true);
  op record;
  v_out text;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('stale', 'failed', 'release')
     OR (p_code IS NOT NULL AND p_code !~ '^[a-z0-9_]{1,60}$') THEN
    RAISE EXCEPTION 'option_finish_invalid' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  SELECT * INTO op FROM public.option_operations x WHERE x.id = p_op FOR UPDATE;
  IF op.id IS NULL OR p_token IS NULL OR op.lock_token IS DISTINCT FROM p_token
     OR op.status NOT IN ('approved', 'pending') THEN
    v_out := 'lost';
  ELSIF p_outcome = 'release' THEN
    UPDATE public.option_operations SET lock_token = NULL, locked_until = NULL WHERE id = op.id;
    v_out := 'released';
  ELSE
    UPDATE public.option_operations
       SET status = p_outcome, failure_code = p_code, lock_token = NULL, locked_until = NULL
     WHERE id = op.id;
    v_out := p_outcome;
  END IF;
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RETURN v_out;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_option_claim_messages(integer),
  public.app_wa_option_apply(uuid, jsonb), public.app_option_expire_due(integer),
  public.app_option_scan_conflicts(integer), public.app_option_claim_operations(integer),
  public.app_option_apply_operation(uuid, uuid),
  public.app_option_finish_operation(uuid, uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
-- option-maintenance uygulamanın bağlantısını (app_user) kullanır; ağ geçidi rolüne VERİLMEZ.
GRANT EXECUTE ON FUNCTION public.app_option_claim_messages(integer),
  public.app_wa_option_apply(uuid, jsonb), public.app_option_expire_due(integer),
  public.app_option_scan_conflicts(integer), public.app_option_claim_operations(integer),
  public.app_option_apply_operation(uuid, uuid),
  public.app_option_finish_operation(uuid, uuid, text, text) TO app_user;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 8. Super Admin (YALNIZ app_admin)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_option_admin_options(p_admin uuid, p_status text, p_limit integer)
  RETURNS TABLE (id uuid, workspace_id uuid, workspace_name text, property_id uuid,
                 property_name text, source text, status text, check_in date, check_out date,
                 expires_at timestamptz, expiry_source text, remaining_seconds bigint,
                 end_reason text, guest_name text, adults smallint, children smallint,
                 converted_reservation_id uuid, version integer, created_at timestamptz,
                 ended_at timestamptz, open_alerts integer)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_prev_cal text := pg_catalog.current_setting('app.wa_calendar', true);
  v_prev_opt text := pg_catalog.current_setting('app.option_fn', true);
BEGIN
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  PERFORM pg_catalog.set_config('app.wa_calendar', 'on', true);
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  PERFORM public.app_option_admin_check(p_admin);
  IF p_status IS NOT NULL AND p_status NOT IN ('open', 'converted', 'cancelled', 'expired') THEN
    RAISE EXCEPTION 'option_filter_invalid' USING ERRCODE = 'check_violation';
  END IF;
  RETURN QUERY
    SELECT o.id, o.workspace_id, w.name, o.property_id, p.name, o.source, o.status, o.check_in,
           o.check_out, o.expires_at, o.expiry_source,
           CASE WHEN o.status = 'open' AND o.expires_at IS NOT NULL
                THEN GREATEST(0, pg_catalog.floor(EXTRACT(EPOCH FROM o.expires_at - pg_catalog.now())))::bigint END,
           o.end_reason, o.guest_name, o.adults, o.children, o.converted_reservation_id, o.version,
           o.created_at, o.ended_at,
           (SELECT count(*)::integer FROM public.option_conflict_alerts a
             WHERE a.option_id = o.id AND a.acknowledged_at IS NULL)
      FROM public.reservation_options o
      JOIN public.workspaces w ON w.id = o.workspace_id
      JOIN public.properties p ON p.id = o.property_id AND p.workspace_id = o.workspace_id
     WHERE p_status IS NULL OR o.status = p_status
     ORDER BY CASE WHEN o.status = 'open' THEN o.expires_at END NULLS LAST, o.created_at DESC
     LIMIT LEAST(GREATEST(coalesce(p_limit, 100), 1), 500);
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint
CREATE FUNCTION public.app_option_admin_operations(p_admin uuid, p_status text, p_limit integer)
  RETURNS TABLE (id uuid, workspace_id uuid, workspace_name text, property_id uuid,
                 property_name text, kind text, mode text, status text, source text,
                 check_in date, check_out date, expires_in_minutes integer, end_reason text,
                 target_option_id uuid, result_option_id uuid, reasons text[], failure_code text,
                 guest_name text, adults smallint, children smallint, decided_at timestamptz,
                 decision_note text, version integer, created_at timestamptz,
                 calendar_changed boolean)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_prev_cal text := pg_catalog.current_setting('app.wa_calendar', true);
  v_prev_opt text := pg_catalog.current_setting('app.option_fn', true);
BEGIN
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  PERFORM pg_catalog.set_config('app.wa_calendar', 'on', true);
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  PERFORM public.app_option_admin_check(p_admin);
  IF p_status IS NOT NULL AND p_status NOT IN ('pending', 'approved', 'applied', 'rejected', 'stale', 'failed') THEN
    RAISE EXCEPTION 'option_filter_invalid' USING ERRCODE = 'check_violation';
  END IF;
  RETURN QUERY
    SELECT op.id, op.workspace_id, w.name, op.property_id, p.name, op.kind, op.mode, op.status,
           op.source, op.check_in, op.check_out, op.expires_in_minutes, op.end_reason,
           op.target_option_id, op.result_option_id, op.reasons, op.failure_code, op.guest_name,
           op.adults, op.children, op.decided_at, op.decision_note, op.version, op.created_at,
           (op.status IN ('pending', 'approved')
            AND public.app_option_fingerprint(op.workspace_id, op.property_id, op.check_in,
                                              op.check_out, op.target_option_id)
                IS DISTINCT FROM op.fingerprint)
      FROM public.option_operations op
      JOIN public.workspaces w ON w.id = op.workspace_id
      JOIN public.properties p ON p.id = op.property_id AND p.workspace_id = op.workspace_id
     WHERE (p_status IS NULL AND op.mode = 'needs_approval' AND op.status = 'pending')
        OR op.status = p_status
     ORDER BY op.created_at
     LIMIT LEAST(GREATEST(coalesce(p_limit, 100), 1), 500);
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint
CREATE FUNCTION public.app_option_admin_option_events(p_admin uuid, p_option uuid)
  RETURNS TABLE (event text, from_status text, to_status text, reason text,
                 actor_admin_id uuid, by_message boolean, version integer, created_at timestamptz)
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
    SELECT e.event, e.from_status, e.to_status, e.reason, e.actor_admin_id,
           e.message_id IS NOT NULL, e.version, e.created_at
      FROM public.reservation_option_events e
     WHERE e.option_id = p_option
     ORDER BY e.version, e.created_at;
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint
CREATE FUNCTION public.app_option_admin_alerts(p_admin uuid, p_limit integer)
  RETURNS TABLE (id uuid, workspace_id uuid, option_id uuid, property_id uuid, source_kind text,
                 source_id uuid, detected_at timestamptz, option_status text)
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
    SELECT a.id, a.workspace_id, a.option_id, a.property_id, a.source_kind, a.source_id,
           a.detected_at, o.status
      FROM public.option_conflict_alerts a
      JOIN public.reservation_options o ON o.id = a.option_id
     WHERE a.acknowledged_at IS NULL
     ORDER BY a.detected_at DESC
     LIMIT LEAST(GREATEST(coalesce(p_limit, 100), 1), 500);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint
-- Onay / ret. Onay YALNIZ işlemi "approved" yapar (uygulamayı görev yapar) ve takvim parmak izini
-- bu anın takvimine göre yeniler (Super Admin'in gördüğü takvim). Eksik bilgi onayda tamamlanır:
-- oluşturma → tarih ve süre; kesinleştirme → hedef + misafir adı + yetişkin sayısı; iptal → hedef.
-- Dönüş: approved | rejected | not_found | not_pending | version_conflict
CREATE FUNCTION public.app_option_admin_decide(p_admin uuid, p_op uuid, p_version integer,
    p_approve boolean, p_note text, p_check_in date, p_check_out date, p_expires_minutes integer,
    p_guest_name text, p_adults integer, p_children integer) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_prev_cal text := pg_catalog.current_setting('app.wa_calendar', true);
  v_prev_opt text := pg_catalog.current_setting('app.option_fn', true);
  op record;
  t record;
  v_tver integer;
  v_tguest text;
  v_tadults integer;
  v_tchildren integer;
  v_in date;
  v_out date;
  v_minutes integer;
  v_source text;
  v_guest text := NULLIF(pg_catalog.btrim(coalesce(p_guest_name, '')), '');
  v_note text := NULLIF(pg_catalog.btrim(coalesce(p_note, '')), '');
  v_res text;
BEGIN
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  PERFORM pg_catalog.set_config('app.wa_calendar', 'on', true);
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  PERFORM public.app_option_admin_check(p_admin);
  IF p_approve IS NULL OR p_version IS NULL THEN
    RAISE EXCEPTION 'option_decision_invalid' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO op FROM public.option_operations x WHERE x.id = p_op FOR UPDATE;
  IF op.id IS NULL THEN
    v_res := 'not_found';
  ELSIF op.status <> 'pending' OR op.mode <> 'needs_approval' THEN
    v_res := 'not_pending';
  ELSIF op.version <> p_version THEN
    v_res := 'version_conflict';
  ELSIF NOT p_approve THEN
    UPDATE public.option_operations
       SET status = 'rejected', decided_by_admin = p_admin, decided_at = pg_catalog.now(),
           decision_note = v_note
     WHERE id = op.id;
    v_res := 'rejected';
  ELSE
    v_in := coalesce(p_check_in, op.check_in);
    v_out := coalesce(p_check_out, op.check_out);
    IF (v_in IS NULL) <> (v_out IS NULL) OR (v_in IS NOT NULL AND v_out <= v_in) THEN
      RAISE EXCEPTION 'option_decision_incomplete' USING ERRCODE = 'check_violation';
    END IF;
    IF op.kind = 'create' THEN
      v_minutes := coalesce(p_expires_minutes, op.expires_in_minutes);
      v_source := CASE WHEN p_expires_minutes IS NOT NULL THEN 'manual' ELSE op.expiry_source END;
      IF v_in IS NULL OR v_minutes IS NULL THEN
        RAISE EXCEPTION 'option_decision_incomplete' USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      -- İptal / kesinleştirme tarihleri hedef opsiyonunkidir; hedef açık olmalı.
      SELECT o.id, o.status, o.version, o.check_in, o.check_out, o.guest_name, o.adults, o.children
        INTO t FROM public.reservation_options o
       WHERE o.id = op.target_option_id AND o.workspace_id = op.workspace_id;
      IF t.id IS NULL OR t.status <> 'open' THEN
        RAISE EXCEPTION 'option_decision_incomplete' USING ERRCODE = 'check_violation';
      END IF;
      v_in := t.check_in; v_out := t.check_out;
      v_tver := t.version; v_tguest := t.guest_name; v_tadults := t.adults; v_tchildren := t.children;
      IF op.kind = 'convert'
         AND (coalesce(v_guest, v_tguest) IS NULL
              OR coalesce(p_adults, op.adults, v_tadults) IS NULL) THEN
        RAISE EXCEPTION 'option_decision_incomplete' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    BEGIN
      UPDATE public.option_operations
         SET status = 'approved', decided_by_admin = p_admin, decided_at = pg_catalog.now(),
             decision_note = v_note, check_in = v_in, check_out = v_out,
             expires_in_minutes = CASE WHEN op.kind = 'create' THEN v_minutes ELSE op.expires_in_minutes END,
             expiry_source = CASE WHEN op.kind = 'create' THEN v_source ELSE op.expiry_source END,
             target_option_version = CASE WHEN op.kind = 'create' THEN NULL ELSE v_tver END,
             guest_name = CASE WHEN op.kind = 'convert' THEN coalesce(v_guest, v_tguest) ELSE op.guest_name END,
             adults = CASE WHEN op.kind IN ('create', 'convert')
                           THEN coalesce(p_adults, op.adults, v_tadults) ELSE op.adults END,
             children = CASE WHEN op.kind IN ('create', 'convert')
                             THEN coalesce(p_children, op.children, v_tchildren) ELSE op.children END,
             fingerprint = public.app_option_fingerprint(op.workspace_id, op.property_id, v_in, v_out,
                                                          op.target_option_id)
       WHERE id = op.id;
    EXCEPTION WHEN check_violation THEN
      RAISE EXCEPTION 'option_decision_invalid' USING ERRCODE = 'check_violation';
    END;
    v_res := 'approved';
  END IF;
  IF v_res IN ('approved', 'rejected') THEN
    INSERT INTO public.admin_audit_log (id, admin_id, action, target_type, target_id, metadata)
    VALUES (pg_catalog.gen_random_uuid(), p_admin, 'option.operation_' || v_res, 'option_operation',
            op.id, pg_catalog.jsonb_build_object('workspace', op.workspace_id, 'kind', op.kind));
    INSERT INTO public.audit_log (id, workspace_id, actor_user_id, action, target_type, target_id,
                                  metadata)
    VALUES (pg_catalog.gen_random_uuid(), op.workspace_id, NULL, 'option.operation_' || v_res,
            'option_operation', op.id, pg_catalog.jsonb_build_object('kind', op.kind));
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RETURN v_res;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint
-- Panelden iptal (panel_cancel). Kesin rezervasyon ve bloklara dokunulmaz.
-- Dönüş: cancelled | not_found | not_open | version_conflict
CREATE FUNCTION public.app_option_admin_cancel(p_admin uuid, p_option uuid, p_version integer,
    p_note text) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_opt text := pg_catalog.current_setting('app.option_fn', true);
  v_prev_adm text := pg_catalog.current_setting('app.option_admin', true);
  o record;
  v_note text := NULLIF(pg_catalog.btrim(coalesce(p_note, '')), '');
  v_res text;
BEGIN
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  PERFORM public.app_option_admin_check(p_admin);
  IF p_version IS NULL THEN
    RAISE EXCEPTION 'option_decision_invalid' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO o FROM public.reservation_options x WHERE x.id = p_option FOR UPDATE;
  IF o.id IS NULL THEN
    v_res := 'not_found';
  ELSIF o.status <> 'open' THEN
    v_res := 'not_open';
  ELSIF o.version <> p_version THEN
    v_res := 'version_conflict';
  ELSE
    PERFORM pg_catalog.set_config('app.option_admin', p_admin::text, true);
    UPDATE public.reservation_options SET status = 'cancelled', end_reason = 'panel_cancel'
     WHERE id = o.id;
    BEGIN
      INSERT INTO public.option_operations
        (id, workspace_id, kind, mode, status, source, property_id, check_in, check_out, end_reason,
         target_option_id, target_option_version, result_option_id, decided_by_admin, decided_at,
         decision_note, before_state, after_state, applied_at)
      VALUES
        (pg_catalog.gen_random_uuid(), o.workspace_id, 'cancel', 'needs_approval', 'applied', 'panel',
         o.property_id, o.check_in, o.check_out, 'panel_cancel', o.id, o.version, o.id, p_admin,
         pg_catalog.now(), v_note,
         pg_catalog.jsonb_build_object('status', 'open', 'version', o.version),
         pg_catalog.jsonb_build_object('status', 'cancelled', 'reason', 'panel_cancel'),
         pg_catalog.now());
    EXCEPTION WHEN check_violation THEN
      RAISE EXCEPTION 'option_decision_invalid' USING ERRCODE = 'check_violation';
    END;
    INSERT INTO public.admin_audit_log (id, admin_id, action, target_type, target_id, metadata)
    VALUES (pg_catalog.gen_random_uuid(), p_admin, 'option.cancelled', 'reservation_option', o.id,
            pg_catalog.jsonb_build_object('workspace', o.workspace_id, 'reason', 'panel_cancel'));
    INSERT INTO public.audit_log (id, workspace_id, actor_user_id, action, target_type, target_id,
                                  metadata)
    VALUES (pg_catalog.gen_random_uuid(), o.workspace_id, NULL, 'option.cancelled',
            'reservation_option', o.id, pg_catalog.jsonb_build_object('reason', 'panel_cancel'));
    v_res := 'cancelled';
  END IF;
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  PERFORM pg_catalog.set_config('app.option_admin', coalesce(v_prev_adm, ''), true);
  RETURN v_res;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  PERFORM pg_catalog.set_config('app.option_admin', coalesce(v_prev_adm, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_option_admin_options(uuid, text, integer),
  public.app_option_admin_operations(uuid, text, integer),
  public.app_option_admin_option_events(uuid, uuid),
  public.app_option_admin_alerts(uuid, integer),
  public.app_option_admin_decide(uuid, uuid, integer, boolean, text, date, date, integer, text,
                                 integer, integer),
  public.app_option_admin_cancel(uuid, uuid, integer, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_option_admin_options(uuid, text, integer),
  public.app_option_admin_operations(uuid, text, integer),
  public.app_option_admin_option_events(uuid, uuid),
  public.app_option_admin_alerts(uuid, integer),
  public.app_option_admin_decide(uuid, uuid, integer, boolean, text, date, date, integer, text,
                                 integer, integer),
  public.app_option_admin_cancel(uuid, uuid, integer, text) TO app_admin;
