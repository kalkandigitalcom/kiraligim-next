-- 0073_option_convert (Opsiyon Aşama 3e: Super Admin onaylı kesinleştirme — opsiyon → kesin rezervasyon)
--
-- YALNIZ YENİ FONKSİYON ekler. Tablo, sütun, kısıt, indeks, politika, tetikleyici ve mevcut hiçbir
-- fonksiyon değişmez; rezervasyon tablosu ve fonksiyonları, worker, ayrıştırıcı, ağ geçidi, tepki
-- kuyruğu, API, iCal ve webhook akışları DEĞİŞMEZ.
--
-- Dönüşüm option-maintenance görevinde (app_user), işletme SAHİBİNİN oturum bağlamında (withTenant)
-- TEK transaction'da yapılır:
--   1. app_option_convert_begin  — işlemi ve hedef opsiyonu kilitler, anahtar satırlarını FOR SHARE
--      kilitler; anahtarları (global + işletme + grup), grubun villasını, takvim parmak izini,
--      opsiyonun açık / süresi dolmamış / sürümünün onaydakiyle aynı olduğunu, giriş tarihini ve
--      misafir bilgisinin TAM olduğunu (ad, yetişkin, çocuk) yeniden doğrular. Uygun değilse
--      işlemi aynı transaction'da stale / failed kapatır (ya da anahtar kapalıysa kilidi bırakır)
--      ve rezervasyon OLUŞTURULMAZ.
--   2. Uygulama mevcut rezervasyon servisini (createReservation) DEĞİŞTİRMEDEN çağırır: tarih
--      kuralları, kapasite, pasif villa, çakışma kısıtı ve harici takvim koruması aynen geçerlidir.
--   3. app_option_convert_finish — oluşan kaydın işletme / villa / tarih / tür / durum / kaynak ve
--      misafir bilgisinin işlemle birebir aynı olduğunu denetler; opsiyonu converted
--      (payment_received, converted_reservation_id; geçmişte onaylayan Super Admin aktörü) ve işlemi
--      applied yapar; denetim kaydı yazar. Uyuşmazlıkta istisna → transaction (rezervasyon dahil)
--      geri alınır.
-- Tekrar koruması: işlem kilidi + belirteç, opsiyon satır kilidi, converted_reservation_id tekilliği
-- ve hepsinin tek transaction'da olması: aynı işlem ikinci rezervasyon oluşturamaz.
-- Yalnız WhatsApp kaynaklı kesinleştirmeler (Aşama 3e kararı); panelden doğrudan kesinleştirme yok.
--
-- Geri alma: docs/rollback-0073.sql.

-- ---------------------------------------------------------------------------
-- 1. Onaylanmış kesinleştirmeleri alma (anahtarlar kapalıysa hiçbiri)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_option_claim_approved_conversions(p_limit integer)
  RETURNS TABLE (id uuid, lock_token uuid, workspace_id uuid, attempts smallint)
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
      WHERE x.status = 'approved' AND x.kind = 'convert' AND x.source = 'whatsapp'
        AND x.group_id IS NOT NULL
        AND (x.locked_until IS NULL OR x.locked_until < pg_catalog.now())
        AND x.attempts < 5
        AND EXISTS (SELECT 1 FROM public.option_automation_global g WHERE g.id = 1 AND g.enabled)
        AND public.app_option_automation_enabled(x.group_id)
      ORDER BY x.created_at
      LIMIT LEAST(GREATEST(coalesce(p_limit, 0), 0), 10)
      FOR UPDATE SKIP LOCKED)
  RETURNING op.id, op.lock_token, op.workspace_id, op.attempts;
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. İşlemi yapacak kullanıcı: işletme sahibi (yalnız alınmış işlem için). Birden fazla sahip
--    varsa en eski üyelik (app_wa_message_actor ile aynı kural).
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_option_convert_owner(p_op uuid, p_token uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_prev_opt text := pg_catalog.current_setting('app.option_fn', true);
  v_ws uuid;
  v_user uuid;
BEGIN
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  SELECT x.workspace_id INTO v_ws FROM public.option_operations x
   WHERE x.id = p_op AND x.kind = 'convert' AND x.status = 'approved' AND p_token IS NOT NULL
     AND x.lock_token = p_token AND x.locked_until > pg_catalog.now();
  IF v_ws IS NOT NULL THEN
    SELECT wm.user_id INTO v_user FROM public.workspace_members wm
     WHERE wm.workspace_id = v_ws AND wm.role = 'owner'
     ORDER BY wm.created_at, wm.id
     LIMIT 1;
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RETURN v_user;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Başlat: kilitle + yeniden doğrula. Dönüş: outcome = ok | stale | failed | automation_off | lost
--    (ok değilse işlem bu fonksiyonda kapatılır / kilidi bırakılır; rezervasyon oluşturulmaz).
--    Çağıran işletme sahibinin oturum bağlamında (app.user_id = sahip) olmalıdır.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_option_convert_begin(p_op uuid, p_token uuid)
  RETURNS TABLE (outcome text, code text, property_id uuid, check_in date, check_out date,
                 guest_name text, adults smallint, children smallint, target_option_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_variable
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_prev_cal text := pg_catalog.current_setting('app.wa_calendar', true);
  v_prev_opt text := pg_catalog.current_setting('app.option_fn', true);
  op record;
  t record;
  g record;
  v_global boolean;
  v_owner uuid;
  v_active boolean;
  v_guest text;
  v_out text := 'ok';
  v_code text;
BEGIN
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  PERFORM pg_catalog.set_config('app.wa_calendar', 'on', true);
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  SELECT * INTO op FROM public.option_operations x WHERE x.id = p_op FOR UPDATE;
  IF op.id IS NULL OR p_token IS NULL OR op.lock_token IS DISTINCT FROM p_token
     OR op.locked_until < pg_catalog.now() OR op.status <> 'approved' OR op.kind <> 'convert'
     OR op.source <> 'whatsapp' OR op.group_id IS NULL THEN
    v_out := 'lost';
  ELSE
    -- Anahtar satırları: Super Admin değişikliğiyle sıralanır (kill switch yarışı yok).
    SELECT o.enabled INTO v_global FROM public.option_automation_global o WHERE o.id = 1 FOR SHARE;
    PERFORM 1 FROM public.workspace_option_settings s WHERE s.workspace_id = op.workspace_id FOR SHARE;
    PERFORM 1 FROM public.wa_group_option_settings s WHERE s.group_id = op.group_id FOR SHARE;
    SELECT wm.user_id INTO v_owner FROM public.workspace_members wm
     WHERE wm.workspace_id = op.workspace_id AND wm.role = 'owner'
     ORDER BY wm.created_at, wm.id LIMIT 1;
    SELECT x.workspace_id, x.property_id INTO g FROM public.wa_groups x WHERE x.id = op.group_id;
    SELECT p.status = 'active' INTO v_active FROM public.properties p
     WHERE p.id = op.property_id AND p.workspace_id = op.workspace_id;
    SELECT o.* INTO t FROM public.reservation_options o
     WHERE o.id = op.target_option_id FOR UPDATE;
    v_guest := NULLIF(pg_catalog.btrim(coalesce(op.guest_name, '')), '');

    IF NOT coalesce(v_global, false) OR NOT public.app_option_automation_enabled(op.group_id) THEN
      v_out := 'automation_off';
    ELSIF v_owner IS NULL
          OR v_owner::text IS DISTINCT FROM pg_catalog.current_setting('app.user_id', true) THEN
      v_out := 'stale'; v_code := 'owner_changed';
    ELSIF g.workspace_id IS DISTINCT FROM op.workspace_id OR g.property_id IS DISTINCT FROM op.property_id THEN
      v_out := 'stale'; v_code := 'group_changed';
    ELSIF public.app_option_fingerprint(op.workspace_id, op.property_id, op.check_in, op.check_out,
                                        op.target_option_id) IS DISTINCT FROM op.fingerprint THEN
      v_out := 'stale'; v_code := 'calendar_changed';
    ELSIF t.id IS NULL OR t.status <> 'open' OR t.version IS DISTINCT FROM op.target_option_version
          OR t.workspace_id <> op.workspace_id OR t.property_id <> op.property_id
          OR t.check_in IS DISTINCT FROM op.check_in OR t.check_out IS DISTINCT FROM op.check_out THEN
      v_out := 'stale'; v_code := 'target_changed';
    ELSIF t.expires_at IS NOT NULL AND t.expires_at <= pg_catalog.now() THEN
      v_out := 'stale'; v_code := 'option_expired';
    ELSIF op.check_in < (pg_catalog.now() AT TIME ZONE 'Europe/Istanbul')::date THEN
      v_out := 'failed'; v_code := 'date_past';
    ELSIF v_guest IS NULL OR pg_catalog.length(v_guest) < 2 OR pg_catalog.length(v_guest) > 120
          OR op.adults IS NULL OR op.adults < 1 OR op.adults > 50
          OR op.children IS NULL OR op.children < 0 OR op.children > 50 THEN
      v_out := 'failed'; v_code := 'guest_info_missing';
    ELSIF NOT coalesce(v_active, false) THEN
      v_out := 'failed'; v_code := 'property_inactive';
    END IF;

    IF v_out = 'automation_off' THEN
      UPDATE public.option_operations SET lock_token = NULL, locked_until = NULL WHERE id = op.id;
    ELSIF v_out IN ('stale', 'failed') THEN
      UPDATE public.option_operations
         SET status = v_out, failure_code = v_code, lock_token = NULL, locked_until = NULL
       WHERE id = op.id;
      INSERT INTO public.audit_log (id, workspace_id, actor_user_id, action, target_type, target_id,
                                    metadata)
      VALUES (pg_catalog.gen_random_uuid(), op.workspace_id, NULL, 'option.operation_' || v_out,
              'option_operation', op.id,
              pg_catalog.jsonb_build_object('kind', 'convert', 'code', v_code));
    END IF;
  END IF;

  outcome := v_out; code := v_code;
  IF v_out = 'ok' THEN
    property_id := op.property_id; check_in := op.check_in; check_out := op.check_out;
    guest_name := v_guest; adults := op.adults; children := op.children;
    target_option_id := op.target_option_id;
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RETURN NEXT;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Bitir: oluşan kaydı denetle, opsiyonu converted ve işlemi applied yap. Uyuşmazlıkta istisna
--    (option_convert_mismatch) → transaction ve rezervasyon geri alınır. Dönüş: applied
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_option_convert_finish(p_op uuid, p_token uuid, p_reservation uuid)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_cal text := pg_catalog.current_setting('app.wa_calendar', true);
  v_prev_opt text := pg_catalog.current_setting('app.option_fn', true);
  v_prev_adm text := pg_catalog.current_setting('app.option_admin', true);
  op record;
  r record;
  v_guest text;
BEGIN
  PERFORM pg_catalog.set_config('app.wa_calendar', 'on', true);
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  SELECT * INTO op FROM public.option_operations x WHERE x.id = p_op FOR UPDATE;
  IF op.id IS NULL OR p_token IS NULL OR op.lock_token IS DISTINCT FROM p_token
     OR op.status <> 'approved' OR op.kind <> 'convert' OR op.target_option_id IS NULL THEN
    RAISE EXCEPTION 'option_convert_mismatch' USING ERRCODE = 'check_violation';
  END IF;
  v_guest := NULLIF(pg_catalog.btrim(coalesce(op.guest_name, '')), '');
  SELECT * INTO r FROM public.reservations x WHERE x.id = p_reservation;
  IF r.id IS NULL OR r.workspace_id <> op.workspace_id OR r.property_id <> op.property_id
     OR r.check_in <> op.check_in OR r.check_out <> op.check_out OR r.kind <> 'reservation'
     OR r.status <> 'confirmed' OR r.source IS DISTINCT FROM 'whatsapp'
     OR r.guest_name IS DISTINCT FROM v_guest OR r.adults IS DISTINCT FROM op.adults::integer
     OR r.children IS DISTINCT FROM op.children::integer THEN
    RAISE EXCEPTION 'option_convert_mismatch' USING ERRCODE = 'check_violation';
  END IF;
  -- Geçmişte aktör: onaylayan Super Admin (app_reservation_options_history).
  PERFORM pg_catalog.set_config('app.option_admin', coalesce(op.decided_by_admin::text, ''), true);
  UPDATE public.reservation_options o
     SET status = 'converted', end_reason = 'payment_received', converted_reservation_id = r.id,
         ended_by_message_id = op.message_id, guest_name = v_guest, adults = op.adults,
         children = op.children
   WHERE o.id = op.target_option_id AND o.status = 'open' AND o.version = op.target_option_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'option_convert_mismatch' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.option_operations
     SET status = 'applied', applied_at = pg_catalog.now(), result_option_id = op.target_option_id,
         result_reservation_id = r.id, lock_token = NULL, locked_until = NULL,
         after_state = pg_catalog.jsonb_build_object('option', op.target_option_id,
                                                     'status', 'converted', 'reservation', r.id)
   WHERE id = op.id;
  INSERT INTO public.audit_log (id, workspace_id, actor_user_id, action, target_type, target_id,
                                metadata)
  VALUES (pg_catalog.gen_random_uuid(), op.workspace_id, NULL, 'option.operation_applied',
          'option_operation', op.id,
          pg_catalog.jsonb_build_object('kind', 'convert', 'option', op.target_option_id,
                                        'reservation', r.id));
  IF op.decided_by_admin IS NOT NULL THEN
    INSERT INTO public.admin_audit_log (id, admin_id, action, target_type, target_id, metadata)
    VALUES (pg_catalog.gen_random_uuid(), op.decided_by_admin, 'option.converted',
            'reservation_option', op.target_option_id,
            pg_catalog.jsonb_build_object('workspace', op.workspace_id, 'operation', op.id,
                                          'reservation', r.id));
  END IF;
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  PERFORM pg_catalog.set_config('app.option_admin', coalesce(v_prev_adm, ''), true);
  RETURN 'applied';
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  PERFORM pg_catalog.set_config('app.option_admin', coalesce(v_prev_adm, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Yetkiler: PUBLIC'ten geri al; görev fonksiyonları YALNIZ app_user
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.app_option_claim_approved_conversions(integer),
  public.app_option_convert_owner(uuid, uuid),
  public.app_option_convert_begin(uuid, uuid),
  public.app_option_convert_finish(uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_option_claim_approved_conversions(integer),
  public.app_option_convert_owner(uuid, uuid),
  public.app_option_convert_begin(uuid, uuid),
  public.app_option_convert_finish(uuid, uuid, uuid) TO app_user;
