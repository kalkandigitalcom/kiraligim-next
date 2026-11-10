-- 0036_wa_calendar_proposals_security (WhatsApp Asistanı A2: takvim önerileri — güvenlik ve kuyruk)
--
-- Amaç: bağlı WhatsApp gruplarından gelen mesajlar bir worker tarafından ayrıştırılır ve
-- wa_calendar_proposals tablosuna İŞLEM ÖNERİSİ olarak yazılır. Takvim (reservations) yalnız
-- panelde, oturumdaki owner/manager onayıyla ve rezervasyon servisiyle değişir. Bu migration:
--   1. ENABLE/FORCE RLS ve app_user politikaları/kolon yetkileri (öneri okuma ve karar);
--   2. durum makinesi tetikleyicisi (karar verilmiş öneri değişmez; applied/rejected yalnız
--      oturumdaki owner/manager; superseded/expired/noop yalnız veritabanı fonksiyonları;
--      her değişiklikte version + 1);
--   3. worker fonksiyonları (SECURITY DEFINER, app.wa_calendar + app.wa_fn bayrakları):
--      app_wa_claim_messages, app_wa_message_context, app_wa_busy, app_wa_store_proposals,
--      app_wa_fail_message, app_wa_expire_proposals. Hiçbiri reservations'a YAZMAZ (yalnız okur);
--      işletme kimliği parametre olarak ALINMAZ — kilitli mesajdan bulunur (lock_token şart);
--   4. app_wa_unlink_group ve app_wa_purge_messages genişletilir (bekleyen öneriler sona erer,
--      saklama süresi dolan alıntılar boşaltılır);
--   5. GÜVENLİ BAŞLANGIÇ: worker'dan önce kuyrukta bekleyen tüm mesajlar "ignored" yapılır
--      (app_wa_calendar_cutover). Yalnız bu migration'dan SONRA gelen mesajlar öneri üretebilir.
--   6. GÖNDEREN POLİTİKASI: yalnız işletmenin doğrulanmış numaralı üyeleri öneri oluşturabilir.
--      owner/manager doğrulanmış gönderendir; staff önerisi her zaman "staff_review_required"
--      nedeniyle elle incelenir ve "tek tık" onaylanamaz; kayıtsız veya doğrulanmamış numaranın
--      mesajı öneri üretmeden "ignored" (sender_not_authorized) olur.
--
-- Ağ geçidi rolüne (app_wa_gateway) hiçbir yeni yetki verilmez.
--
-- Geri alma (veri kaybı: öneriler; mesaj durumları "received"a dönmez):
--   DROP FUNCTION app_wa_claim_messages(integer), app_wa_message_context(uuid, uuid),
--     app_wa_busy(uuid, uuid, uuid, date, date), app_wa_store_proposals(uuid, uuid, jsonb),
--     app_wa_fail_message(uuid, uuid, text), app_wa_expire_proposals(),
--     app_wa_calendar_cutover(), app_wa_sender_role(uuid, text);
--   DROP TRIGGER wa_calendar_proposals_guard ON wa_calendar_proposals; DROP FUNCTION
--     app_wa_proposals_guard(); app_wa_unlink_group ve app_wa_purge_messages'ı 0034'teki
--     tanımlarına döndürün; 0035'teki tablo ve kolonlar ileri bir migration ile kaldırılır.

-- ---------------------------------------------------------------------------
-- 1. RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.wa_calendar_proposals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.wa_calendar_proposals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- app_user: yalnız kendi işletmesinde owner/manager (mesaj alıntısı içerir; wa_inbound_messages
-- ile aynı kural). Ekleme ve silme YOK: öneriyi yalnız worker fonksiyonu yazar.
CREATE POLICY wa_calendar_proposals_select ON public.wa_calendar_proposals FOR SELECT TO app_user
  USING (workspace_id = public.app_current_workspace_id()
         AND public.app_current_member_role() IN ('owner', 'manager'));
--> statement-breakpoint
CREATE POLICY wa_calendar_proposals_update ON public.wa_calendar_proposals FOR UPDATE TO app_user
  USING (workspace_id = public.app_current_workspace_id()
         AND public.app_current_member_role() IN ('owner', 'manager'))
  WITH CHECK (workspace_id = public.app_current_workspace_id()
              AND public.app_current_member_role() IN ('owner', 'manager'));
--> statement-breakpoint
GRANT SELECT ON TABLE public.wa_calendar_proposals TO app_user;
--> statement-breakpoint
-- Yönetici düzeltmesi ve karar kolonları. Kimlik, mesaj, gönderen, bayrak ve puan kolonları
-- yalnız worker fonksiyonuyla yazılır.
GRANT UPDATE (action, property_id, check_in, check_out, reservation_status, target_reservation_ids,
  edited, status, decided_by, decided_at, decision_note, decision_mode, decision_reasons,
  applied_reservation_ids) ON TABLE public.wa_calendar_proposals TO app_user;
--> statement-breakpoint
-- Onaylanan öneriden oluşan rezervasyon kaynağını gösterir (A2d: rezervasyon servisi).
GRANT INSERT (origin_proposal_id) ON TABLE public.reservations TO app_user;
--> statement-breakpoint

-- app_migrator (SECURITY DEFINER fonksiyonların sahibi): yalnız fonksiyonların açtığı bayrakla.
-- Öneriler: worker fonksiyonları (app.wa_calendar) ve mevcut WhatsApp fonksiyonları (app.wa_fn:
-- bağlantı kesme, saklama temizliği).
CREATE POLICY wa_calendar_proposals_fn ON public.wa_calendar_proposals FOR ALL TO app_migrator
  USING (pg_catalog.current_setting('app.wa_calendar', true) = 'on'
         OR pg_catalog.current_setting('app.wa_fn', true) = 'on')
  WITH CHECK (pg_catalog.current_setting('app.wa_calendar', true) = 'on'
              OR pg_catalog.current_setting('app.wa_fn', true) = 'on');
--> statement-breakpoint
-- Worker'ın YALNIZ OKUMA erişimi: villa listesi ve çakışma özeti. Yazma politikası yoktur.
CREATE POLICY properties_wa_calendar_read ON public.properties FOR SELECT TO app_migrator
  USING (pg_catalog.current_setting('app.wa_calendar', true) = 'on');
--> statement-breakpoint
CREATE POLICY reservations_wa_calendar_read ON public.reservations FOR SELECT TO app_migrator
  USING (pg_catalog.current_setting('app.wa_calendar', true) = 'on');
--> statement-breakpoint
CREATE POLICY external_calendar_events_wa_calendar_read ON public.external_calendar_events
  FOR SELECT TO app_migrator
  USING (pg_catalog.current_setting('app.wa_calendar', true) = 'on');
--> statement-breakpoint
CREATE POLICY external_calendar_sources_wa_calendar_read ON public.external_calendar_sources
  FOR SELECT TO app_migrator
  USING (pg_catalog.current_setting('app.wa_calendar', true) = 'on');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Durum makinesi ve iyimser kilit
-- ---------------------------------------------------------------------------
-- Kurallar:
--  * Ekleme yalnız veritabanı fonksiyonuyla (bayrak) ve yalnız pending/superseded/noop olarak.
--  * Kimlik, mesaj ve gönderen kolonları değişmez.
--  * Bakım değişiklikleri her durumda serbesttir ve sürümü artırmaz: kaynak mesaj silinince
--    message_id → NULL, kararı veren kullanıcı silinince decided_by → NULL (yabancı anahtar
--    eylemleri) ve saklama süresi dolunca alıntının boşaltılması (yalnız fonksiyon bayrağıyla).
--  * Diğer her değişiklik yalnız "pending" öneride; version + 1.
--  * applied / rejected: yalnız oturumdaki kullanıcı (app.user_id), bu işletmede owner/manager ve
--    decided_by = o kullanıcı. Kullanıcısız bağlantı (worker) bir öneriyi ASLA onaylayamaz.
--  * superseded / expired / noop: yalnız veritabanı fonksiyonları.
CREATE FUNCTION public.app_wa_proposals_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_fn boolean := pg_catalog.current_setting('app.wa_calendar', true) = 'on'
                  OR pg_catalog.current_setting('app.wa_fn', true) = 'on';
  v_user uuid;
  v_maint text[] := ARRAY['message_id', 'message_excerpt', 'decided_by', 'updated_at'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT v_fn THEN
      RAISE EXCEPTION 'wa_proposal_insert_forbidden' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.status NOT IN ('pending', 'superseded', 'noop') OR NEW.version <> 1
       OR NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL OR NEW.decision_mode IS NOT NULL
       OR pg_catalog.cardinality(NEW.decision_reasons) <> 0
       OR pg_catalog.cardinality(NEW.applied_reservation_ids) <> 0 OR NEW.edited THEN
      RAISE EXCEPTION 'wa_proposal_invalid_insert' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.group_id <> OLD.group_id
     OR NEW.item_no <> OLD.item_no OR NEW.parser_version <> OLD.parser_version
     OR NEW.sent_at <> OLD.sent_at OR NEW.sender_hash IS DISTINCT FROM OLD.sender_hash
     OR NEW.sender_role <> OLD.sender_role OR NEW.sender_verified <> OLD.sender_verified
     OR NEW.villa_name_raw IS DISTINCT FROM OLD.villa_name_raw OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'wa_proposal_immutable' USING ERRCODE = 'check_violation';
  END IF;

  -- Yalnız bakım kolonları değiştiyse (yabancı anahtar eylemleri, saklama temizliği).
  IF (pg_catalog.to_jsonb(NEW) - v_maint - 'version') = (pg_catalog.to_jsonb(OLD) - v_maint - 'version')
     AND NEW.version = OLD.version
     AND (NEW.message_id IS NULL OR NEW.message_id = OLD.message_id)
     AND (NEW.decided_by IS NULL OR NEW.decided_by = OLD.decided_by)
     AND (NEW.message_excerpt = OLD.message_excerpt OR (v_fn AND NEW.message_excerpt = '(silindi)'))
  THEN
    RETURN NEW;
  END IF;

  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'wa_proposal_decided' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.message_excerpt <> OLD.message_excerpt OR NEW.message_id IS DISTINCT FROM OLD.message_id THEN
    RAISE EXCEPTION 'wa_proposal_immutable' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status IN ('applied', 'rejected') THEN
    v_user := public.app_current_user_id();
    IF v_user IS NULL OR NEW.decided_by IS DISTINCT FROM v_user
       OR NEW.workspace_id IS DISTINCT FROM public.app_current_workspace_id()
       OR public.app_current_member_role() IS DISTINCT FROM 'owner'
          AND public.app_current_member_role() IS DISTINCT FROM 'manager' THEN
      RAISE EXCEPTION 'wa_proposal_decision_forbidden' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.status IN ('superseded', 'expired', 'noop') THEN
    IF NOT v_fn THEN
      RAISE EXCEPTION 'wa_proposal_status_forbidden' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL OR NEW.decision_mode IS NOT NULL
        OR pg_catalog.cardinality(NEW.decision_reasons) <> 0
        OR pg_catalog.cardinality(NEW.applied_reservation_ids) <> 0 THEN
    -- Bekleyen öneride karar alanları boş kalır.
    RAISE EXCEPTION 'wa_proposal_invalid_pending' USING ERRCODE = 'check_violation';
  END IF;

  NEW.version := OLD.version + 1;
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER wa_calendar_proposals_guard BEFORE INSERT OR UPDATE ON public.wa_calendar_proposals
  FOR EACH ROW EXECUTE FUNCTION public.app_wa_proposals_guard();
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_wa_proposals_guard() FROM PUBLIC;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Yardımcı: gönderenin işletmedeki rolü (doğrulanmış numarasından)
-- ---------------------------------------------------------------------------
-- Numara özeti (app_wa_phone_hash) bir kullanıcının doğrulanmış numarasıyla eşleşmeli ve o
-- kullanıcı bu işletmenin üyesi olmalı. Dönüş: owner | manager | staff | NULL (kayıtsız veya
-- doğrulanmamış numara, ya da işletmede üye değil). Mesaj metnindeki ada asla bakılmaz.
CREATE FUNCTION public.app_wa_sender_role(p_workspace uuid, p_hash text) RETURNS text
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT m.role
    FROM public.wa_verified_phones vp
    JOIN public.workspace_members m ON m.user_id = vp.user_id
   WHERE p_hash IS NOT NULL AND vp.phone_hash = p_hash AND m.workspace_id = p_workspace
   LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_wa_sender_role(uuid, text) FROM PUBLIC;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Worker: iş alma
-- ---------------------------------------------------------------------------
-- Önce öneri üretmeyecek bekleyen mesajlar "ignored" yapılır: geçmiş birikim (backlog), 7 günden
-- eski gönderim, bağlı olmayan grup veya pasif işletme, ve GÖNDEREN POLİTİKASI: numarası
-- işletmenin bir üyesinde doğrulanmamış (kayıtsız, doğrulanmamış ya da LID çözülemedi). Kilidi dolmuş ve deneme sınırına ulaşmış
-- işler "failed" olur. Sonra en fazla p_limit (≤ 50) mesaj FOR UPDATE SKIP LOCKED ile alınır:
-- status = processing, yeni lock_token, 120 sn kilit, attempts + 1. Ham numara döndürülmez.
CREATE FUNCTION public.app_wa_claim_messages(p_limit integer)
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
  r record;
  v_token uuid;
  v_hash text;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION 'wa_claim_invalid' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  PERFORM pg_catalog.set_config('app.wa_calendar', 'on', true);

  UPDATE public.wa_inbound_messages m
     SET status = 'ignored', processed_at = v_now, lock_token = NULL, locked_until = NULL,
         last_error = CASE
           WHEN m.kind = 'backlog' THEN 'backlog'
           WHEN m.sent_at < v_now - interval '7 days' THEN 'too_old'
           WHEN NOT EXISTS (
             SELECT 1 FROM public.wa_groups g
               JOIN public.workspaces w ON w.id = g.workspace_id
              WHERE g.id = m.group_id AND g.workspace_id = m.workspace_id
                AND g.status = 'linked' AND w.status = 'active') THEN 'group_not_linked'
           ELSE 'sender_not_authorized' END
   WHERE m.status = 'received'
     AND (m.kind = 'backlog' OR m.sent_at < v_now - interval '7 days'
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

  FOR r IN
    SELECT m.id, m.workspace_id, m.group_id, m.body, m.sent_at, m.sender_pn, m.attempts
      FROM public.wa_inbound_messages m
     WHERE m.status = 'received' OR (m.status = 'processing' AND m.locked_until <= v_now)
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
-- 5. Worker: kilitli mesajın işletmesinin etkin villaları (eşleştirme için)
-- ---------------------------------------------------------------------------
-- İşletme kimliği parametre DEĞİLDİR: geçerli kilit belirteciyle tutulan mesajdan bulunur.
-- Kilit yoksa / süresi dolmuşsa boş döner.
CREATE FUNCTION public.app_wa_message_context(p_message uuid, p_token uuid)
  RETURNS TABLE (property_id uuid, name text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_prev_cal text := pg_catalog.current_setting('app.wa_calendar', true);
  v_ws uuid;
BEGIN
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  PERFORM pg_catalog.set_config('app.wa_calendar', 'on', true);
  SELECT m.workspace_id INTO v_ws FROM public.wa_inbound_messages m
   WHERE m.id = p_message AND m.status = 'processing' AND m.lock_token = p_token
     AND m.locked_until > pg_catalog.clock_timestamp();
  IF v_ws IS NOT NULL THEN
    RETURN QUERY
      SELECT p.id, p.name FROM public.properties p
       WHERE p.workspace_id = v_ws AND p.status = 'active'
       ORDER BY p.name, p.id
       LIMIT 500;
  END IF;
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
-- 6. Worker: çakışma özeti (YALNIZ OKUMA; öneriye bilgi olarak yazılır)
-- ---------------------------------------------------------------------------
-- Villa kilitli mesajın işletmesine ait olmalı. Dönüş: beklemede/onaylı rezervasyon ve bloklar +
-- etkin harici (iCal) olaylar, en fazla 20. Misafir bilgisi döndürülmez.
CREATE FUNCTION public.app_wa_busy(p_message uuid, p_token uuid, p_property uuid,
                                   p_from date, p_to date)
  RETURNS TABLE (kind text, record_id uuid, check_in date, check_out date, status text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_prev_cal text := pg_catalog.current_setting('app.wa_calendar', true);
  v_ws uuid;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from OR p_to - p_from > 400 THEN
    RAISE EXCEPTION 'wa_busy_invalid' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  PERFORM pg_catalog.set_config('app.wa_calendar', 'on', true);
  SELECT m.workspace_id INTO v_ws FROM public.wa_inbound_messages m
   WHERE m.id = p_message AND m.status = 'processing' AND m.lock_token = p_token
     AND m.locked_until > pg_catalog.clock_timestamp();
  IF v_ws IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.properties p WHERE p.id = p_property AND p.workspace_id = v_ws) THEN
    RETURN QUERY
      SELECT x.kind, x.record_id, x.check_in, x.check_out, x.status FROM (
        SELECT r.kind::text AS kind, r.id AS record_id, r.check_in, r.check_out, r.status::text AS status
          FROM public.reservations r
         WHERE r.workspace_id = v_ws AND r.property_id = p_property
           AND r.status IN ('pending', 'confirmed')
           AND r.check_in < p_to AND r.check_out > p_from
        UNION ALL
        SELECT 'external', e.id, e.start_date, e.end_date, 'active'
          FROM public.external_calendar_events e
          JOIN public.external_calendar_sources s
            ON s.id = e.source_id AND s.workspace_id = e.workspace_id
         WHERE e.workspace_id = v_ws AND e.property_id = p_property
           AND e.is_active AND s.is_active
           AND e.start_date < p_to AND e.end_date > p_from
      ) x
      ORDER BY x.check_in, x.record_id
      LIMIT 20;
  END IF;
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
-- 7. Worker: önerileri kaydet ve mesajı sonuçlandır
-- ---------------------------------------------------------------------------
-- Kilit belirteci tutmazsa (iş başka çalıştırmaya geçmiş) hiçbir şey yazılmaz: 'wa_claim_lost'.
-- İşletme, grup, gönderim zamanı, gönderen özeti ve rolü MESAJDAN alınır (worker'ın gönderdiği
-- değerlere güvenilmez). Gönderen artık işletmede yetkili değilse (numara kaldırıldı, üyelik
-- bitti) hiçbir öneri yazılmaz ve mesaj "ignored" (sender_not_authorized) olur. Staff önerisine
-- "staff_review_required" nedeni veritabanında eklenir (worker unutsa bile). Villa bu işletmenin olmalı (bileşik yabancı anahtar); aday
-- villalar işletmenin villalarıyla süzülür. Soru gibi eylemsiz öğeler "noop"; aynı villa, eylem ve
-- tarihler için bekleyen öneri varsa yenisi "superseded". Aynı (mesaj, sıra) ikinci kez yazılmaz.
-- Dönüş: yazılan öneri sayısı. Mesaj: en az bir öneri varsa processed, yoksa ignored.
CREATE FUNCTION public.app_wa_store_proposals(p_message uuid, p_token uuid, p_items jsonb)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_prev_cal text := pg_catalog.current_setting('app.wa_calendar', true);
  v_now timestamptz := pg_catalog.clock_timestamp();
  m record;
  it jsonb;
  v_hash text;
  v_role text;
  v_reasons text[];
  v_action text;
  v_prop uuid;
  v_in date;
  v_out date;
  v_flags text[];
  v_status text;
  v_super uuid;
  v_cands uuid[];
  v_n integer := 0;
  v_rows integer;
  v_total integer;
BEGIN
  IF p_items IS NULL OR pg_catalog.jsonb_typeof(p_items) <> 'array'
     OR pg_catalog.jsonb_array_length(p_items) > 10 THEN
    RAISE EXCEPTION 'wa_store_invalid' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  PERFORM pg_catalog.set_config('app.wa_calendar', 'on', true);

  SELECT * INTO m FROM public.wa_inbound_messages x WHERE x.id = p_message FOR UPDATE;
  IF NOT FOUND OR m.status <> 'processing' OR m.lock_token IS DISTINCT FROM p_token
     OR m.locked_until <= v_now THEN
    RAISE EXCEPTION 'wa_claim_lost' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  v_hash := public.app_wa_phone_hash(m.sender_pn);
  v_role := public.app_wa_sender_role(m.workspace_id, v_hash);
  IF v_role IS NULL THEN
    UPDATE public.wa_inbound_messages x
       SET status = 'ignored', processed_at = v_now, lock_token = NULL, locked_until = NULL,
           last_error = 'sender_not_authorized'
     WHERE x.id = m.id;
    PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
    PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
    RETURN 0;
  END IF;

  FOR it IN SELECT e FROM pg_catalog.jsonb_array_elements(p_items) e LOOP
    v_action := it->>'action';
    v_prop := (it->>'property_id')::uuid;
    v_in := (it->>'check_in')::date;
    v_out := (it->>'check_out')::date;
    v_flags := ARRAY(SELECT pg_catalog.jsonb_array_elements_text(coalesce(it->'flags', '[]'::jsonb)));
    v_cands := ARRAY(
      SELECT p.id FROM public.properties p
       WHERE p.workspace_id = m.workspace_id
         AND p.id IN (SELECT (pg_catalog.jsonb_array_elements_text(
                                coalesce(it->'candidate_property_ids', '[]'::jsonb)))::uuid)
       ORDER BY p.id);
    v_reasons := ARRAY(SELECT pg_catalog.jsonb_array_elements_text(
                         coalesce(it->'review_reasons', '[]'::jsonb)));
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
      v_hash, v_role, v_role IN ('owner', 'manager'), v_action, it->>'villa_name_raw', v_prop, it->>'villa_resolution',
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
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 8. Worker: hata — yeniden dene ya da (5. denemeden sonra) failed
-- ---------------------------------------------------------------------------
-- Dönüş: retry | failed | lost (kilit artık bu çalıştırmada değil). Hata yalnız kısa koddur.
CREATE FUNCTION public.app_wa_fail_message(p_message uuid, p_token uuid, p_error text)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_now timestamptz := pg_catalog.clock_timestamp();
  m record;
  v_out text;
BEGIN
  IF p_error IS NULL OR p_error !~ '^[a-z0-9_]{1,60}$' THEN
    RAISE EXCEPTION 'wa_fail_invalid' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  SELECT * INTO m FROM public.wa_inbound_messages x WHERE x.id = p_message FOR UPDATE;
  IF NOT FOUND OR m.status <> 'processing' OR m.lock_token IS DISTINCT FROM p_token THEN
    v_out := 'lost';
  ELSE
    v_out := CASE WHEN m.attempts >= 5 THEN 'failed' ELSE 'retry' END;
    UPDATE public.wa_inbound_messages x
       SET status = CASE WHEN v_out = 'failed' THEN 'failed' ELSE 'received' END,
           processed_at = CASE WHEN v_out = 'failed' THEN v_now ELSE NULL END,
           lock_token = NULL, locked_until = NULL, last_error = p_error
     WHERE x.id = m.id;
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  RETURN v_out;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 9. Worker: süresi geçen bekleyen öneriler
-- ---------------------------------------------------------------------------
-- Girişi bugünden (Europe/Istanbul) önce olan ya da tarihsiz ve 7 günden eski bekleyen öneriler
-- "expired" olur. Dönüş: sayı.
CREATE FUNCTION public.app_wa_expire_proposals()
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_cal text := pg_catalog.current_setting('app.wa_calendar', true);
  v_today date := (pg_catalog.now() AT TIME ZONE 'Europe/Istanbul')::date;
  v_count integer;
BEGIN
  PERFORM pg_catalog.set_config('app.wa_calendar', 'on', true);
  UPDATE public.wa_calendar_proposals pr SET status = 'expired'
   WHERE pr.status = 'pending'
     AND ((pr.check_in IS NOT NULL AND pr.check_in < v_today)
          OR (pr.check_in IS NULL AND pr.created_at < pg_catalog.now() - interval '7 days'));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  RETURN v_count;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 10. Panel: bağlantıyı kesme — bekleyen öneriler de sona erer (0034 tanımı + öneriler)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_wa_unlink_group(p_group uuid)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.wa_fn', true);
  v_ws uuid := public.app_current_workspace_id();
  v_user uuid := public.app_current_user_id();
  v_found uuid;
  v_out text;
BEGIN
  IF v_ws IS NULL OR v_user IS NULL OR p_group IS NULL THEN
    RETURN 'forbidden';
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  IF NOT public.app_wa_can_manage() THEN
    v_out := 'forbidden';
  ELSE
    SELECT id INTO v_found FROM public.wa_groups
     WHERE id = p_group AND workspace_id = v_ws
     FOR UPDATE;
    IF v_found IS NULL THEN
      v_out := 'not_found';
    ELSE
      UPDATE public.wa_calendar_proposals SET status = 'expired'
       WHERE group_id = p_group AND workspace_id = v_ws AND status = 'pending';
      DELETE FROM public.wa_inbound_messages WHERE group_id = p_group;
      UPDATE public.wa_groups
         SET status = CASE WHEN status = 'left' THEN 'left' ELSE 'discovered' END,
             workspace_id = NULL, property_id = NULL, linked_at = NULL, linked_by = NULL,
             link_fail_count = 0, link_fail_window_at = NULL, last_message_at = NULL
       WHERE id = p_group;
      INSERT INTO public.audit_log (id, workspace_id, actor_user_id, action, target_type,
                                    target_id, metadata)
      VALUES (pg_catalog.gen_random_uuid(), v_ws, v_user, 'whatsapp.group_unlinked',
              'whatsapp_group', p_group, '{}'::jsonb);
      v_out := 'unlinked';
    END IF;
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev, ''), true);
  RETURN v_out;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 11. Saklama: karar verilmiş önerilerin alıntısı da boşaltılır (0034 tanımı + öneriler)
-- ---------------------------------------------------------------------------
-- Öneri satırı denetim için kalır; yalnız mesaj alıntısı '(silindi)' olur. Bekleyen öneriler
-- zaten app_wa_expire_proposals ile sona erer.
CREATE OR REPLACE FUNCTION public.app_wa_purge_messages(p_days integer)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.wa_fn', true);
  v_count integer;
BEGIN
  -- Alt sınır: uygulama sabiti WA_RETENTION_DAYS = 90. Üst sınır 365.
  IF p_days IS NULL OR p_days < 90 OR p_days > 365 THEN
    RAISE EXCEPTION 'wa_purge_invalid' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  DELETE FROM public.wa_inbound_messages
   WHERE received_at < pg_catalog.now() - pg_catalog.make_interval(days => p_days);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE public.wa_calendar_proposals
     SET message_excerpt = '(silindi)'
   WHERE status <> 'pending' AND message_excerpt <> '(silindi)'
     AND coalesce(decided_at, updated_at) < pg_catalog.now() - pg_catalog.make_interval(days => p_days);
  DELETE FROM public.wa_link_codes
   WHERE coalesce(used_at, expires_at) < pg_catalog.now() - interval '7 days';
  DELETE FROM public.wa_phone_challenges
   WHERE coalesce(used_at, expires_at) < pg_catalog.now() - interval '7 days';
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev, ''), true);
  RETURN v_count;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 12. GÜVENLİ BAŞLANGIÇ: worker öncesi kuyruk
-- ---------------------------------------------------------------------------
-- Bu migration'a kadar kuyruğa giren her mesaj (A1'de hepsi "received" kaldı; 90 güne kadar
-- sohbet) "ignored" yapılır: worker ilk çalıştığında eski mesajlardan öneri ÜRETMEZ. Yalnız bu
-- migration'dan sonra gelen mesajlar işlenir. Fonksiyon kimseye açık değildir (yalnız sahibi).
CREATE FUNCTION public.app_wa_calendar_cutover()
  RETURNS integer
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.wa_fn', true);
  v_count integer;
BEGIN
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  UPDATE public.wa_inbound_messages
     SET status = 'ignored', processed_at = pg_catalog.clock_timestamp(),
         lock_token = NULL, locked_until = NULL, last_error = 'before_worker'
   WHERE status IN ('received', 'processing');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev, ''), true);
  RETURN v_count;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_wa_calendar_cutover() FROM PUBLIC;
--> statement-breakpoint
SELECT public.app_wa_calendar_cutover();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 13. EXECUTE yetkileri
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.app_wa_claim_messages(integer),
  public.app_wa_message_context(uuid, uuid),
  public.app_wa_busy(uuid, uuid, uuid, date, date),
  public.app_wa_store_proposals(uuid, uuid, jsonb),
  public.app_wa_fail_message(uuid, uuid, text),
  public.app_wa_expire_proposals() FROM PUBLIC;
--> statement-breakpoint
-- Worker uygulamanın bağlantısını (app_user) kullanır (ical-sync ve wa-retention ile aynı model).
-- Ağ geçidi rolüne (app_wa_gateway) VERİLMEZ.
GRANT EXECUTE ON FUNCTION public.app_wa_claim_messages(integer),
  public.app_wa_message_context(uuid, uuid),
  public.app_wa_busy(uuid, uuid, uuid, date, date),
  public.app_wa_store_proposals(uuid, uuid, jsonb),
  public.app_wa_fail_message(uuid, uuid, text),
  public.app_wa_expire_proposals() TO app_user;
