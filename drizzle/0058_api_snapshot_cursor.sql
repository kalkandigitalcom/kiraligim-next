-- 0058_api_snapshot_cursor (API 2. aşama, 3. adım: snapshot ve cursor)
--
-- Tablolar 0057'dedir: api_sync_state (tek satır), api_calendar_changes; ayrıca
-- api_calendar_connections.cursor_key. Bu migration:
--
--   1. api_sync_state'in tek satırı (id = 1, last_change_id = 0) eklenir; iki tabloda ENABLE + FORCE
--      RLS, PUBLIC'ten bütün yetkiler geri alınır (hiçbir uygulama rolü doğrudan erişemez).
--   2. Snapshot (app_api_snapshot) — READ COMMITTED, iki adım:
--        a) SELECT … FROM api_sync_state WHERE id = 1 FOR SHARE: değişiklik kaydını yazan işlemci
--           transaction'ı (ilk ifadesi bu satırı UPDATE ile kilitler) varsa bitmesi beklenir; kilit
--           tutulduğu sürece hiçbir işlemci transaction'ı tamamlanamaz.
--        b) TEK SQL ifadesi: cursor (last_change_id) + 12 ay geri / 24 ay ileri dolu aralıklar.
--           Tek ifade = tek veri anı (READ COMMITTED'da ifade başına snapshot; STABLE yardımcı
--           fonksiyon çağıran ifadenin snapshot'ını kullanır). REPEATABLE READ KULLANILMAZ: orada
--           veri anı, kilit beklenmeden ÖNCE (ilk ifadenin başında) alınırdı.
--      Snapshot'tan sonra kaydedilen her takvim değişikliği 1. adımdaki tetikleyiciyle aynı
--      transaction'da "değişti" satırı bırakır; işlemci onu snapshot'tan SONRA işler (kilit) ve
--      kimliği cursor'dan büyük bir değişiklik kaydı yazar → hiçbir değişiklik kaybolmaz.
--   3. Değişiklikler (app_api_changes): cursor'dan sonraki kayıtlar, yalnız bağlantının villası;
--      last_change_id ile kayıtlar TEK ifadede okunur (yalnız işlemci yazar, kimlikler kayıt
--      sırasıyla artar → atlama ya da çift okuma olmaz).
--   4. Cursor: "c1.<bağlantı>.<değişiklik kimliği>.<verilme zamanı>.<imza>". İmza, bağlantıya
--      özel rastgele cursor_key ile (iç içe SHA-256) üretilir: başka bağlantının ya da
--      değiştirilmiş cursor geçersizdir (400 invalid_cursor). 30 günden eski cursor veya
--      saklama süresi dolmuş kayıtları gerektiren cursor → 410 cursor_expired (yeniden snapshot).
--   5. Snapshot ve değişiklik okuma bağlantının last_synced_at alanını günceller. Yalnız ETKİN
--      (paused olmayan, bitmemiş) bağlantı kullanılabilir; aksi hâlde bulunamadı.
--
-- Mevcut fonksiyonlar, tetikleyiciler ve 1./2. adım davranışı DEĞİŞMEZ; api_calendar_dirty
-- okunmaz ve silinmez.
--
-- Geri alma: DROP FUNCTION app_api_snapshot(text, uuid), app_api_changes(text, uuid, text, integer),
--   app_api_busy_json(uuid, date, date), app_api_cursor_mac(text, text),
--   app_api_cursor_issue(text, uuid, bigint), app_api_cursor_parse(text, uuid, text);
--   DROP TABLE api_calendar_changes, api_sync_state;
--   ALTER TABLE api_calendar_connections DROP COLUMN cursor_key.

-- ---------------------------------------------------------------------------
-- 1. Tek satır, RLS ve yetkiler
-- ---------------------------------------------------------------------------
INSERT INTO public.api_sync_state (id, last_change_id, pruned_through_id) VALUES (1, 0, 0);
--> statement-breakpoint
ALTER TABLE public.api_sync_state ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.api_sync_state FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.api_calendar_changes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.api_calendar_changes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE public.api_sync_state, public.api_calendar_changes FROM PUBLIC;
--> statement-breakpoint
CREATE POLICY api_sync_state_api_fn ON public.api_sync_state FOR ALL TO app_migrator
  USING (pg_catalog.current_setting('app.api_fn', true) = 'on')
  WITH CHECK (pg_catalog.current_setting('app.api_fn', true) = 'on');
--> statement-breakpoint
CREATE POLICY api_calendar_changes_api_fn ON public.api_calendar_changes FOR ALL TO app_migrator
  USING (pg_catalog.current_setting('app.api_fn', true) = 'on')
  WITH CHECK (pg_catalog.current_setting('app.api_fn', true) = 'on');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. İç yardımcılar (kimseye EXECUTE yok)
-- ---------------------------------------------------------------------------
-- Dolu aralıklar (app_api_busy ile aynı kural), JSON dizisi. STABLE: çağıran ifadenin veri anını
-- kullanır. Erişim denetimi YOKTUR — yalnız denetimi yapmış fonksiyonlardan çağrılır.
CREATE FUNCTION public.app_api_busy_json(p_property uuid, p_from date, p_to date)
  RETURNS jsonb
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  WITH spans AS (
    SELECT pg_catalog.daterange(r.check_in, r.check_out, '[)') AS d
      FROM public.reservations r
     WHERE r.property_id = p_property
       AND r.status IN ('pending', 'confirmed')
       AND r.check_in < p_to AND r.check_out > p_from
    UNION ALL
    SELECT pg_catalog.daterange(e.start_date, e.end_date, '[)')
      FROM public.external_calendar_events e
      JOIN public.external_calendar_sources s
        ON s.id = e.source_id AND s.workspace_id = e.workspace_id
     WHERE e.property_id = p_property
       AND e.is_active AND s.is_active
       AND e.start_date < p_to AND e.end_date > p_from
  ), merged AS (
    SELECT pg_catalog.unnest(pg_catalog.range_agg(
             sp.d * pg_catalog.daterange(p_from, p_to, '[)'))) AS b
      FROM spans sp
  )
  SELECT coalesce(pg_catalog.jsonb_agg(
           pg_catalog.jsonb_build_object(
             'start_date', pg_catalog.to_char(pg_catalog.lower(m.b), 'YYYY-MM-DD'),
             'end_date', pg_catalog.to_char(pg_catalog.upper(m.b), 'YYYY-MM-DD'))
           ORDER BY pg_catalog.lower(m.b)), '[]'::jsonb)
    FROM merged m
   WHERE NOT pg_catalog.isempty(m.b)
$$;
--> statement-breakpoint

-- İç içe SHA-256 (gizli anahtarla): sha256(k ‖ ':' ‖ hex(sha256(k ‖ ':' ‖ yük))), ilk 128 bit.
CREATE FUNCTION public.app_api_cursor_mac(p_key text, p_payload text)
  RETURNS text
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.left(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
           p_key || ':' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
             p_key || ':' || p_payload, 'UTF8')), 'hex'), 'UTF8')), 'hex'), 32)
$$;
--> statement-breakpoint

CREATE FUNCTION public.app_api_cursor_issue(p_key text, p_connection uuid, p_change bigint)
  RETURNS text
  LANGUAGE sql VOLATILE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT x.payload || '.' || public.app_api_cursor_mac(p_key, x.payload)
    FROM (SELECT 'c1.' || pg_catalog.replace(p_connection::text, '-', '') || '.' || p_change::text
                 || '.' || pg_catalog.floor(pg_catalog.date_part('epoch', pg_catalog.clock_timestamp()))::bigint::text
                 AS payload) x
$$;
--> statement-breakpoint

-- Geçerliyse tek satır (değişiklik kimliği, verilme zamanı); biçim, bağlantı veya imza
-- uymazsa satır yok.
CREATE FUNCTION public.app_api_cursor_parse(p_key text, p_connection uuid, p_cursor text)
  RETURNS TABLE (change_id bigint, issued_at timestamptz)
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT m[2]::bigint, pg_catalog.to_timestamp(m[3]::double precision)
    FROM (SELECT pg_catalog.regexp_match(coalesce(p_cursor, ''),
                 '^c1\.([0-9a-f]{32})\.([0-9]{1,18})\.([0-9]{1,12})\.([0-9a-f]{32})$') AS m) x
   WHERE x.m IS NOT NULL
     AND x.m[1] = pg_catalog.replace(p_connection::text, '-', '')
     AND x.m[4] = public.app_api_cursor_mac(
           p_key, 'c1.' || x.m[1] || '.' || x.m[2] || '.' || x.m[3])
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Snapshot
-- ---------------------------------------------------------------------------
-- Etkin bağlantı yoksa (başka acentenin, paused, bitmiş, olmayan) satır dönmez.
CREATE FUNCTION public.app_api_snapshot(p_hash text, p_connection uuid)
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
       SET last_synced_at = pg_catalog.clock_timestamp()
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

-- ---------------------------------------------------------------------------
-- 4. Cursor'dan sonraki değişiklikler
-- ---------------------------------------------------------------------------
-- outcome: ok | not_found (etkin bağlantı yok) | invalid_cursor | cursor_expired.
CREATE FUNCTION public.app_api_changes(p_hash text, p_connection uuid, p_cursor text,
                                       p_limit integer)
  RETURNS TABLE (outcome text, connection_id uuid, property_id uuid, external_property_id text,
                 changes jsonb, next_cursor text, has_more boolean)
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

  SELECT r.property_id, r.external_property_id, c.cursor_key
    INTO v_property, v_external, v_key
    FROM public.app_api_connection_rows(v_client) r
    JOIN public.api_calendar_connections c ON c.id = r.id
   WHERE r.id = p_connection AND r.status = 'active';
  IF v_property IS NULL THEN
    v_out := 'not_found';
  ELSE
    SELECT x.change_id, x.issued_at INTO v_from, v_issued
      FROM public.app_api_cursor_parse(v_key, p_connection, p_cursor) x;
    SELECT s.last_change_id, s.pruned_through_id INTO v_last, v_pruned
      FROM public.api_sync_state s WHERE s.id = 1;
    IF v_from IS NULL OR v_from > v_last
       OR v_issued > pg_catalog.clock_timestamp() + interval '5 minutes' THEN
      v_out := 'invalid_cursor';
    ELSIF v_issued < pg_catalog.clock_timestamp() - interval '30 days' OR v_from < v_pruned THEN
      v_out := 'cursor_expired';
    END IF;
  END IF;

  IF v_out = 'ok' THEN
    -- TEK ifade: üst sınır (last_change_id) ve kayıtlar aynı veri anından.
    WITH st AS (
      SELECT s.last_change_id AS last FROM public.api_sync_state s WHERE s.id = 1
    ), page AS (
      SELECT c.id, c.start_date, c.end_date, c.busy
        FROM public.api_calendar_changes c, st
       WHERE c.property_id = v_property AND c.id > v_from AND c.id <= st.last
       ORDER BY c.id
       LIMIT v_limit + 1
    ), shown AS (
      SELECT * FROM page ORDER BY id LIMIT v_limit
    )
    SELECT st.last,
           coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                       'change_id', sh.id::text,
                       'start_date', pg_catalog.to_char(sh.start_date, 'YYYY-MM-DD'),
                       'end_date', pg_catalog.to_char(sh.end_date, 'YYYY-MM-DD'),
                       'busy_dates', sh.busy) ORDER BY sh.id) FROM shown sh), '[]'::jsonb),
           (SELECT pg_catalog.count(*) FROM page) > v_limit,
           (SELECT pg_catalog.max(sh.id) FROM shown sh)
      INTO v_last, v_changes, v_more, v_max
      FROM st;
    UPDATE public.api_calendar_connections c
       SET last_synced_at = pg_catalog.clock_timestamp()
     WHERE c.id = p_connection;
    RETURN QUERY SELECT v_out, p_connection, v_property, v_external, v_changes,
                        public.app_api_cursor_issue(
                          v_key, p_connection,
                          CASE WHEN v_more THEN v_max ELSE GREATEST(v_from, v_last) END),
                        v_more;
  ELSE
    RETURN QUERY SELECT v_out, NULL::uuid, NULL::uuid, NULL::text, NULL::jsonb, NULL::text,
                        NULL::boolean;
  END IF;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. EXECUTE yetkileri
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.app_api_busy_json(uuid, date, date),
  public.app_api_cursor_mac(text, text),
  public.app_api_cursor_issue(text, uuid, bigint),
  public.app_api_cursor_parse(text, uuid, text),
  public.app_api_snapshot(text, uuid),
  public.app_api_changes(text, uuid, text, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_api_snapshot(text, uuid),
  public.app_api_changes(text, uuid, text, integer) TO app_user;
