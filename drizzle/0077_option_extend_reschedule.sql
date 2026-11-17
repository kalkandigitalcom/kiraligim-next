-- 0077_option_extend_reschedule (Opsiyon Faz B: WhatsApp'tan uzatma ve tarih değiştirme)
--
-- Ev sahibi yalnız WhatsApp'a yazar:
--   * Uzatma ("20-23 Aralık opsiyonunu 2 saat uzatalım", "Ödeme bekliyorum, 2 saat daha
--     bekleyelim", "Bu opsiyona 1 gün daha süre verelim"): yeni bitiş = mevcut bitiş + yazılan süre
--     (en az 1 saat). Süre yazılmamış / belirsizse, hedef tek değilse, süre dolmuşsa, yeni bitiş
--     girişi (İstanbul 00:00) aşıyorsa, opsiyonun İLK oluşturulmasından itibaren 14 günü aşıyorsa ya
--     da takvimde çakışma varsa işlem YOK: açıklama bekler (kısaltma yapılmaz).
--   * Tarih değiştirme ("20-23 Aralık opsiyonunu 21-24 Aralık yap", "Opsiyon tarihini 20-24 Aralık
--     yapalım"): eski opsiyon silinmez / yerinde değişmez — 'date_changed' nedeniyle kapanır, yenisi
--     replaces_option_id ile ona bağlı açılır (aynı transaction). Bitiş KORUNUR (yeni 24 saat
--     başlamaz). Yeni aralıkta takvim çakışması, başka açık opsiyon, başlamış giriş ya da bitişin
--     yeni girişi aşması → açıklama bekler.
--   Hedef: mesajdaki (eski) aralıkla birebir tek açık opsiyon; aralık yoksa grubun tek açık
--   opsiyonu. Birden fazla hedefte hiçbiri değişmez. Belirsizlikte otomatik değişiklik YOK.
--
-- Değişenler:
--   1. option_operations.kind: + extend, reschedule. end_reason kısıtları: + date_changed.
--   2. reservation_options.replaces_option_id (aynı işletme içi bileşik FK, tekil; yalnız
--      oluştururken yazılır — guard). reservation_option_events.expires_at (olay anındaki bitiş).
--   3. app_wa_option_apply: gövde 0076'dan; YALNIZ extend / reschedule dalları, gönderen yeniden
--      denetimi (worker öğesi olmayan uzatma mesajı için: engelli değil + doğrulanmış sahip /
--      yönetici), açıklama modu ve işlem kaydının önce / sonra durumu eklenir. Oluşturma (sabit
--      24 saat), iptal, kesinleştirme dalları DEĞİŞMEZ. İmza, SECURITY DEFINER, sahip, search_path,
--      yetkiler aynı.
--   4. app_reservation_options_guard: replaces_option_id değişmez alan. history tetikleyicisi:
--      olaya expires_at ve (uzatmada) kaynak mesaj. Olay guard'ı: expires_at değişmez.
--   5. İşletme denetim kaydı (audit_log, mevcut audit_log_option_fn politikası): uygulanan uzatma
--      'option.extended' {operation, source, added_minutes, expires_before, expires_after},
--      tarih değişikliği 'option.rescheduled' {operation, source, previous_option,
--      previous_check_in/out, check_in/out, expires_at}. Aktör NULL (WhatsApp görevi); mesaj
--      metni, telefon, misafir bilgisi yazılmaz.
--   6. Yeni app_option_admin_option_links(admin, opsiyon): Super Admin opsiyon detayında önceki /
--      sonraki opsiyon (YALNIZ app_admin; app_option_admin_check).
--
-- Optimistic lock: hedef FOR UPDATE + sürüm koşullu UPDATE (sürümü guard artırır); süre dolumu
-- (app_option_expire_due) SKIP LOCKED. Idempotency: (grup, mesaj, öğe) tekil indeksi ve
-- replaces_option_id tekilliği. Hiçbir mevcut satır güncellenmez. Opsiyonlar müsaitliği, API,
-- iCal ve webhook'u etkilemez (değişmez). Worker, ağ geçidi, ayrıştırıcı, tepki kuyruğu,
-- rezervasyon fonksiyonları değişmez.
--
-- Geri alma: docs/rollback-0077.sql.

ALTER TABLE "option_operations" DROP CONSTRAINT "option_operations_kind_check";--> statement-breakpoint
ALTER TABLE "option_operations" DROP CONSTRAINT "option_operations_values";--> statement-breakpoint
ALTER TABLE "reservation_options" DROP CONSTRAINT "reservation_options_end_state";--> statement-breakpoint
ALTER TABLE "reservation_option_events" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reservation_options" ADD COLUMN "replaces_option_id" uuid;--> statement-breakpoint
ALTER TABLE "reservation_options" ADD CONSTRAINT "reservation_options_replaces_fk" FOREIGN KEY ("replaces_option_id","workspace_id") REFERENCES "public"."reservation_options"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reservation_options_replaces_key" ON "reservation_options" USING btree ("replaces_option_id") WHERE "reservation_options"."replaces_option_id" is not null;--> statement-breakpoint
ALTER TABLE "option_operations" ADD CONSTRAINT "option_operations_kind_check" CHECK ("option_operations"."kind" in ('create', 'cancel', 'convert', 'extend', 'reschedule'));--> statement-breakpoint
ALTER TABLE "option_operations" ADD CONSTRAINT "option_operations_values" CHECK ("option_operations"."item_no" between 0 and 19 and "option_operations"."version" >= 1 and "option_operations"."attempts" >= 0
        and (("option_operations"."check_in" is null and "option_operations"."check_out" is null) or "option_operations"."check_out" > "option_operations"."check_in")
        and ("option_operations"."expires_in_minutes" is null or "option_operations"."expires_in_minutes" between 60 and 20160)
        and ("option_operations"."expiry_source" is null or "option_operations"."expiry_source" in ('message', 'workspace_default', 'manual', 'system_default'))
        and ("option_operations"."end_reason" is null or "option_operations"."end_reason" in ('payment_received', 'confirmed_in_panel', 'customer_declined', 'owner_cancelled', 'panel_cancel', 'date_changed', 'expired'))
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
ALTER TABLE "reservation_options" ADD CONSTRAINT "reservation_options_end_state" CHECK (("reservation_options"."status" = 'open' and "reservation_options"."ended_at" is null and "reservation_options"."end_reason" is null
            and "reservation_options"."converted_reservation_id" is null and "reservation_options"."ended_by_message_id" is null
            and "reservation_options"."ended_by_user_id" is null)
        or ("reservation_options"."status" = 'converted' and "reservation_options"."ended_at" is not null and "reservation_options"."converted_reservation_id" is not null
            and "reservation_options"."end_reason" in ('payment_received', 'confirmed_in_panel'))
        or ("reservation_options"."status" = 'cancelled' and "reservation_options"."ended_at" is not null and "reservation_options"."converted_reservation_id" is null
            and "reservation_options"."end_reason" in ('customer_declined', 'owner_cancelled', 'panel_cancel', 'date_changed'))
        or ("reservation_options"."status" = 'expired' and "reservation_options"."ended_at" is not null and "reservation_options"."converted_reservation_id" is null
            and "reservation_options"."expires_at" is not null and "reservation_options"."end_reason" in ('expired')));
--> statement-breakpoint

-- Opsiyon karar fonksiyonu: uzatma ve tarih değiştirme dalları (gövde 0076 + işaretli farklar)
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
    'duration_out_of_bounds', 'duration_after_check_in',
    -- Faz B (0077): uzatma / tarih değişikliği (metin kararı).
    'duration_missing', 'new_range_missing', 'same_range'];
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
  -- Faz B (0077)
  v_old_in date;
  v_old_out date;
  v_t_in date;
  v_t_out date;
  v_t_created timestamptz;
  v_t_source text;
  v_t_note text;
  v_t_children integer;
  v_sender_ok boolean;
  v_new_exp timestamptz;
  v_before jsonb;
  v_after jsonb;
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
         msg.sender_pn, g.property_id
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
      v_old_in := (it->>'old_check_in')::date;
      v_old_out := (it->>'old_check_out')::date;
      IF v_no IS NULL OR v_no < 0 OR v_no > 19
         OR v_intent IS NULL
         OR v_intent NOT IN ('create', 'cancel', 'convert', 'extend', 'reschedule', 'unknown')
         OR ((v_old_in IS NULL) <> (v_old_out IS NULL)) OR (v_old_in IS NOT NULL AND v_old_out <= v_old_in)
         OR (v_old_in IS NOT NULL AND v_intent <> 'reschedule')
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
      v_t_in := NULL; v_t_out := NULL; v_t_created := NULL; v_t_source := NULL; v_t_note := NULL;
      v_t_children := NULL; v_new_exp := NULL; v_before := NULL; v_after := NULL;

      -- Faz B (0077): uzatma / tarih değişikliği öğesi worker öğesi olmadan da gelebilir; gönderen
      -- veritabanında worker'ınkiyle aynı kuralla yeniden denetlenir (engelli değil, doğrulanmış
      -- sahip / yönetici). Değilse işlem YOK.
      IF v_intent IN ('extend', 'reschedule') THEN
        v_sender_ok := m.sender_pn IS NOT NULL
          AND public.app_wa_sender_block(m.group_id, m.sender_pn) IS NULL
          AND coalesce(public.app_wa_sender_role(m.workspace_id, public.app_wa_phone_hash(m.sender_pn)), '')
              IN ('owner', 'manager');
        CONTINUE WHEN NOT v_sender_ok;
      END IF;
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
      ELSIF v_intent IN ('extend', 'reschedule') THEN
        -- Faz B (0077). Hedef: uzatmada mesajdaki aralık (varsa), tarih değişikliğinde mesajdaki
        -- ESKİ aralık (varsa) birebir; yoksa aynı gruptan açılmış açık opsiyon. Tek aday olmalı.
        IF v_intent = 'extend' THEN
          v_old_in := v_in; v_old_out := v_out;
        END IF;
        IF v_old_in IS NOT NULL THEN
          SELECT count(*) INTO v_open FROM public.reservation_options o
           WHERE o.workspace_id = m.workspace_id AND o.property_id = m.property_id
             AND o.status = 'open' AND o.check_in = v_old_in AND o.check_out = v_old_out;
        ELSE
          SELECT count(*) INTO v_open FROM public.reservation_options o
           WHERE o.workspace_id = m.workspace_id AND o.property_id = m.property_id
             AND o.status = 'open' AND o.group_id = m.group_id;
        END IF;
        IF v_open = 1 THEN
          SELECT o.id, o.version, o.expires_at, o.check_in, o.check_out, o.created_at, o.expiry_source,
                 o.guest_name, o.adults, o.children, o.note
            INTO v_target, v_target_ver, v_target_exp, v_t_in, v_t_out, v_t_created, v_t_source,
                 v_target_guest, v_target_adults, v_t_children, v_t_note
            FROM public.reservation_options o
           WHERE o.workspace_id = m.workspace_id AND o.property_id = m.property_id AND o.status = 'open'
             AND ((v_old_in IS NOT NULL AND o.check_in = v_old_in AND o.check_out = v_old_out)
                  OR (v_old_in IS NULL AND o.group_id = m.group_id))
           FOR UPDATE;
          IF v_target_exp IS NULL THEN
            v_decision := 'ask'; v_reasons := v_reasons || 'option_without_expiry'::text;
          ELSIF v_target_exp <= pg_catalog.now() THEN
            v_decision := 'ask'; v_reasons := v_reasons || 'option_expired'::text;
          END IF;
          v_before := pg_catalog.jsonb_build_object('option', v_target, 'version', v_target_ver,
                        'check_in', v_t_in, 'check_out', v_t_out, 'expires_at', v_target_exp);
        ELSIF v_open > 1 THEN
          v_decision := 'ask'; v_reasons := v_reasons || 'multiple_open_options'::text;
        ELSE
          v_decision := 'ask'; v_reasons := v_reasons || 'no_open_option'::text;
        END IF;

        IF v_intent = 'extend' THEN
          -- Yeni bitiş = mevcut bitiş + yazılan süre (en az 1 saat). Yazılı süre kısaltılmaz:
          -- girişi aşarsa ya da opsiyonun ilk oluşturulmasından itibaren 14 günü aşarsa açıklama.
          v_in := v_t_in; v_out := v_t_out;
          IF v_minutes IS NULL THEN
            v_decision := 'ask'; v_reasons := v_reasons || 'duration_missing'::text;
          ELSIF v_target IS NOT NULL AND v_target_exp IS NOT NULL THEN
            v_new_exp := v_target_exp + pg_catalog.make_interval(mins => v_minutes);
            IF v_new_exp > (v_t_in::timestamp AT TIME ZONE 'Europe/Istanbul') THEN
              v_decision := 'ask'; v_reasons := v_reasons || 'extend_after_check_in'::text;
            END IF;
            IF v_new_exp > v_t_created + interval '14 days' THEN
              v_decision := 'ask'; v_reasons := v_reasons || 'extend_over_max'::text;
            END IF;
          END IF;
          IF v_target IS NOT NULL THEN
            v_conflicts := public.app_option_conflict_count(m.workspace_id, m.property_id, v_t_in, v_t_out);
            IF v_conflicts > 0 THEN v_decision := 'ask'; v_reasons := v_reasons || 'calendar_conflict'::text; END IF;
          END IF;
        ELSE
          -- Tarih değişikliği: yeni aralık zorunlu; bitiş KORUNUR (yeni 24 saat başlamaz) ve yeni
          -- girişi aşmamalı (kısaltma yok); yeni aralıkta takvim çakışması ya da başka açık opsiyon
          -- olmamalı; başlamış / geçmiş giriş otomatik işlenmez.
          IF v_in IS NULL THEN
            v_decision := 'ask'; v_reasons := v_reasons || 'new_range_missing'::text;
          ELSE
            IF (v_in::timestamp AT TIME ZONE 'Europe/Istanbul') <= pg_catalog.now() THEN
              v_decision := 'ask'; v_reasons := v_reasons || 'date_past'::text;
            END IF;
            v_conflicts := public.app_option_conflict_count(m.workspace_id, m.property_id, v_in, v_out);
            IF v_conflicts > 0 THEN v_decision := 'ask'; v_reasons := v_reasons || 'calendar_conflict'::text; END IF;
            SELECT count(*) INTO v_open FROM public.reservation_options o
             WHERE o.workspace_id = m.workspace_id AND o.property_id = m.property_id
               AND o.status = 'open' AND o.check_in < v_out AND o.check_out > v_in
               AND o.id IS DISTINCT FROM v_target;
            IF v_open > 0 THEN v_decision := 'ask'; v_reasons := v_reasons || 'option_overlap'::text; END IF;
            IF v_target IS NOT NULL THEN
              IF v_t_in = v_in AND v_t_out = v_out THEN
                v_decision := 'ask'; v_reasons := v_reasons || 'same_range'::text;
              END IF;
              IF v_target_exp IS NOT NULL
                 AND v_target_exp > (v_in::timestamp AT TIME ZONE 'Europe/Istanbul') THEN
                v_decision := 'ask'; v_reasons := v_reasons || 'duration_after_check_in'::text;
              END IF;
            END IF;
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
        ELSIF v_intent = 'extend' AND v_decision = 'apply' THEN
          -- İyimser kilit: satır FOR UPDATE ile tutulur, sürüm aynı olmalı; sürümü tetikleyici artırır.
          PERFORM pg_catalog.set_config('app.option_message', m.id::text, true);
          UPDATE public.reservation_options o SET expires_at = v_new_exp
           WHERE o.id = v_target AND o.version = v_target_ver AND o.status = 'open';
          PERFORM pg_catalog.set_config('app.option_message', '', true);
          IF NOT FOUND THEN
            RAISE EXCEPTION 'option_version_conflict' USING ERRCODE = 'serialization_failure';
          END IF;
          v_opt := v_target;
          v_after := pg_catalog.jsonb_build_object('option', v_target, 'status', 'open',
                       'expires_at', v_new_exp, 'added_minutes', v_minutes);
          v_status := 'applied';
        ELSIF v_intent = 'reschedule' AND v_decision = 'apply' THEN
          -- Eski kapanır (date_changed), yenisi ona bağlı açılır; ikisi aynı transaction'da.
          UPDATE public.reservation_options o
             SET status = 'cancelled', end_reason = 'date_changed', ended_by_message_id = m.id
           WHERE o.id = v_target AND o.version = v_target_ver AND o.status = 'open';
          IF NOT FOUND THEN
            RAISE EXCEPTION 'option_version_conflict' USING ERRCODE = 'serialization_failure';
          END IF;
          v_opt := pg_catalog.gen_random_uuid();
          INSERT INTO public.reservation_options
            (id, workspace_id, property_id, source, group_id, origin_message_id, origin_wa_message_id,
             check_in, check_out, expires_at, expiry_source, guest_name, adults, children, note,
             replaces_option_id)
          VALUES (v_opt, m.workspace_id, m.property_id, 'whatsapp', m.group_id, m.id, m.wa_message_id,
                  v_in, v_out, v_target_exp, v_t_source, v_target_guest, v_target_adults,
                  v_t_children, v_t_note, v_target);
          v_after := pg_catalog.jsonb_build_object('option', v_opt, 'status', 'open',
                       'check_in', v_in, 'check_out', v_out, 'expires_at', v_target_exp,
                       'replaces', v_target);
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
                WHEN v_intent IN ('create', 'extend', 'reschedule') THEN 'clarify'
                ELSE 'needs_approval' END,
           v_status, 'whatsapp', m.group_id, m.id, m.wa_message_id, v_no, m.property_id, v_in, v_out,
           m.sent_at, v_minutes, v_source,
           CASE WHEN v_intent = 'cancel' THEN coalesce(v_end, 'customer_declined')
                WHEN v_intent = 'reschedule' THEN 'date_changed' END,
           v_target, v_target_ver,
           CASE WHEN v_status = 'applied' THEN v_opt END, v_reasons,
           public.app_option_fingerprint(m.workspace_id, m.property_id, v_in, v_out, v_target),
           pg_catalog.jsonb_build_object('conflicts', v_conflicts, 'open_options', v_open,
                                         'target_version', v_target_ver)
             || coalesce(v_before, '{}'::jsonb),
           CASE WHEN v_status = 'applied' AND v_intent IN ('extend', 'reschedule') THEN v_after
                WHEN v_status = 'applied'
                THEN pg_catalog.jsonb_build_object('option', v_opt, 'status',
                       CASE WHEN v_intent = 'create' THEN 'open' ELSE 'cancelled' END)
                     || CASE WHEN v_clamped
                             THEN pg_catalog.jsonb_build_object('clamped_to_check_in', true)
                             ELSE '{}'::jsonb END END,
           v_adults, v_children,
           CASE WHEN v_status = 'applied' THEN pg_catalog.now() END);
        -- Faz B (0077): işletme denetim kaydı (audit_log_option_fn politikası: app.option_fn +
        -- 'option.%'). Yalnız kimlikler, tarihler ve süreler; mesaj metni, telefon, misafir adı YOK.
        IF v_status = 'applied' AND v_intent = 'extend' THEN
          INSERT INTO public.audit_log (id, workspace_id, actor_user_id, action, target_type,
                                        target_id, metadata)
          VALUES (pg_catalog.gen_random_uuid(), m.workspace_id, NULL, 'option.extended',
                  'reservation_option', v_target,
                  pg_catalog.jsonb_build_object('operation', v_op, 'source', 'whatsapp',
                    'added_minutes', v_minutes, 'expires_before', v_target_exp,
                    'expires_after', v_new_exp));
        ELSIF v_status = 'applied' AND v_intent = 'reschedule' THEN
          INSERT INTO public.audit_log (id, workspace_id, actor_user_id, action, target_type,
                                        target_id, metadata)
          VALUES (pg_catalog.gen_random_uuid(), m.workspace_id, NULL, 'option.rescheduled',
                  'reservation_option', v_opt,
                  pg_catalog.jsonb_build_object('operation', v_op, 'source', 'whatsapp',
                    'previous_option', v_target, 'previous_check_in', v_t_in,
                    'previous_check_out', v_t_out, 'check_in', v_in, 'check_out', v_out,
                    'expires_at', v_target_exp));
        END IF;
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

-- Opsiyon guard: replaces_option_id değişmez (gövde 0067 + tek koşul)
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
     OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL)
     -- Faz B (0077): tarih değişikliği bağlantısı yalnız oluştururken yazılır.
     OR NEW.replaces_option_id IS DISTINCT FROM OLD.replaces_option_id THEN
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
--> statement-breakpoint

-- Opsiyon geçmişi: olay anındaki bitiş ve uzatmanın kaynak mesajı (gövde 0067 + işaretli farklar)
CREATE OR REPLACE FUNCTION public.app_reservation_options_history() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.option_fn', true);
  v_event text;
  v_admin uuid := NULLIF(pg_catalog.current_setting('app.option_admin', true), '')::uuid;
  -- Faz B (0077): durum değişmeyen güncellemede (uzatma) kaynak mesaj, opsiyonu yazan fonksiyonun
  -- aynı transaction'da koyduğu app.option_message ayarından okunur.
  v_msg uuid := NULLIF(pg_catalog.current_setting('app.option_message', true), '')::uuid;
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
     actor_admin_id, message_id, converted_reservation_id, version, created_at, expires_at)
  VALUES
    (pg_catalog.gen_random_uuid(), NEW.id, NEW.workspace_id, v_event,
     CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status, NEW.end_reason,
     CASE WHEN TG_OP = 'INSERT' THEN NEW.created_by
          ELSE coalesce(NEW.ended_by_user_id, NEW.updated_by) END,
     v_admin,
     CASE WHEN TG_OP = 'INSERT' THEN NEW.origin_message_id
          WHEN NEW.status <> OLD.status THEN NEW.ended_by_message_id
          ELSE v_msg END,
     NEW.converted_reservation_id, NEW.version, pg_catalog.now(), NEW.expires_at);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev, ''), true);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- Olay guard: expires_at değişmez (gövde 0067 + tek koşul)
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
     AND NEW.expires_at IS NOT DISTINCT FROM OLD.expires_at
     AND (NEW.actor_user_id IS NOT DISTINCT FROM OLD.actor_user_id OR NEW.actor_user_id IS NULL)
     AND (NEW.actor_admin_id IS NOT DISTINCT FROM OLD.actor_admin_id OR NEW.actor_admin_id IS NULL)
     AND (NEW.message_id IS NOT DISTINCT FROM OLD.message_id OR NEW.message_id IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'option_history_immutable'
    USING ERRCODE = 'check_violation', DETAIL = 'Opsiyon geçmişi değiştirilemez.';
END
$$;
--> statement-breakpoint

-- Super Admin: tarih değişikliği zinciri (önceki = bu opsiyonun yerini aldığı, sonraki = bunun
-- yerine açılan). Yalnız aynı işletme (bileşik FK zaten zorlar); YALNIZ app_admin.
CREATE FUNCTION public.app_option_admin_option_links(p_admin uuid, p_option uuid)
  RETURNS TABLE (relation text, id uuid, status text, check_in date, check_out date,
                 end_reason text, created_at timestamptz)
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
    SELECT 'previous'::text, p.id, p.status, p.check_in, p.check_out, p.end_reason, p.created_at
      FROM public.reservation_options o
      JOIN public.reservation_options p
        ON p.id = o.replaces_option_id AND p.workspace_id = o.workspace_id
     WHERE o.id = p_option
    UNION ALL
    SELECT 'next'::text, n.id, n.status, n.check_in, n.check_out, n.end_reason, n.created_at
      FROM public.reservation_options o
      JOIN public.reservation_options n
        ON n.replaces_option_id = o.id AND n.workspace_id = o.workspace_id
     WHERE o.id = p_option;
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_option_admin_option_links(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_option_admin_option_links(uuid, uuid) TO app_admin;
