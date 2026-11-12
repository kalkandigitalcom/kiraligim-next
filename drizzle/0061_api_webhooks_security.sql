-- 0061_api_webhooks_security (API 2. aşama, 5. adım: webhook + hesap geneli değişiklik akışı)
--
-- Tablolar/kolonlar 0060'tadır: api_webhook_endpoints, api_webhook_deliveries,
-- api_clients.cursor_key, api_calendar_connections.snapshot_change_id. Bu migration:
--
--   1. İki yeni tabloda ENABLE + FORCE RLS; PUBLIC yetkileri geri alınır (doğrudan erişim yok).
--   2. Mevcut fonksiyonlar AYNI imzayla yeniden tanımlanır (önceki dosyalar değişmez):
--        app_api_snapshot            — + snapshot_change_id (son snapshot'ın cursor kimliği)
--        app_api_disconnect          — + bekleyen teslimler iptal (connection_ended)
--        app_api_end_grant_connections — + izin kaldırılınca bekleyen teslimler iptal
--        app_api_process_changes     — + değişiklik kaydıyla AYNI transaction'da teslim kaydı
--      Dış davranışları (yanıtlar, kurallar) değişmez.
--   3. Webhook adresi: app_api_webhook_get / _put / _rotate / _delete (anahtar özetiyle).
--      Sır uygulamada şifrelenir; veritabanı yalnız şifreli hâlini görür.
--   4. Hesap geneli akış: app_api_account_changes — cursor hesaba özel ("a1.…", HMAC-SHA256,
--      api_clients.cursor_key), 30 gün / saklama sınırı bağlantı akışıyla aynı; yalnız etkin ve
--      snapshot alınmış bağlantılar, her biri için yalnız son snapshot'tan sonraki değişiklikler.
--   5. Teslim: app_api_claim_deliveries / app_api_finish_delivery / app_api_prune_deliveries.
--
-- Geri alma: DROP FUNCTION (bölüm 3–6'daki yeni fonksiyonlar); 2. bölümdeki dört fonksiyonu
--   önceki migration'lardaki tanımlarıyla yeniden oluşturun; DROP TABLE api_webhook_deliveries,
--   api_webhook_endpoints; ALTER TABLE api_clients DROP COLUMN cursor_key;
--   ALTER TABLE api_calendar_connections DROP COLUMN snapshot_change_id.

-- ---------------------------------------------------------------------------
-- 1. RLS ve yetkiler
-- ---------------------------------------------------------------------------
ALTER TABLE public.api_webhook_endpoints ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.api_webhook_endpoints FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.api_webhook_deliveries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.api_webhook_deliveries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE public.api_webhook_endpoints, public.api_webhook_deliveries FROM PUBLIC;
--> statement-breakpoint
CREATE POLICY api_webhook_endpoints_api_fn ON public.api_webhook_endpoints FOR ALL TO app_migrator
  USING (pg_catalog.current_setting('app.api_fn', true) = 'on')
  WITH CHECK (pg_catalog.current_setting('app.api_fn', true) = 'on');
--> statement-breakpoint
CREATE POLICY api_webhook_deliveries_api_fn ON public.api_webhook_deliveries FOR ALL TO app_migrator
  USING (pg_catalog.current_setting('app.api_fn', true) = 'on')
  WITH CHECK (pg_catalog.current_setting('app.api_fn', true) = 'on');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. İç yardımcı: bekleyen teslimleri iptal (kimseye EXECUTE yok)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_api_cancel_deliveries(p_connection uuid, p_client uuid, p_reason text)
  RETURNS integer
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.api_webhook_deliveries d
     SET status = 'cancelled', cancel_reason = p_reason, finished_at = pg_catalog.clock_timestamp(),
         lease_token = NULL, lease_until = NULL
   WHERE d.status = 'pending'
     AND (p_connection IS NULL OR d.connection_id = p_connection)
     AND (p_client IS NULL OR d.client_id = p_client);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Mevcut fonksiyonlar (aynı imza)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_api_snapshot(p_hash text, p_connection uuid)
  RETURNS TABLE (connection_id uuid, property_id uuid, external_property_id text,
                 from_date text, to_date text, busy jsonb, cursor text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
  v_client uuid;
  v_property uuid;
  v_external text;
  v_key text;
  v_today date;
  v_from date;
  v_to date;
  v_last bigint;
  v_busy jsonb;
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
  SELECT r.client_id INTO v_client FROM public.app_api_resolve_key(p_hash) r
   WHERE r.client_status = 'active' LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'api_unauthorized' USING ERRCODE = 'invalid_authorization_specification';
  END IF;

  -- a) Kilit: çalışan işlemci transaction'ı bitene kadar bekle; bu transaction bitene kadar
  --    işlemci tamamlanamaz.
  PERFORM 1 FROM public.api_sync_state s WHERE s.id = 1 FOR SHARE;

  -- b) TEK ifade: bağlantı (hâlâ etkin mi), cursor ve dolu aralıklar aynı veri anından.
  v_today := (pg_catalog.clock_timestamp() AT TIME ZONE 'Europe/Istanbul')::date;
  v_from := v_today - 366;
  v_to := v_today + 731;
  SELECT r.property_id, r.external_property_id, c.cursor_key, s.last_change_id,
         public.app_api_busy_json(r.property_id, v_from, v_to)
    INTO v_property, v_external, v_key, v_last, v_busy
    FROM public.app_api_connection_rows(v_client) r
    JOIN public.api_calendar_connections c ON c.id = r.id
    CROSS JOIN public.api_sync_state s
   WHERE r.id = p_connection AND r.status = 'active' AND s.id = 1;

  IF v_property IS NOT NULL THEN
    UPDATE public.api_calendar_connections c
       SET last_synced_at = pg_catalog.clock_timestamp(), snapshot_change_id = v_last
     WHERE c.id = p_connection;
    RETURN QUERY SELECT p_connection, v_property, v_external,
                        pg_catalog.to_char(v_from, 'YYYY-MM-DD'),
                        pg_catalog.to_char(v_to, 'YYYY-MM-DD'), v_busy,
                        public.app_api_cursor_issue(v_key, p_connection, v_last);
  END IF;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.app_api_disconnect(p_hash text, p_id uuid)
  RETURNS TABLE (outcome text, id uuid, property_id uuid, external_property_id text, status text,
                 created_at timestamptz, ended_at timestamptz, last_synced_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
  v_client uuid;
  v_c record;
  v_out text;
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
  SELECT r.client_id INTO v_client FROM public.app_api_resolve_key(p_hash) r
   WHERE r.client_status = 'active' LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'api_unauthorized' USING ERRCODE = 'invalid_authorization_specification';
  END IF;
  UPDATE public.api_calendar_connections c
     SET status = 'disconnected', ended_at = pg_catalog.now(), end_reason = 'agency'
   WHERE c.id = p_id AND c.client_id = v_client AND c.status = 'active'
  RETURNING c.workspace_id, c.property_id INTO v_c;
  IF FOUND THEN
    INSERT INTO public.audit_log (id, workspace_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (public.app_uuid_v7(), v_c.workspace_id, NULL, 'api.calendar_disconnected',
            'api_calendar_connection', p_id,
            pg_catalog.jsonb_build_object('property', v_c.property_id, 'client', v_client,
                                          'by', 'agency'));
    PERFORM public.app_api_cancel_deliveries(p_id, NULL, 'connection_ended');
    v_out := 'disconnected';
  ELSIF EXISTS (SELECT 1 FROM public.api_calendar_connections c
                 WHERE c.id = p_id AND c.client_id = v_client) THEN
    v_out := 'ended';
  ELSE
    v_out := 'not_found';
  END IF;
  RETURN QUERY
    SELECT v_out, r.id, r.property_id, r.external_property_id, r.status, r.created_at,
           r.ended_at, r.last_synced_at
      FROM (SELECT 1) x
      LEFT JOIN public.app_api_connection_rows(v_client) r ON r.id = p_id;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.app_api_end_grant_connections(p_grant uuid, p_by text, p_actor uuid,
                                                     p_admin uuid)
  RETURNS integer
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_c record;
  v_n integer := 0;
BEGIN
  FOR v_c IN
    UPDATE public.api_calendar_connections c
       SET status = 'revoked', ended_at = pg_catalog.now(), end_reason = 'grant_revoked'
     WHERE c.grant_id = p_grant AND c.status = 'active'
    RETURNING c.id, c.workspace_id, c.property_id, c.client_id
  LOOP
    v_n := v_n + 1;
    PERFORM public.app_api_cancel_deliveries(v_c.id, NULL, 'connection_ended');
    INSERT INTO public.audit_log (id, workspace_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (public.app_uuid_v7(), v_c.workspace_id, p_actor, 'api.calendar_disconnected',
            'api_calendar_connection', v_c.id,
            pg_catalog.jsonb_build_object('property', v_c.property_id, 'client', v_c.client_id,
                                          'by', p_by));
    IF p_admin IS NOT NULL THEN
      INSERT INTO public.admin_audit_log (id, admin_id, action, target_type, target_id, metadata)
      VALUES (pg_catalog.gen_random_uuid(), p_admin, 'api.calendar_disconnected',
              'api_calendar_connection', v_c.id,
              pg_catalog.jsonb_build_object('client', v_c.client_id, 'property', v_c.property_id));
    END IF;
  END LOOP;
  RETURN v_n;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.app_api_process_changes(p_max_properties integer)
  RETURNS TABLE (processed integer, failed integer, changes integer, discarded integer,
                 last_change_id bigint)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
  v_max integer := LEAST(GREATEST(coalesce(p_max_properties, 50), 1), 500);
  v_today date;
  v_from date;
  v_to date;
  v_now timestamptz;
  v_prop uuid;
  v_n integer;
  v_processed integer := 0;
  v_failed integer := 0;
  v_changes integer := 0;
  v_discarded integer := 0;
  v_last bigint;
  v_state text;
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);

  -- a) Kilit (ilk ifade): snapshot'lar ve diğer işlemci çağrıları bu transaction'la sıralanır.
  UPDATE public.api_sync_state s SET updated_at = pg_catalog.clock_timestamp() WHERE s.id = 1;

  v_now := pg_catalog.clock_timestamp();
  v_today := (v_now AT TIME ZONE 'Europe/Istanbul')::date;
  v_from := v_today - 366;
  v_to := v_today + 731;

  -- b) Sırası gelmiş villalar (en eski satıra göre).
  FOR v_prop IN
    SELECT d.property_id
      FROM public.api_calendar_dirty d
     WHERE d.next_attempt_at IS NULL OR d.next_attempt_at <= v_now
     GROUP BY d.property_id
     ORDER BY pg_catalog.min(d.id)
     LIMIT v_max
  LOOP
    BEGIN
      IF EXISTS (SELECT 1 FROM public.api_calendar_connections c
                  WHERE c.property_id = v_prop AND c.status = 'active') THEN
        -- c) TEK ifade: tüket + birleştir + kırp + güncel doluluk + yaz.
        WITH consumed AS (
          DELETE FROM public.api_calendar_dirty d
           WHERE d.property_id = v_prop
             AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= v_now)
          RETURNING d.start_date, d.end_date
        ), merged AS (
          SELECT pg_catalog.unnest(pg_catalog.range_agg(
                   pg_catalog.daterange(x.start_date, x.end_date, '[)')
                   * pg_catalog.daterange(v_from, v_to, '[)'))) AS b
            FROM consumed x
        ), written AS (
          INSERT INTO public.api_calendar_changes (property_id, start_date, end_date, busy)
          SELECT v_prop, pg_catalog.lower(m.b), pg_catalog.upper(m.b),
                 public.app_api_busy_json(v_prop, pg_catalog.lower(m.b), pg_catalog.upper(m.b))
            FROM merged m
           WHERE NOT pg_catalog.isempty(m.b)
           ORDER BY pg_catalog.lower(m.b)
          RETURNING api_calendar_changes.id
        ), queued AS (
          -- 5. adım: webhook teslimleri AYNI transaction'da (yalnız webhook adresi olan, snapshot
          -- almış, etkin ve paused olmayan bağlantılar). Olay kimliği burada sabitlenir.
          INSERT INTO public.api_webhook_deliveries (id, client_id, connection_id, change_id)
          SELECT public.app_uuid_v7(), c.client_id, c.id, w.id
            FROM written w
            JOIN public.api_calendar_connections c
              ON c.property_id = v_prop AND c.status = 'active' AND c.snapshot_change_id IS NOT NULL
            JOIN public.api_access_grants g ON g.id = c.grant_id AND g.status = 'active'
            JOIN public.properties p ON p.id = c.property_id AND p.workspace_id = c.workspace_id
                                    AND p.status = 'active'
            JOIN public.workspaces ws ON ws.id = c.workspace_id AND ws.status = 'active'
            JOIN public.api_webhook_endpoints e ON e.client_id = c.client_id
          ORDER BY w.id
          RETURNING 1
        )
        SELECT pg_catalog.count(*)::integer INTO v_n FROM written;
        v_changes := v_changes + v_n;
        v_processed := v_processed + 1;
      ELSE
        DELETE FROM public.api_calendar_dirty d
         WHERE d.property_id = v_prop
           AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= v_now);
        v_discarded := v_discarded + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- d) Yalnız bu villa geri alındı; satırlar korunur, yeniden deneme bilgisi yazılır.
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
      UPDATE public.api_calendar_dirty d
         SET attempts = d.attempts + 1,
             next_attempt_at = v_now + LEAST(interval '10 seconds' * (2 ^ LEAST(d.attempts, 12)),
                                             interval '1 hour'),
             last_error = 'sqlstate_' || pg_catalog.lower(coalesce(v_state, 'xxxxx'))
       WHERE d.property_id = v_prop
         AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= v_now);
      v_failed := v_failed + 1;
    END;
  END LOOP;

  -- e) Son kimlik (aynı transaction, aynı kilit altında).
  UPDATE public.api_sync_state s
     SET last_change_id = GREATEST(s.last_change_id,
                                   coalesce((SELECT pg_catalog.max(c.id)
                                               FROM public.api_calendar_changes c), 0)),
         updated_at = pg_catalog.clock_timestamp()
   WHERE s.id = 1
  RETURNING s.last_change_id INTO v_last;

  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RETURN QUERY SELECT v_processed, v_failed, v_changes, v_discarded, v_last;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Webhook adresi (acente, API anahtarı özetiyle)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_api_webhook_get(p_hash text)
  RETURNS TABLE (url text, created_at timestamptz, updated_at timestamptz,
                 secret_rotated_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
  v_client uuid;
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
  SELECT r.client_id INTO v_client FROM public.app_api_resolve_key(p_hash) r
   WHERE r.client_status = 'active' LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'api_unauthorized' USING ERRCODE = 'invalid_authorization_specification';
  END IF;
  RETURN QUERY SELECT e.url, e.created_at, e.updated_at, e.secret_rotated_at
                 FROM public.api_webhook_endpoints e WHERE e.client_id = v_client;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- Oluştur (sır yalnız oluşturmada kullanılır) ya da adresi değiştir (sır korunur).
-- Dönüş: created | updated + kayıt.
CREATE FUNCTION public.app_api_webhook_put(p_hash text, p_url text, p_secret_enc text)
  RETURNS TABLE (outcome text, url text, created_at timestamptz, updated_at timestamptz,
                 secret_rotated_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
  v_client uuid;
  v_created boolean;
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
  SELECT r.client_id INTO v_client FROM public.app_api_resolve_key(p_hash) r
   WHERE r.client_status = 'active' LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'api_unauthorized' USING ERRCODE = 'invalid_authorization_specification';
  END IF;
  INSERT INTO public.api_webhook_endpoints AS e (client_id, url, secret_enc)
  VALUES (v_client, p_url, p_secret_enc)
  ON CONFLICT (client_id) DO UPDATE
    SET url = EXCLUDED.url, updated_at = pg_catalog.clock_timestamp()
  RETURNING (e.xmax = 0) INTO v_created;
  RETURN QUERY SELECT CASE WHEN v_created THEN 'created' ELSE 'updated' END, e.url, e.created_at,
                      e.updated_at, e.secret_rotated_at
                 FROM public.api_webhook_endpoints e WHERE e.client_id = v_client;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- Dönüş: rotated | not_found
CREATE FUNCTION public.app_api_webhook_rotate(p_hash text, p_secret_enc text)
  RETURNS TABLE (outcome text, secret_rotated_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
  v_client uuid;
  v_at timestamptz;
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
  SELECT r.client_id INTO v_client FROM public.app_api_resolve_key(p_hash) r
   WHERE r.client_status = 'active' LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'api_unauthorized' USING ERRCODE = 'invalid_authorization_specification';
  END IF;
  UPDATE public.api_webhook_endpoints e
     SET secret_enc = p_secret_enc, secret_rotated_at = pg_catalog.clock_timestamp(),
         updated_at = pg_catalog.clock_timestamp()
   WHERE e.client_id = v_client
  RETURNING e.secret_rotated_at INTO v_at;
  RETURN QUERY SELECT CASE WHEN v_at IS NULL THEN 'not_found' ELSE 'rotated' END, v_at;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- Dönüş: deleted | not_found. Bekleyen teslimler iptal edilir (no_endpoint).
CREATE FUNCTION public.app_api_webhook_delete(p_hash text)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
  v_client uuid;
  v_out text;
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
  SELECT r.client_id INTO v_client FROM public.app_api_resolve_key(p_hash) r
   WHERE r.client_status = 'active' LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'api_unauthorized' USING ERRCODE = 'invalid_authorization_specification';
  END IF;
  DELETE FROM public.api_webhook_endpoints e WHERE e.client_id = v_client;
  IF FOUND THEN
    PERFORM public.app_api_cancel_deliveries(NULL, v_client, 'no_endpoint');
    v_out := 'deleted';
  ELSE
    v_out := 'not_found';
  END IF;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RETURN v_out;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Hesap geneli değişiklik akışı
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_api_account_cursor_issue(p_key text, p_client uuid, p_change bigint)
  RETURNS text
  LANGUAGE sql VOLATILE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT x.payload || '.' || public.app_api_cursor_mac(p_key, x.payload)
    FROM (SELECT 'a1.' || pg_catalog.replace(p_client::text, '-', '') || '.' || p_change::text
                 || '.' || pg_catalog.floor(pg_catalog.date_part('epoch', pg_catalog.clock_timestamp()))::bigint::text
                 AS payload) x
$$;
--> statement-breakpoint

CREATE FUNCTION public.app_api_account_cursor_parse(p_key text, p_client uuid, p_cursor text)
  RETURNS TABLE (change_id bigint, issued_at timestamptz)
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT m[2]::bigint, pg_catalog.to_timestamp(m[3]::double precision)
    FROM (SELECT pg_catalog.regexp_match(coalesce(p_cursor, ''),
                 '^a1\.([0-9a-f]{32})\.([0-9]{1,18})\.([0-9]{1,12})\.([0-9a-f]{32})$') AS m) x
   WHERE x.m IS NOT NULL
     AND x.m[1] = pg_catalog.replace(p_client::text, '-', '')
     AND x.m[4] = public.app_api_cursor_mac(
           p_key, 'a1.' || x.m[1] || '.' || x.m[2] || '.' || x.m[3])
$$;
--> statement-breakpoint

-- outcome: ok | invalid_cursor | cursor_expired. p_cursor NULL: şimdiki konumdan başla (boş liste).
-- Yalnız acentenin ETKİN (paused değil, bitmemiş) ve snapshot alınmış bağlantıları; her bağlantı
-- için yalnız son snapshot'tan SONRAKİ değişiklikler.
CREATE FUNCTION public.app_api_account_changes(p_hash text, p_cursor text, p_limit integer)
  RETURNS TABLE (outcome text, changes jsonb, next_cursor text, has_more boolean)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
  v_client uuid;
  v_key text;
  v_from bigint;
  v_issued timestamptz;
  v_limit integer := LEAST(GREATEST(coalesce(p_limit, 100), 1), 500);
  v_last bigint;
  v_pruned bigint;
  v_changes jsonb;
  v_more boolean;
  v_max bigint;
  v_out text := 'ok';
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
  SELECT r.client_id INTO v_client FROM public.app_api_resolve_key(p_hash) r
   WHERE r.client_status = 'active' LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'api_unauthorized' USING ERRCODE = 'invalid_authorization_specification';
  END IF;
  SELECT k.cursor_key INTO v_key FROM public.api_clients k WHERE k.id = v_client;
  SELECT s.last_change_id, s.pruned_through_id INTO v_last, v_pruned
    FROM public.api_sync_state s WHERE s.id = 1;

  IF p_cursor IS NULL THEN
    PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
    RETURN QUERY SELECT 'ok'::text, '[]'::jsonb,
                        public.app_api_account_cursor_issue(v_key, v_client, v_last), false;
    RETURN;
  END IF;

  SELECT x.change_id, x.issued_at INTO v_from, v_issued
    FROM public.app_api_account_cursor_parse(v_key, v_client, p_cursor) x;
  IF v_from IS NULL OR v_from > v_last
     OR v_issued > pg_catalog.clock_timestamp() + interval '5 minutes' THEN
    v_out := 'invalid_cursor';
  ELSIF v_issued < pg_catalog.clock_timestamp() - interval '30 days' OR v_from < v_pruned THEN
    v_out := 'cursor_expired';
  END IF;

  IF v_out = 'ok' THEN
    WITH st AS (
      SELECT s.last_change_id AS last FROM public.api_sync_state s WHERE s.id = 1
    ), conns AS (
      SELECT r.id, r.property_id, r.external_property_id, c.snapshot_change_id
        FROM public.app_api_connection_rows(v_client) r
        JOIN public.api_calendar_connections c ON c.id = r.id
       WHERE r.status = 'active' AND c.snapshot_change_id IS NOT NULL
    ), page AS (
      SELECT ch.id, ch.start_date, ch.end_date, ch.busy, k.id AS connection_id, k.property_id,
             k.external_property_id
        FROM public.api_calendar_changes ch
        JOIN conns k ON k.property_id = ch.property_id AND ch.id > k.snapshot_change_id
        CROSS JOIN st
       WHERE ch.id > v_from AND ch.id <= st.last
       ORDER BY ch.id
       LIMIT v_limit + 1
    ), shown AS (
      SELECT * FROM page ORDER BY id LIMIT v_limit
    )
    SELECT st.last,
           coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                       'change_id', sh.id::text,
                       'connection_id', sh.connection_id,
                       'property_id', sh.property_id,
                       'external_property_id', sh.external_property_id,
                       'start_date', pg_catalog.to_char(sh.start_date, 'YYYY-MM-DD'),
                       'end_date', pg_catalog.to_char(sh.end_date, 'YYYY-MM-DD'),
                       'busy_dates', sh.busy) ORDER BY sh.id) FROM shown sh), '[]'::jsonb),
           (SELECT pg_catalog.count(*) FROM page) > v_limit,
           (SELECT pg_catalog.max(sh.id) FROM shown sh)
      INTO v_last, v_changes, v_more, v_max
      FROM st;
    RETURN QUERY SELECT v_out, v_changes,
                        public.app_api_account_cursor_issue(
                          v_key, v_client,
                          CASE WHEN v_more THEN v_max ELSE GREATEST(v_from, v_last) END),
                        v_more;
  ELSE
    RETURN QUERY SELECT v_out, NULL::jsonb, NULL::text, NULL::boolean;
  END IF;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. Teslim (işlemci süreci, app_user)
-- ---------------------------------------------------------------------------
-- a) Artık gönderilmemesi gereken bekleyen teslimler iptal edilir (kilitli/uçuşta olanlar hariç):
--    bağlantı bitti / izin kaldırıldı, webhook adresi yok, snapshot daha yeni (superseded), villa
--    veya işletme pasif (paused; yeniden etkinleşince tam pencere değişikliği gelir), değişiklik
--    kaydı saklama süresini aşmış (expired). Hesap pasifse iptal EDİLMEZ, beklenir.
-- b) Bağlantı başına yalnız EN ESKİ bekleyen teslim (sıra), süresi gelmiş ve kilitsizse alınır;
--    FOR UPDATE SKIP LOCKED + kilit belirteci; deneme sayısı artar. Gövde burada üretilir.
CREATE FUNCTION public.app_api_claim_deliveries(p_limit integer, p_lease_seconds integer)
  RETURNS TABLE (id uuid, lease_token uuid, attempt integer, url text, secret_enc text,
                 body text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_limit integer := LEAST(GREATEST(coalesce(p_limit, 10), 1), 100);
  v_lease interval := pg_catalog.make_interval(secs => LEAST(GREATEST(coalesce(p_lease_seconds, 60), 5), 600));
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);

  UPDATE public.api_webhook_deliveries d
     SET status = 'cancelled', cancel_reason = x.reason, finished_at = v_now,
         lease_token = NULL, lease_until = NULL
    FROM (
      SELECT d2.id,
             CASE
               WHEN c.status <> 'active' OR g.status <> 'active' THEN 'connection_ended'
               WHEN e.client_id IS NULL THEN 'no_endpoint'
               WHEN c.snapshot_change_id IS NOT NULL AND d2.change_id <= c.snapshot_change_id
                 THEN 'superseded'
               WHEN p.status <> 'active' OR w.status <> 'active' THEN 'paused'
               WHEN ch.id IS NULL THEN 'expired'
             END AS reason
        FROM public.api_webhook_deliveries d2
        JOIN public.api_calendar_connections c ON c.id = d2.connection_id
        JOIN public.api_access_grants g ON g.id = c.grant_id
        JOIN public.properties p ON p.id = c.property_id AND p.workspace_id = c.workspace_id
        JOIN public.workspaces w ON w.id = c.workspace_id
        LEFT JOIN public.api_webhook_endpoints e ON e.client_id = d2.client_id
        LEFT JOIN public.api_calendar_changes ch ON ch.id = d2.change_id
       WHERE d2.status = 'pending' AND (d2.lease_until IS NULL OR d2.lease_until < v_now)
    ) x
   WHERE d.id = x.id AND x.reason IS NOT NULL AND d.status = 'pending';

  RETURN QUERY
    WITH heads AS (
      SELECT DISTINCT ON (d.connection_id) d.id, d.client_id, d.next_attempt_at, d.lease_until
        FROM public.api_webhook_deliveries d
       WHERE d.status = 'pending'
       ORDER BY d.connection_id, d.change_id
    ), cand AS (
      SELECT h.id FROM heads h
        JOIN public.api_clients k ON k.id = h.client_id AND k.status = 'active'
       WHERE h.next_attempt_at <= v_now AND (h.lease_until IS NULL OR h.lease_until < v_now)
       ORDER BY h.next_attempt_at, h.id
       LIMIT v_limit
    ), locked AS (
      SELECT d.id FROM public.api_webhook_deliveries d
       WHERE d.id IN (SELECT cand.id FROM cand)
         FOR UPDATE SKIP LOCKED
    ), upd AS (
      UPDATE public.api_webhook_deliveries d
         SET lease_token = pg_catalog.gen_random_uuid(), lease_until = v_now + v_lease,
             attempts = d.attempts + 1
        FROM locked l
       WHERE d.id = l.id AND d.status = 'pending'
         AND (d.lease_until IS NULL OR d.lease_until < v_now)
      RETURNING d.id, d.lease_token, d.attempts, d.client_id, d.connection_id, d.change_id,
                d.created_at
    )
    SELECT u.id, u.lease_token, u.attempts, e.url, e.secret_enc,
           pg_catalog.jsonb_build_object(
             'id', u.id,
             'type', 'calendar.changed',
             'created_at', pg_catalog.to_char(u.created_at AT TIME ZONE 'UTC',
                                              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'connection_id', c.id,
             'property_id', c.property_id,
             'external_property_id', c.external_property_id,
             'change', pg_catalog.jsonb_build_object(
               'change_id', ch.id::text,
               'start_date', pg_catalog.to_char(ch.start_date, 'YYYY-MM-DD'),
               'end_date', pg_catalog.to_char(ch.end_date, 'YYYY-MM-DD'),
               'busy_dates', ch.busy))::text
      FROM upd u
      JOIN public.api_webhook_endpoints e ON e.client_id = u.client_id
      JOIN public.api_calendar_connections c ON c.id = u.connection_id
      JOIN public.api_calendar_changes ch ON ch.id = u.change_id;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- Sonuç yazımı (kilit belirteci eşleşmeli). Yeniden deneme takvimi (başarısız deneme sayısına göre):
-- 1 dk, 5 dk, 15 dk, 1 sa, 3 sa, 6 sa, 12 sa, 24 sa; 9. başarısız denemeden sonra failed.
-- Dönüş: delivered | retry | failed | stale (kilit süresi dolmuş / başka çalıştırma almış).
CREATE FUNCTION public.app_api_finish_delivery(p_id uuid, p_token uuid, p_ok boolean,
                                               p_status integer, p_error text)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_attempts integer;
  v_out text;
  v_delays interval[] := ARRAY[interval '1 minute', interval '5 minutes', interval '15 minutes',
                               interval '1 hour', interval '3 hours', interval '6 hours',
                               interval '12 hours', interval '24 hours'];
  v_error text := CASE WHEN p_error IS NULL OR p_error !~ '^[a-z0-9_]{1,64}$' THEN NULL ELSE p_error END;
  v_status integer := CASE WHEN p_status BETWEEN 100 AND 599 THEN p_status ELSE NULL END;
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
  SELECT d.attempts INTO v_attempts FROM public.api_webhook_deliveries d
   WHERE d.id = p_id AND d.lease_token = p_token AND d.status = 'pending'
     FOR UPDATE;
  IF NOT FOUND THEN
    v_out := 'stale';
  ELSIF p_ok THEN
    UPDATE public.api_webhook_deliveries d
       SET status = 'delivered', finished_at = v_now, last_status = v_status, last_error = NULL,
           lease_token = NULL, lease_until = NULL
     WHERE d.id = p_id;
    v_out := 'delivered';
  ELSIF v_attempts > pg_catalog.array_length(v_delays, 1) THEN
    UPDATE public.api_webhook_deliveries d
       SET status = 'failed', finished_at = v_now, last_status = v_status,
           last_error = coalesce(v_error, 'error'), lease_token = NULL, lease_until = NULL
     WHERE d.id = p_id;
    v_out := 'failed';
  ELSE
    UPDATE public.api_webhook_deliveries d
       SET next_attempt_at = v_now + v_delays[GREATEST(v_attempts, 1)], last_status = v_status,
           last_error = coalesce(v_error, 'error'), lease_token = NULL, lease_until = NULL
     WHERE d.id = p_id;
    v_out := 'retry';
  END IF;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RETURN v_out;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- Saklama: 31 günden eski bitmiş teslim kayıtları (işlemci süreci, saklamayla birlikte).
CREATE FUNCTION public.app_api_prune_deliveries()
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
  v_n integer;
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
  DELETE FROM public.api_webhook_deliveries d
   WHERE d.status <> 'pending' AND d.finished_at < pg_catalog.clock_timestamp() - interval '31 days';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RETURN v_n;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. EXECUTE yetkileri
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.app_api_cancel_deliveries(uuid, uuid, text),
  public.app_api_webhook_get(text),
  public.app_api_webhook_put(text, text, text),
  public.app_api_webhook_rotate(text, text),
  public.app_api_webhook_delete(text),
  public.app_api_account_cursor_issue(text, uuid, bigint),
  public.app_api_account_cursor_parse(text, uuid, text),
  public.app_api_account_changes(text, text, integer),
  public.app_api_claim_deliveries(integer, integer),
  public.app_api_finish_delivery(uuid, uuid, boolean, integer, text),
  public.app_api_prune_deliveries() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_api_webhook_get(text),
  public.app_api_webhook_put(text, text, text),
  public.app_api_webhook_rotate(text, text),
  public.app_api_webhook_delete(text),
  public.app_api_account_changes(text, text, integer),
  public.app_api_claim_deliveries(integer, integer),
  public.app_api_finish_delivery(uuid, uuid, boolean, integer, text),
  public.app_api_prune_deliveries() TO app_user;
