-- 0071_option_admin_views (Opsiyon Aşama 3c: Super Admin opsiyon paneli ve onaylı işlemlerin uygulanması)
--
-- YALNIZ YENİ FONKSİYON ekler. Tablo, sütun, kısıt, indeks, politika, tetikleyici ve mevcut
-- hiçbir fonksiyon değişmez; worker, ayrıştırıcı, otomatik kapat / aç / değiştir, tepki kuyruğu,
-- ağ geçidi, rezervasyon, API, iCal ve webhook akışları DEĞİŞMEZ. Rezervasyon, blok, harici takvim
-- ve grup tabloları yalnız OKUNUR. Opsiyon müsaitliği hiçbir koşulda kapatmaz.
--
--   1. Super Admin okuma (YALNIZ app_admin):
--        app_option_admin_counts            — genel bakış kartları (tek sorgu)
--        app_option_admin_option            — tek opsiyon (detay sayfası)
--        app_option_admin_operation         — tek işlem (onay ekranı)
--        app_option_admin_option_operations — opsiyonun bağlı işlemleri
--        app_option_admin_range_context     — işlemin aralığındaki güncel takvim (misafir adı YOK)
--        app_option_admin_alert_list        — adlar ve kaynak tarihleriyle çakışma uyarıları
--   2. Super Admin yazma (YALNIZ app_admin): app_option_admin_ack_alert — uyarıyı "görüldü" yapar;
--      opsiyona ve kaynağa dokunmaz; denetim kaydı yazar.
--   3. option-maintenance görevi (YALNIZ app_user; görev Coolify'da yokken hiç çağrılmaz):
--        app_option_claim_approved_operations — Super Admin onaylı OLUŞTUR / İPTAL işlemleri
--                                               (kesinleştirme 3e'ye kadar ALINMAZ),
--        app_option_apply_approved_operation  — anahtar satırlarını kilitleyip global + işletme +
--                                               grup anahtarlarını, grubun villasını ve takvim
--                                               parmak izini YENİDEN doğrular, sonra 0069'daki
--                                               app_option_apply_operation ile tek transaction'da
--                                               uygular. Kill switch kapalıysa uygulanmaz.
--
-- Geri alma: docs/rollback-0071.sql.

-- ---------------------------------------------------------------------------
-- 1. Super Admin okuma
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_option_admin_counts(p_admin uuid)
  RETURNS TABLE (pending_approval integer, approved_waiting integer, open_options integer,
                 open_alerts integer, global_enabled boolean)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_opt text := pg_catalog.current_setting('app.option_fn', true);
BEGIN
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  PERFORM public.app_option_admin_check(p_admin);
  RETURN QUERY
    SELECT (SELECT count(*)::integer FROM public.option_operations op
             WHERE op.status = 'pending' AND op.mode = 'needs_approval'),
           (SELECT count(*)::integer FROM public.option_operations op WHERE op.status = 'approved'),
           (SELECT count(*)::integer FROM public.reservation_options o WHERE o.status = 'open'),
           (SELECT count(*)::integer FROM public.option_conflict_alerts a
             WHERE a.acknowledged_at IS NULL),
           coalesce((SELECT g.enabled FROM public.option_automation_global g WHERE g.id = 1), false);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint
CREATE FUNCTION public.app_option_admin_option(p_admin uuid, p_option uuid)
  RETURNS TABLE (id uuid, workspace_id uuid, workspace_name text, property_id uuid,
                 property_name text, source text, status text, check_in date, check_out date,
                 expires_at timestamptz, expiry_source text, remaining_seconds bigint,
                 end_reason text, guest_name text, adults smallint, children smallint,
                 converted_reservation_id uuid, version integer, created_at timestamptz,
                 ended_at timestamptz, open_alerts integer, group_id uuid, group_subject text,
                 by_message boolean)
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
  RETURN QUERY
    SELECT o.id, o.workspace_id, w.name, o.property_id, p.name, o.source, o.status, o.check_in,
           o.check_out, o.expires_at, o.expiry_source,
           CASE WHEN o.status = 'open' AND o.expires_at IS NOT NULL
                THEN GREATEST(0, pg_catalog.floor(EXTRACT(EPOCH FROM o.expires_at - pg_catalog.now())))::bigint END,
           o.end_reason, o.guest_name, o.adults, o.children, o.converted_reservation_id, o.version,
           o.created_at, o.ended_at,
           (SELECT count(*)::integer FROM public.option_conflict_alerts a
             WHERE a.option_id = o.id AND a.acknowledged_at IS NULL),
           o.group_id, g.subject, o.origin_message_id IS NOT NULL
      FROM public.reservation_options o
      JOIN public.workspaces w ON w.id = o.workspace_id
      JOIN public.properties p ON p.id = o.property_id AND p.workspace_id = o.workspace_id
      LEFT JOIN public.wa_groups g ON g.id = o.group_id
     WHERE o.id = p_option;
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
CREATE FUNCTION public.app_option_admin_operation(p_admin uuid, p_op uuid)
  RETURNS TABLE (id uuid, workspace_id uuid, workspace_name text, property_id uuid,
                 property_name text, kind text, mode text, status text, source text,
                 group_id uuid, group_subject text, check_in date, check_out date,
                 expires_in_minutes integer, expiry_source text, sent_at timestamptz,
                 end_reason text, target_option_id uuid, target_option_version integer,
                 target_status text, target_version integer, result_option_id uuid,
                 result_reservation_id uuid, reasons text[], failure_code text, guest_name text,
                 adults smallint, children smallint, decided_at timestamptz, decided_by_name text,
                 decision_note text, applied_at timestamptz, attempts smallint, version integer,
                 created_at timestamptz, calendar_changed boolean)
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
  RETURN QUERY
    SELECT op.id, op.workspace_id, w.name, op.property_id, p.name, op.kind, op.mode, op.status,
           op.source, op.group_id, g.subject, op.check_in, op.check_out, op.expires_in_minutes,
           op.expiry_source, op.sent_at, op.end_reason, op.target_option_id,
           op.target_option_version, t.status, t.version, op.result_option_id,
           op.result_reservation_id, op.reasons, op.failure_code, op.guest_name, op.adults,
           op.children, op.decided_at, a.name, op.decision_note, op.applied_at, op.attempts,
           op.version, op.created_at,
           (op.status IN ('pending', 'approved')
            AND public.app_option_fingerprint(op.workspace_id, op.property_id, op.check_in,
                                              op.check_out, op.target_option_id)
                IS DISTINCT FROM op.fingerprint)
      FROM public.option_operations op
      JOIN public.workspaces w ON w.id = op.workspace_id
      JOIN public.properties p ON p.id = op.property_id AND p.workspace_id = op.workspace_id
      LEFT JOIN public.wa_groups g ON g.id = op.group_id
      LEFT JOIN public.reservation_options t ON t.id = op.target_option_id
      LEFT JOIN public.admin_users a ON a.id = op.decided_by_admin
     WHERE op.id = p_op;
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
-- Opsiyonu oluşturan (result) ve hedefleyen (target) işlemler.
CREATE FUNCTION public.app_option_admin_option_operations(p_admin uuid, p_option uuid)
  RETURNS TABLE (id uuid, role text, kind text, mode text, status text, source text,
                 check_in date, check_out date, failure_code text, decided_at timestamptz,
                 applied_at timestamptz, created_at timestamptz)
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
    SELECT op.id,
           CASE WHEN op.target_option_id = p_option THEN 'target' ELSE 'result' END,
           op.kind, op.mode, op.status, op.source, op.check_in, op.check_out, op.failure_code,
           op.decided_at, op.applied_at, op.created_at
      FROM public.option_operations op
     WHERE p_option IS NOT NULL
       AND (op.target_option_id = p_option OR op.result_option_id = p_option)
     ORDER BY op.created_at, op.id;
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint
-- İşlemin villasında, işlemin aralığıyla kesişen GÜNCEL kayıtlar: beklemede / onaylı rezervasyon
-- ve blok, etkin harici olay, açık opsiyon. Misafir adı, telefon veya not DÖNMEZ.
CREATE FUNCTION public.app_option_admin_range_context(p_admin uuid, p_op uuid)
  RETURNS TABLE (kind text, ref_id uuid, status text, check_in date, check_out date, label text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev_cal text := pg_catalog.current_setting('app.wa_calendar', true);
  v_prev_opt text := pg_catalog.current_setting('app.option_fn', true);
  op record;
BEGIN
  PERFORM pg_catalog.set_config('app.wa_calendar', 'on', true);
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  PERFORM public.app_option_admin_check(p_admin);
  SELECT x.workspace_id, x.property_id, x.check_in, x.check_out INTO op
    FROM public.option_operations x WHERE x.id = p_op;
  IF op.check_in IS NOT NULL AND op.check_out IS NOT NULL THEN
    RETURN QUERY
      SELECT r.kind, r.id, r.status, r.check_in, r.check_out, coalesce(r.source, '')
        FROM public.reservations r
       WHERE r.workspace_id = op.workspace_id AND r.property_id = op.property_id
         AND r.status IN ('pending', 'confirmed')
         AND r.check_in < op.check_out AND r.check_out > op.check_in
      UNION ALL
      SELECT 'external'::text, e.id, 'active'::text, e.start_date, e.end_date, s.name
        FROM public.external_calendar_events e
        JOIN public.external_calendar_sources s
          ON s.id = e.source_id AND s.workspace_id = e.workspace_id AND s.is_active
       WHERE e.workspace_id = op.workspace_id AND e.property_id = op.property_id AND e.is_active
         AND e.start_date < op.check_out AND e.end_date > op.check_in
      UNION ALL
      SELECT 'option'::text, o.id, o.status, o.check_in, o.check_out, o.source
        FROM public.reservation_options o
       WHERE o.workspace_id = op.workspace_id AND o.property_id = op.property_id
         AND o.status = 'open' AND o.check_in < op.check_out AND o.check_out > op.check_in
      ORDER BY 4, 1, 2;
  END IF;
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint
-- Uyarılar: p_option verilirse yalnız o opsiyonun; p_include_acknowledged false ise yalnız açıklar.
CREATE FUNCTION public.app_option_admin_alert_list(p_admin uuid, p_option uuid,
    p_include_acknowledged boolean, p_limit integer)
  RETURNS TABLE (id uuid, workspace_id uuid, workspace_name text, option_id uuid,
                 option_status text, property_id uuid, property_name text, option_check_in date,
                 option_check_out date, source_kind text, source_id uuid, source_status text,
                 source_check_in date, source_check_out date, source_label text,
                 detected_at timestamptz, acknowledged_at timestamptz, acknowledged_by_name text)
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
  RETURN QUERY
    SELECT a.id, a.workspace_id, w.name, a.option_id, o.status, a.property_id, p.name,
           o.check_in, o.check_out, a.source_kind, a.source_id,
           coalesce(r.status, CASE WHEN e.id IS NULL THEN NULL
                                   WHEN e.is_active THEN 'active' ELSE 'inactive' END),
           coalesce(r.check_in, e.start_date), coalesce(r.check_out, e.end_date),
           coalesce(r.kind, s.name), a.detected_at, a.acknowledged_at, ad.name
      FROM public.option_conflict_alerts a
      JOIN public.reservation_options o ON o.id = a.option_id
      JOIN public.workspaces w ON w.id = a.workspace_id
      JOIN public.properties p ON p.id = a.property_id AND p.workspace_id = a.workspace_id
      LEFT JOIN public.reservations r
        ON a.source_kind = 'reservation' AND r.id = a.source_id AND r.workspace_id = a.workspace_id
      LEFT JOIN public.external_calendar_events e
        ON a.source_kind = 'external_event' AND e.id = a.source_id AND e.workspace_id = a.workspace_id
      LEFT JOIN public.external_calendar_sources s ON s.id = e.source_id
      LEFT JOIN public.admin_users ad ON ad.id = a.acknowledged_by_admin
     WHERE (p_option IS NULL OR a.option_id = p_option)
       AND (coalesce(p_include_acknowledged, false) OR a.acknowledged_at IS NULL)
     ORDER BY a.acknowledged_at IS NOT NULL, a.detected_at DESC, a.id
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

-- ---------------------------------------------------------------------------
-- 2. Super Admin yazma: uyarıyı "görüldü" yap. Dönüş: acknowledged | already | not_found
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_option_admin_ack_alert(p_admin uuid, p_alert uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_opt text := pg_catalog.current_setting('app.option_fn', true);
  a record;
  v_res text;
BEGIN
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  PERFORM public.app_option_admin_check(p_admin);
  SELECT * INTO a FROM public.option_conflict_alerts x WHERE x.id = p_alert FOR UPDATE;
  IF a.id IS NULL THEN
    v_res := 'not_found';
  ELSIF a.acknowledged_at IS NOT NULL THEN
    v_res := 'already';
  ELSE
    UPDATE public.option_conflict_alerts
       SET acknowledged_at = pg_catalog.now(), acknowledged_by_admin = p_admin
     WHERE id = a.id;
    INSERT INTO public.admin_audit_log (id, admin_id, action, target_type, target_id, metadata)
    VALUES (pg_catalog.gen_random_uuid(), p_admin, 'option.alert_acknowledged',
            'option_conflict_alert', a.id,
            pg_catalog.jsonb_build_object('workspace', a.workspace_id, 'option', a.option_id));
    INSERT INTO public.audit_log (id, workspace_id, actor_user_id, action, target_type, target_id,
                                  metadata)
    VALUES (pg_catalog.gen_random_uuid(), a.workspace_id, NULL, 'option.alert_acknowledged',
            'option_conflict_alert', a.id, pg_catalog.jsonb_build_object('option', a.option_id));
    v_res := 'acknowledged';
  END IF;
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RETURN v_res;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. option-maintenance: Super Admin onaylı OLUŞTUR / İPTAL işlemlerini uygulama
-- ---------------------------------------------------------------------------
-- Alınabilir: status = approved, kind create | cancel, WhatsApp grubu olan işlem; global anahtar
-- açık VE grubun otomasyonu (global + işletme + grup) açık. Kesinleştirme 3e'ye kadar ALINMAZ.
-- 2 dakikalık kilit, en fazla 5 deneme (0069 ile aynı kilit alanları).
CREATE FUNCTION public.app_option_claim_approved_operations(p_limit integer)
  RETURNS TABLE (id uuid, lock_token uuid, kind text, workspace_id uuid, property_id uuid,
                 attempts smallint)
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
      WHERE x.status = 'approved' AND x.kind IN ('create', 'cancel')
        AND x.group_id IS NOT NULL
        AND (x.locked_until IS NULL OR x.locked_until < pg_catalog.now())
        AND x.attempts < 5
        AND EXISTS (SELECT 1 FROM public.option_automation_global g WHERE g.id = 1 AND g.enabled)
        AND public.app_option_automation_enabled(x.group_id)
      ORDER BY x.created_at
      LIMIT LEAST(GREATEST(coalesce(p_limit, 0), 0), 20)
      FOR UPDATE SKIP LOCKED)
  RETURNING op.id, op.lock_token, op.kind, op.workspace_id, op.property_id, op.attempts;
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint
-- Tek transaction: anahtar satırları FOR SHARE kilitlenir (Super Admin'in anahtar değişikliği bu
-- transaction bitene kadar bekler), anahtarlar ve grubun villası yeniden doğrulanır, sonra
-- app_option_apply_operation takvim parmak izini ve hedef sürümünü yeniden denetleyip uygular.
-- Dönüş: applied | stale | failed | automation_off | lost
--   automation_off — anahtar kapandı: işlem DEĞİŞMEZ, yalnız kilidi bırakılır (açılınca uygulanır).
--   stale          — grubun villası / işletmesi değişti ya da takvim veya hedef değişti.
CREATE FUNCTION public.app_option_apply_approved_operation(p_op uuid, p_token uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_prev_opt text := pg_catalog.current_setting('app.option_fn', true);
  op record;
  v_global boolean;
  v_group record;
  v_out text;
BEGIN
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  SELECT x.id, x.status, x.kind, x.workspace_id, x.property_id, x.group_id, x.lock_token,
         x.locked_until
    INTO op FROM public.option_operations x WHERE x.id = p_op FOR UPDATE;
  IF op.id IS NULL OR p_token IS NULL OR op.lock_token IS DISTINCT FROM p_token
     OR op.locked_until < pg_catalog.now() OR op.status <> 'approved'
     OR op.kind NOT IN ('create', 'cancel') OR op.group_id IS NULL THEN
    v_out := 'lost';
  ELSE
    -- Anahtar satırları: Super Admin değişikliğiyle sıralanır (kill switch yarışı yok).
    SELECT g.enabled INTO v_global FROM public.option_automation_global g WHERE g.id = 1 FOR SHARE;
    PERFORM 1 FROM public.workspace_option_settings s WHERE s.workspace_id = op.workspace_id FOR SHARE;
    PERFORM 1 FROM public.wa_group_option_settings s WHERE s.group_id = op.group_id FOR SHARE;
    SELECT g.workspace_id, g.property_id, g.status INTO v_group
      FROM public.wa_groups g WHERE g.id = op.group_id;
    IF NOT coalesce(v_global, false) OR NOT public.app_option_automation_enabled(op.group_id) THEN
      UPDATE public.option_operations SET lock_token = NULL, locked_until = NULL WHERE id = op.id;
      v_out := 'automation_off';
    ELSIF v_group.workspace_id IS DISTINCT FROM op.workspace_id
          OR v_group.property_id IS DISTINCT FROM op.property_id THEN
      UPDATE public.option_operations
         SET status = 'stale', failure_code = 'group_changed', lock_token = NULL, locked_until = NULL
       WHERE id = op.id;
      v_out := 'stale';
    ELSE
      v_out := public.app_option_apply_operation(op.id, p_token);
    END IF;
    IF v_out IN ('applied', 'stale', 'failed') THEN
      INSERT INTO public.audit_log (id, workspace_id, actor_user_id, action, target_type, target_id,
                                    metadata)
      VALUES (pg_catalog.gen_random_uuid(), op.workspace_id, NULL, 'option.operation_' || v_out,
              'option_operation', op.id, pg_catalog.jsonb_build_object('kind', op.kind));
    END IF;
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

-- ---------------------------------------------------------------------------
-- 4. Yetkiler: PUBLIC'ten geri al; Super Admin fonksiyonları YALNIZ app_admin, görev YALNIZ app_user
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.app_option_admin_counts(uuid),
  public.app_option_admin_option(uuid, uuid),
  public.app_option_admin_operation(uuid, uuid),
  public.app_option_admin_option_operations(uuid, uuid),
  public.app_option_admin_range_context(uuid, uuid),
  public.app_option_admin_alert_list(uuid, uuid, boolean, integer),
  public.app_option_admin_ack_alert(uuid, uuid),
  public.app_option_claim_approved_operations(integer),
  public.app_option_apply_approved_operation(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_option_admin_counts(uuid),
  public.app_option_admin_option(uuid, uuid),
  public.app_option_admin_operation(uuid, uuid),
  public.app_option_admin_option_operations(uuid, uuid),
  public.app_option_admin_range_context(uuid, uuid),
  public.app_option_admin_alert_list(uuid, uuid, boolean, integer),
  public.app_option_admin_ack_alert(uuid, uuid) TO app_admin;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_option_claim_approved_operations(integer),
  public.app_option_apply_approved_operation(uuid, uuid) TO app_user;
