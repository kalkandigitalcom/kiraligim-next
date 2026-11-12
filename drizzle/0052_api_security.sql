-- 0052_api_security (Acente okuma API'si — 1. aşama: güvenlik ve fonksiyonlar)
--
-- Tablolar 0051'dedir: api_clients, api_keys, api_access_grants, api_rate_windows,
-- api_usage_daily. Bu migration:
--
--   1. Beş tabloda ENABLE + FORCE RLS; PUBLIC'ten bütün yetkiler geri alınır. Hiçbir uygulama rolü
--      (app_user, app_admin, app_worker, app_wa_gateway) bu tablolara DOĞRUDAN erişemez.
--   2. Tek erişim yolu SECURITY DEFINER fonksiyonlardır (sahip app_migrator, search_path sabit).
--      Fonksiyonlar yalnız kendi açtıkları 'app.api_fn' bayrağıyla geçerli dar politikalarla okur/
--      yazar. Mevcut villa, rezervasyon ve takvim tablolarına YALNIZ OKUMA politikası eklenir;
--      bu tablolarda kolon, kısıt, tetikleyici veya mevcut politika DEĞİŞMEZ.
--   3. API istek fonksiyonları (app_user; anahtar özetiyle çağrılır):
--        app_api_begin            — anahtar + hesap durumu + dakikalık sınır + günlük kullanım
--        app_api_note_error       — 4xx yanıtlarını günlük kullanıma işler
--        app_api_properties       — izinli villalar (yalnız id, ad)
--        app_api_property         — tek villa (yalnız id, ad)
--        app_api_busy             — dolu aralıklar [başlangıç, bitiş) (kaynak/misafir bilgisi yok)
--      Her fonksiyon anahtarı, hesabın durumunu ve villa iznini HER ÇAĞRIDA yeniden denetler; izin
--      geri alınınca bir sonraki istekte etkisizdir. İzinsiz, başka acenteye ait veya olmayan villa
--      aynı yanıtı alır (bulunamadı).
--   4. İşletme paneli fonksiyonları (app_user, withTenant bağlamında; owner/manager):
--        app_api_lookup_access_code, app_api_grant_property, app_api_property_grants,
--        app_api_revoke_property_grant
--   5. Super Admin fonksiyonları (app_admin; çağıran yönetici admin_users'ta aktif olmalı):
--        app_api_admin_clients, app_api_admin_client, app_api_admin_create_client,
--        app_api_admin_set_client_status, app_api_admin_keys, app_api_admin_create_key,
--        app_api_admin_revoke_key, app_api_admin_set_access_code, app_api_admin_grants,
--        app_api_admin_grant, app_api_admin_revoke_grant, app_api_admin_usage
--      Her yazma işlemi admin_audit_log'a; izin verme/kaldırma ayrıca işletmenin audit_log'una
--      yazılır (yalnız kimlikler).
--
-- Gizli değerler: API anahtarı ve acente erişim kodu veritabanına yalnız SHA-256 özeti olarak
-- gelir (uygulama özetler); açık hâlleri hiçbir tabloda ve log'da yoktur.
--
-- Dakikalık sınır: (anahtar, dakika) satırında atomik INSERT … ON CONFLICT DO UPDATE … WHERE
-- count < sınır. Sayaç veritabanında olduğundan birden çok uygulama örneği aynı sınırı paylaşır.
-- Eski pencereler anahtarın yeni dakikadaki ilk isteğinde silinir.
--
-- Geri alma (veri kaybı: API hesapları, anahtarlar, izinler, kullanım):
--   DROP FUNCTION app_api_* (aşağıdaki liste) ve app_api_resolve_key(text);
--   DROP POLICY *_api_fn (aşağıdaki politikalar);
--   DROP TABLE api_rate_windows, api_usage_daily, api_access_grants, api_keys, api_clients.

-- ---------------------------------------------------------------------------
-- 1. RLS ve tablo yetkileri
-- ---------------------------------------------------------------------------
ALTER TABLE public.api_clients ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.api_clients FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.api_keys FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.api_access_grants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.api_access_grants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.api_rate_windows ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.api_rate_windows FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.api_usage_daily ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.api_usage_daily FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE public.api_clients, public.api_keys, public.api_access_grants,
  public.api_rate_windows, public.api_usage_daily FROM PUBLIC;
--> statement-breakpoint

CREATE POLICY api_clients_api_fn ON public.api_clients FOR ALL TO app_migrator
  USING (pg_catalog.current_setting('app.api_fn', true) = 'on')
  WITH CHECK (pg_catalog.current_setting('app.api_fn', true) = 'on');
--> statement-breakpoint
CREATE POLICY api_keys_api_fn ON public.api_keys FOR ALL TO app_migrator
  USING (pg_catalog.current_setting('app.api_fn', true) = 'on')
  WITH CHECK (pg_catalog.current_setting('app.api_fn', true) = 'on');
--> statement-breakpoint
CREATE POLICY api_access_grants_api_fn ON public.api_access_grants FOR ALL TO app_migrator
  USING (pg_catalog.current_setting('app.api_fn', true) = 'on')
  WITH CHECK (pg_catalog.current_setting('app.api_fn', true) = 'on');
--> statement-breakpoint
CREATE POLICY api_rate_windows_api_fn ON public.api_rate_windows FOR ALL TO app_migrator
  USING (pg_catalog.current_setting('app.api_fn', true) = 'on')
  WITH CHECK (pg_catalog.current_setting('app.api_fn', true) = 'on');
--> statement-breakpoint
CREATE POLICY api_usage_daily_api_fn ON public.api_usage_daily FOR ALL TO app_migrator
  USING (pg_catalog.current_setting('app.api_fn', true) = 'on')
  WITH CHECK (pg_catalog.current_setting('app.api_fn', true) = 'on');
--> statement-breakpoint

-- Mevcut tablolar: yalnız OKUMA (bayrak yalnız app_api_* fonksiyonları içinde açıktır).
CREATE POLICY properties_api_fn ON public.properties FOR SELECT TO app_migrator
  USING (pg_catalog.current_setting('app.api_fn', true) = 'on');
--> statement-breakpoint
CREATE POLICY workspaces_api_fn ON public.workspaces FOR SELECT TO app_migrator
  USING (pg_catalog.current_setting('app.api_fn', true) = 'on');
--> statement-breakpoint
CREATE POLICY reservations_api_fn ON public.reservations FOR SELECT TO app_migrator
  USING (pg_catalog.current_setting('app.api_fn', true) = 'on'
         AND status IN ('pending', 'confirmed'));
--> statement-breakpoint
CREATE POLICY external_calendar_sources_api_fn ON public.external_calendar_sources
  FOR SELECT TO app_migrator
  USING (pg_catalog.current_setting('app.api_fn', true) = 'on' AND is_active);
--> statement-breakpoint
CREATE POLICY external_calendar_events_api_fn ON public.external_calendar_events
  FOR SELECT TO app_migrator
  USING (pg_catalog.current_setting('app.api_fn', true) = 'on' AND is_active);
--> statement-breakpoint
CREATE POLICY admin_users_api_fn ON public.admin_users FOR SELECT TO app_migrator
  USING (pg_catalog.current_setting('app.api_fn', true) = 'on');
--> statement-breakpoint
CREATE POLICY admin_audit_log_api_fn ON public.admin_audit_log FOR INSERT TO app_migrator
  WITH CHECK (pg_catalog.current_setting('app.api_fn', true) = 'on' AND action LIKE 'api.%');
--> statement-breakpoint
CREATE POLICY audit_log_api_fn ON public.audit_log FOR INSERT TO app_migrator
  WITH CHECK (pg_catalog.current_setting('app.api_fn', true) = 'on' AND action LIKE 'api.%');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. İç yardımcı: anahtar özeti → anahtar + hesap (yalnız etkin anahtar). Kimseye EXECUTE yok;
--    yalnız aşağıdaki SECURITY DEFINER fonksiyonlar (sahip olarak) çağırır.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_api_resolve_key(p_hash text)
  RETURNS TABLE (key_id uuid, client_id uuid, client_status text, client_name text,
                 rate_limit integer, last_used_at timestamptz)
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT k.id, c.id, c.status, c.name, c.rate_limit_per_minute, k.last_used_at
    FROM public.api_keys k
    JOIN public.api_clients c ON c.id = k.client_id
   WHERE p_hash IS NOT NULL AND p_hash ~ '^[0-9a-f]{64}$'
     AND k.secret_hash = p_hash AND k.status = 'active'
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. API istek fonksiyonları
-- ---------------------------------------------------------------------------
-- Dönüş (tek satır): outcome = ok | unauthorized | account_disabled | rate_limited.
-- ok/rate_limited: hesap adı, dakikalık sınır, kalan hak ve pencerenin bitişi.
CREATE FUNCTION public.app_api_begin(p_hash text)
  RETURNS TABLE (outcome text, client_id uuid, client_name text, rate_limit integer,
                 remaining integer, reset_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_window timestamptz := pg_catalog.date_trunc('minute', pg_catalog.clock_timestamp());
  v_day date := (pg_catalog.clock_timestamp() AT TIME ZONE 'Europe/Istanbul')::date;
  v_key record;
  v_count integer;
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
  SELECT * INTO v_key FROM public.app_api_resolve_key(p_hash) LIMIT 1;
  IF NOT FOUND THEN
    PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
    RETURN QUERY SELECT 'unauthorized'::text, NULL::uuid, NULL::text, NULL::integer,
                        NULL::integer, NULL::timestamptz;
    RETURN;
  END IF;
  IF v_key.client_status <> 'active' THEN
    PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
    RETURN QUERY SELECT 'account_disabled'::text, NULL::uuid, NULL::text, NULL::integer,
                        NULL::integer, NULL::timestamptz;
    RETURN;
  END IF;

  INSERT INTO public.api_rate_windows AS w (key_id, window_start, count)
  VALUES (v_key.key_id, v_window, 1)
  ON CONFLICT (key_id, window_start) DO UPDATE SET count = w.count + 1
    WHERE w.count < v_key.rate_limit
  RETURNING w.count INTO v_count;

  IF v_count = 1 THEN
    DELETE FROM public.api_rate_windows w
     WHERE w.key_id = v_key.key_id AND w.window_start < v_window;
  END IF;

  INSERT INTO public.api_usage_daily AS u (client_id, day, requests, rate_limited, errors)
  VALUES (v_key.client_id, v_day,
          CASE WHEN v_count IS NULL THEN 0 ELSE 1 END,
          CASE WHEN v_count IS NULL THEN 1 ELSE 0 END, 0)
  ON CONFLICT (client_id, day) DO UPDATE
    SET requests = u.requests + EXCLUDED.requests,
        rate_limited = u.rate_limited + EXCLUDED.rate_limited;

  IF v_count IS NOT NULL
     AND (v_key.last_used_at IS NULL OR v_key.last_used_at < v_now - interval '1 minute') THEN
    UPDATE public.api_keys k SET last_used_at = v_now WHERE k.id = v_key.key_id;
  END IF;

  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RETURN QUERY SELECT CASE WHEN v_count IS NULL THEN 'rate_limited' ELSE 'ok' END::text,
                      v_key.client_id, v_key.client_name, v_key.rate_limit,
                      GREATEST(v_key.rate_limit - coalesce(v_count, v_key.rate_limit), 0),
                      v_window + interval '1 minute';
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- 4xx yanıtı (geçersiz parametre, bulunamadı) hesabın günlük hata sayısına işlenir.
CREATE FUNCTION public.app_api_note_error(p_hash text)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
  v_client uuid;
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
  SELECT r.client_id INTO v_client FROM public.app_api_resolve_key(p_hash) r LIMIT 1;
  IF v_client IS NOT NULL THEN
    INSERT INTO public.api_usage_daily AS u (client_id, day, requests, rate_limited, errors)
    VALUES (v_client, (pg_catalog.clock_timestamp() AT TIME ZONE 'Europe/Istanbul')::date, 0, 0, 1)
    ON CONFLICT (client_id, day) DO UPDATE SET errors = u.errors + 1;
  END IF;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- İzinli villalar: etkin izin + etkin villa + etkin işletme. Yalnız kimlik ve ad döner.
-- Anahtar geçersiz/geri alınmış ya da hesap pasifse 28000 (api_unauthorized).
CREATE FUNCTION public.app_api_properties(p_hash text, p_after uuid, p_limit integer)
  RETURNS TABLE (id uuid, name text)
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
  RETURN QUERY
    SELECT p.id, p.name
      FROM public.api_access_grants g
      JOIN public.properties p ON p.id = g.property_id AND p.workspace_id = g.workspace_id
      JOIN public.workspaces w ON w.id = p.workspace_id
     WHERE g.client_id = v_client AND g.status = 'active'
       AND p.status = 'active' AND w.status = 'active'
       AND (p_after IS NULL OR p.id > p_after)
     ORDER BY p.id
     LIMIT LEAST(GREATEST(coalesce(p_limit, 100), 1), 500);
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.app_api_property(p_hash text, p_property uuid)
  RETURNS TABLE (id uuid, name text)
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
  RETURN QUERY
    SELECT p.id, p.name
      FROM public.api_access_grants g
      JOIN public.properties p ON p.id = g.property_id AND p.workspace_id = g.workspace_id
      JOIN public.workspaces w ON w.id = p.workspace_id
     WHERE g.client_id = v_client AND g.status = 'active' AND g.property_id = p_property
       AND p.status = 'active' AND w.status = 'active'
     LIMIT 1;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- Dolu aralıklar [start_date, end_date): Kiraligim rezervasyon ve blokları (beklemede/onaylı) ile
-- etkin harici takvim olayları birleştirilir, [p_from, p_to) penceresine kırpılır. Kaynak, misafir
-- ve tutar bilgisi okunmaz/dönmez. İzin yoksa P0002 (api_not_found); pencere geçersizse 22023.
-- Pencere sınırları uygulamadaki API_LIMITS ile aynıdır (bugünden 366 gün geri, 731 gün ileri,
-- en fazla 366 gün).
CREATE FUNCTION public.app_api_busy(p_hash text, p_property uuid, p_from date, p_to date)
  RETURNS TABLE (start_date text, end_date text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
  v_today date := (pg_catalog.clock_timestamp() AT TIME ZONE 'Europe/Istanbul')::date;
  v_client uuid;
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
  SELECT r.client_id INTO v_client FROM public.app_api_resolve_key(p_hash) r
   WHERE r.client_status = 'active' LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'api_unauthorized' USING ERRCODE = 'invalid_authorization_specification';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from >= p_to
     OR p_to - p_from > 366
     OR p_from < v_today - 366 OR p_to > v_today + 731 THEN
    RAISE EXCEPTION 'api_invalid_range' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.api_access_grants g
      JOIN public.properties p ON p.id = g.property_id AND p.workspace_id = g.workspace_id
      JOIN public.workspaces w ON w.id = p.workspace_id
     WHERE g.client_id = v_client AND g.status = 'active' AND g.property_id = p_property
       AND p.status = 'active' AND w.status = 'active') THEN
    RAISE EXCEPTION 'api_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN QUERY
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
    SELECT pg_catalog.to_char(pg_catalog.lower(m.b), 'YYYY-MM-DD'),
           pg_catalog.to_char(pg_catalog.upper(m.b), 'YYYY-MM-DD')
      FROM merged m
     WHERE NOT pg_catalog.isempty(m.b)
     ORDER BY pg_catalog.lower(m.b);
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. İşletme paneli (app_user, withTenant bağlamı): villa sayfasında API erişimi
-- ---------------------------------------------------------------------------
-- Kod özeti → etkin acente (kimlik, ad). Yalnız owner/manager; değilse 42501.
CREATE FUNCTION public.app_api_lookup_access_code(p_code_hash text)
  RETURNS TABLE (client_id uuid, name text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
  IF coalesce(public.app_current_member_role(), '') NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'api_forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT c.id, c.name FROM public.api_clients c
     WHERE p_code_hash IS NOT NULL AND p_code_hash ~ '^[0-9a-f]{64}$'
       AND c.access_code_hash = p_code_hash AND c.status = 'active'
     LIMIT 1;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- Ev sahibinin onayı: kod HÂLÂ gösterilen acenteye aitse izin oluşturulur.
-- Dönüş: granted | exists | invalid_code | not_found
CREATE FUNCTION public.app_api_grant_property(p_property uuid, p_code_hash text, p_client uuid)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
  v_ws uuid := public.app_current_workspace_id();
  v_user uuid := public.app_current_user_id();
  v_id uuid;
  v_out text;
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
  IF v_user IS NULL OR coalesce(public.app_current_member_role(), '') NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'api_forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.properties p WHERE p.id = p_property AND p.workspace_id = v_ws) THEN
    v_out := 'not_found';
  ELSIF p_client IS NULL OR p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$'
        OR NOT EXISTS (SELECT 1 FROM public.api_clients c
                        WHERE c.id = p_client AND c.access_code_hash = p_code_hash
                          AND c.status = 'active') THEN
    v_out := 'invalid_code';
  ELSE
    INSERT INTO public.api_access_grants (id, client_id, workspace_id, property_id, status,
                                          granted_by_user, granted_via)
    VALUES (public.app_uuid_v7(), p_client, v_ws, p_property, 'active', v_user, 'owner')
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      v_out := 'exists';
    ELSE
      INSERT INTO public.audit_log (id, workspace_id, actor_user_id, action, target_type, target_id, metadata)
      VALUES (public.app_uuid_v7(), v_ws, v_user, 'api.access_granted', 'api_access_grant', v_id,
              pg_catalog.jsonb_build_object('property', p_property, 'client', p_client, 'via', 'owner'));
      v_out := 'granted';
    END IF;
  END IF;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RETURN v_out;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- Villanın etkin izinleri (acente adı). Tüm üyeler görür; kaldırma owner/manager.
CREATE FUNCTION public.app_api_property_grants(p_property uuid)
  RETURNS TABLE (id uuid, client_name text, granted_via text, created_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
  IF public.app_current_member_role() IS NULL THEN
    RAISE EXCEPTION 'api_forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT g.id, c.name, g.granted_via, g.created_at
      FROM public.api_access_grants g
      JOIN public.api_clients c ON c.id = g.client_id
     WHERE g.property_id = p_property AND g.workspace_id = public.app_current_workspace_id()
       AND g.status = 'active'
     ORDER BY g.created_at, g.id
     LIMIT 100;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- Dönüş: revoked | not_found
CREATE FUNCTION public.app_api_revoke_property_grant(p_grant uuid)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
  v_ws uuid := public.app_current_workspace_id();
  v_user uuid := public.app_current_user_id();
  v_g record;
  v_out text;
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
  IF v_user IS NULL OR coalesce(public.app_current_member_role(), '') NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'api_forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.api_access_grants g
     SET status = 'revoked', revoked_at = pg_catalog.now(), revoked_by_user = v_user
   WHERE g.id = p_grant AND g.workspace_id = v_ws AND g.status = 'active'
  RETURNING g.property_id, g.client_id INTO v_g;
  IF NOT FOUND THEN
    v_out := 'not_found';
  ELSE
    INSERT INTO public.audit_log (id, workspace_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (public.app_uuid_v7(), v_ws, v_user, 'api.access_revoked', 'api_access_grant', p_grant,
            pg_catalog.jsonb_build_object('property', v_g.property_id, 'client', v_g.client_id,
                                          'by', 'owner'));
    v_out := 'revoked';
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
-- 5. Super Admin (app_admin). Her fonksiyon önce çağıran yöneticiyi doğrular (değilse 42501).
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_api_admin_assert(p_admin uuid)
  RETURNS void
  LANGUAGE plpgsql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_admin IS NULL OR NOT EXISTS (SELECT 1 FROM public.admin_users a
                                     WHERE a.id = p_admin AND a.status = 'active') THEN
    RAISE EXCEPTION 'api_admin_forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.app_api_admin_clients(p_admin uuid)
  RETURNS TABLE (id uuid, name text, status text, created_at timestamptz, active_keys integer,
                 active_grants integer, requests_30d bigint, last_used_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
  v_since date := (pg_catalog.now() AT TIME ZONE 'Europe/Istanbul')::date - 29;
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
  PERFORM public.app_api_admin_assert(p_admin);
  RETURN QUERY
    SELECT c.id, c.name, c.status, c.created_at,
           (SELECT pg_catalog.count(*)::integer FROM public.api_keys k
             WHERE k.client_id = c.id AND k.status = 'active'),
           (SELECT pg_catalog.count(*)::integer FROM public.api_access_grants g
             WHERE g.client_id = c.id AND g.status = 'active'),
           (SELECT coalesce(pg_catalog.sum(u.requests), 0)::bigint FROM public.api_usage_daily u
             WHERE u.client_id = c.id AND u.day >= v_since),
           (SELECT pg_catalog.max(k.last_used_at) FROM public.api_keys k WHERE k.client_id = c.id)
      FROM public.api_clients c
     ORDER BY (c.status = 'active') DESC, pg_catalog.lower(c.name), c.id
     LIMIT 500;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.app_api_admin_client(p_admin uuid, p_client uuid)
  RETURNS TABLE (id uuid, name text, status text, rate_limit_per_minute integer,
                 access_code_hint text, access_code_created_at timestamptz, created_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
  PERFORM public.app_api_admin_assert(p_admin);
  RETURN QUERY
    SELECT c.id, c.name, c.status, c.rate_limit_per_minute, c.access_code_hint,
           c.access_code_created_at, c.created_at
      FROM public.api_clients c WHERE c.id = p_client;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- Ad geçersizse 23514 (api_admin_invalid).
CREATE FUNCTION public.app_api_admin_create_client(p_admin uuid, p_name text)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
  v_name text := pg_catalog.btrim(coalesce(p_name, ''));
  v_id uuid := public.app_uuid_v7();
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
  PERFORM public.app_api_admin_assert(p_admin);
  IF pg_catalog.length(v_name) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'api_admin_invalid' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.api_clients (id, name, status, created_by_admin)
  VALUES (v_id, v_name, 'active', p_admin);
  INSERT INTO public.admin_audit_log (id, admin_id, action, target_type, target_id, metadata)
  VALUES (pg_catalog.gen_random_uuid(), p_admin, 'api.client_created', 'api_client', v_id,
          '{}'::jsonb);
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RETURN v_id;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- Dönüş: updated | unchanged | not_found. Pasif hesabın bütün anahtarları bir sonraki istekte
-- reddedilir (anahtarlar silinmez; yeniden etkinleştirilince çalışır).
CREATE FUNCTION public.app_api_admin_set_client_status(p_admin uuid, p_client uuid, p_active boolean)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
  v_status text := CASE WHEN p_active THEN 'active' ELSE 'disabled' END;
  v_old text;
  v_out text;
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
  PERFORM public.app_api_admin_assert(p_admin);
  SELECT c.status INTO v_old FROM public.api_clients c WHERE c.id = p_client FOR UPDATE;
  IF NOT FOUND THEN
    v_out := 'not_found';
  ELSIF v_old = v_status THEN
    v_out := 'unchanged';
  ELSE
    UPDATE public.api_clients c SET status = v_status, updated_at = pg_catalog.now()
     WHERE c.id = p_client;
    INSERT INTO public.admin_audit_log (id, admin_id, action, target_type, target_id, metadata)
    VALUES (pg_catalog.gen_random_uuid(), p_admin,
            CASE WHEN p_active THEN 'api.client_enabled' ELSE 'api.client_disabled' END,
            'api_client', p_client, '{}'::jsonb);
    v_out := 'updated';
  END IF;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RETURN v_out;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.app_api_admin_keys(p_admin uuid, p_client uuid)
  RETURNS TABLE (id uuid, prefix text, label text, status text, created_at timestamptz,
                 last_used_at timestamptz, revoked_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
  PERFORM public.app_api_admin_assert(p_admin);
  RETURN QUERY
    SELECT k.id, k.prefix, k.label, k.status, k.created_at, k.last_used_at, k.revoked_at
      FROM public.api_keys k WHERE k.client_id = p_client
     ORDER BY (k.status = 'active') DESC, k.created_at DESC, k.id
     LIMIT 100;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- Anahtarı uygulama üretir; buraya yalnız açık önek ve SHA-256 özeti gelir.
-- Dönüş: created | limit | not_found | collision
CREATE FUNCTION public.app_api_admin_create_key(p_admin uuid, p_client uuid, p_prefix text,
                                                p_hash text, p_label text)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
  v_label text := nullif(pg_catalog.btrim(coalesce(p_label, '')), '');
  v_id uuid := public.app_uuid_v7();
  v_out text;
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
  PERFORM public.app_api_admin_assert(p_admin);
  IF p_prefix IS NULL OR p_prefix !~ '^[a-z2-7]{8}$' OR p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$'
     OR (v_label IS NOT NULL AND pg_catalog.length(v_label) > 60) THEN
    RAISE EXCEPTION 'api_admin_invalid' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM 1 FROM public.api_clients c WHERE c.id = p_client FOR UPDATE;
  IF NOT FOUND THEN
    v_out := 'not_found';
  ELSIF (SELECT pg_catalog.count(*) FROM public.api_keys k
          WHERE k.client_id = p_client AND k.status = 'active') >= 5 THEN
    v_out := 'limit';
  ELSE
    INSERT INTO public.api_keys (id, client_id, prefix, secret_hash, label, status, created_by_admin)
    VALUES (v_id, p_client, p_prefix, p_hash, v_label, 'active', p_admin)
    ON CONFLICT DO NOTHING;
    IF NOT FOUND THEN
      v_out := 'collision';
    ELSE
      INSERT INTO public.admin_audit_log (id, admin_id, action, target_type, target_id, metadata)
      VALUES (pg_catalog.gen_random_uuid(), p_admin, 'api.key_created', 'api_key', v_id,
              pg_catalog.jsonb_build_object('client', p_client, 'prefix', p_prefix));
      v_out := 'created';
    END IF;
  END IF;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RETURN v_out;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- Dönüş: revoked | not_found (yoksa veya zaten geri alınmışsa)
CREATE FUNCTION public.app_api_admin_revoke_key(p_admin uuid, p_key uuid)
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
  PERFORM public.app_api_admin_assert(p_admin);
  UPDATE public.api_keys k
     SET status = 'revoked', revoked_at = pg_catalog.now(), revoked_by_admin = p_admin
   WHERE k.id = p_key AND k.status = 'active'
  RETURNING k.client_id INTO v_client;
  IF NOT FOUND THEN
    v_out := 'not_found';
  ELSE
    DELETE FROM public.api_rate_windows w WHERE w.key_id = p_key;
    INSERT INTO public.admin_audit_log (id, admin_id, action, target_type, target_id, metadata)
    VALUES (pg_catalog.gen_random_uuid(), p_admin, 'api.key_revoked', 'api_key', p_key,
            pg_catalog.jsonb_build_object('client', v_client));
    v_out := 'revoked';
  END IF;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RETURN v_out;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- Yeni erişim kodu (öncekinin yerine geçer; eski kod artık çalışmaz). Mevcut izinler etkilenmez.
-- Dönüş: set | not_found | disabled | collision
CREATE FUNCTION public.app_api_admin_set_access_code(p_admin uuid, p_client uuid, p_hash text,
                                                     p_hint text)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
  v_status text;
  v_out text;
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
  PERFORM public.app_api_admin_assert(p_admin);
  IF p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' OR p_hint IS NULL OR p_hint !~ '^[A-Z2-9]{4}$' THEN
    RAISE EXCEPTION 'api_admin_invalid' USING ERRCODE = 'check_violation';
  END IF;
  SELECT c.status INTO v_status FROM public.api_clients c WHERE c.id = p_client FOR UPDATE;
  IF NOT FOUND THEN
    v_out := 'not_found';
  ELSIF v_status <> 'active' THEN
    v_out := 'disabled';
  ELSIF EXISTS (SELECT 1 FROM public.api_clients c
                 WHERE c.access_code_hash = p_hash AND c.id <> p_client) THEN
    v_out := 'collision';
  ELSE
    UPDATE public.api_clients c
       SET access_code_hash = p_hash, access_code_hint = p_hint,
           access_code_created_at = pg_catalog.now(), updated_at = pg_catalog.now()
     WHERE c.id = p_client;
    INSERT INTO public.admin_audit_log (id, admin_id, action, target_type, target_id, metadata)
    VALUES (pg_catalog.gen_random_uuid(), p_admin, 'api.access_code_created', 'api_client',
            p_client, '{}'::jsonb);
    v_out := 'set';
  END IF;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RETURN v_out;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.app_api_admin_grants(p_admin uuid, p_client uuid)
  RETURNS TABLE (id uuid, workspace_id uuid, workspace_name text, property_id uuid,
                 property_name text, property_active boolean, status text, granted_via text,
                 created_at timestamptz, revoked_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
  PERFORM public.app_api_admin_assert(p_admin);
  RETURN QUERY
    SELECT g.id, g.workspace_id, w.name, g.property_id, p.name,
           (p.status = 'active' AND w.status = 'active'), g.status, g.granted_via,
           g.created_at, g.revoked_at
      FROM public.api_access_grants g
      JOIN public.properties p ON p.id = g.property_id AND p.workspace_id = g.workspace_id
      JOIN public.workspaces w ON w.id = g.workspace_id
     WHERE g.client_id = p_client
     ORDER BY (g.status = 'active') DESC, g.created_at DESC, g.id
     LIMIT 300;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- Dönüş: granted | exists | not_found
CREATE FUNCTION public.app_api_admin_grant(p_admin uuid, p_client uuid, p_property uuid)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
  v_ws uuid;
  v_id uuid;
  v_out text;
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
  PERFORM public.app_api_admin_assert(p_admin);
  SELECT p.workspace_id INTO v_ws FROM public.properties p WHERE p.id = p_property;
  IF v_ws IS NULL OR NOT EXISTS (SELECT 1 FROM public.api_clients c WHERE c.id = p_client) THEN
    v_out := 'not_found';
  ELSE
    INSERT INTO public.api_access_grants (id, client_id, workspace_id, property_id, status,
                                          granted_by_admin, granted_via)
    VALUES (public.app_uuid_v7(), p_client, v_ws, p_property, 'active', p_admin, 'admin')
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      v_out := 'exists';
    ELSE
      INSERT INTO public.admin_audit_log (id, admin_id, action, target_type, target_id, metadata)
      VALUES (pg_catalog.gen_random_uuid(), p_admin, 'api.access_granted', 'api_access_grant', v_id,
              pg_catalog.jsonb_build_object('client', p_client, 'property', p_property));
      INSERT INTO public.audit_log (id, workspace_id, actor_user_id, action, target_type, target_id, metadata)
      VALUES (public.app_uuid_v7(), v_ws, NULL, 'api.access_granted', 'api_access_grant', v_id,
              pg_catalog.jsonb_build_object('property', p_property, 'client', p_client, 'via', 'admin'));
      v_out := 'granted';
    END IF;
  END IF;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RETURN v_out;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- Dönüş: revoked | not_found
CREATE FUNCTION public.app_api_admin_revoke_grant(p_admin uuid, p_grant uuid)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
  v_g record;
  v_out text;
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
  PERFORM public.app_api_admin_assert(p_admin);
  UPDATE public.api_access_grants g
     SET status = 'revoked', revoked_at = pg_catalog.now(), revoked_by_admin = p_admin
   WHERE g.id = p_grant AND g.status = 'active'
  RETURNING g.workspace_id, g.property_id, g.client_id INTO v_g;
  IF NOT FOUND THEN
    v_out := 'not_found';
  ELSE
    INSERT INTO public.admin_audit_log (id, admin_id, action, target_type, target_id, metadata)
    VALUES (pg_catalog.gen_random_uuid(), p_admin, 'api.access_revoked', 'api_access_grant', p_grant,
            pg_catalog.jsonb_build_object('client', v_g.client_id, 'property', v_g.property_id));
    INSERT INTO public.audit_log (id, workspace_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (public.app_uuid_v7(), v_g.workspace_id, NULL, 'api.access_revoked', 'api_access_grant',
            p_grant, pg_catalog.jsonb_build_object('property', v_g.property_id,
                                                   'client', v_g.client_id, 'by', 'admin'));
    v_out := 'revoked';
  END IF;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RETURN v_out;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- Son 30 gün (Europe/Istanbul günleri), yalnız kayıt olan günler.
CREATE FUNCTION public.app_api_admin_usage(p_admin uuid, p_client uuid)
  RETURNS TABLE (day text, requests integer, rate_limited integer, errors integer)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
  v_since date := (pg_catalog.now() AT TIME ZONE 'Europe/Istanbul')::date - 29;
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
  PERFORM public.app_api_admin_assert(p_admin);
  RETURN QUERY
    SELECT pg_catalog.to_char(u.day, 'YYYY-MM-DD'), u.requests, u.rate_limited, u.errors
      FROM public.api_usage_daily u
     WHERE u.client_id = p_client AND u.day >= v_since
     ORDER BY u.day DESC;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. EXECUTE yetkileri
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.app_api_resolve_key(text),
  public.app_api_admin_assert(uuid),
  public.app_api_begin(text),
  public.app_api_note_error(text),
  public.app_api_properties(text, uuid, integer),
  public.app_api_property(text, uuid),
  public.app_api_busy(text, uuid, date, date),
  public.app_api_lookup_access_code(text),
  public.app_api_grant_property(uuid, text, uuid),
  public.app_api_property_grants(uuid),
  public.app_api_revoke_property_grant(uuid),
  public.app_api_admin_clients(uuid),
  public.app_api_admin_client(uuid, uuid),
  public.app_api_admin_create_client(uuid, text),
  public.app_api_admin_set_client_status(uuid, uuid, boolean),
  public.app_api_admin_keys(uuid, uuid),
  public.app_api_admin_create_key(uuid, uuid, text, text, text),
  public.app_api_admin_revoke_key(uuid, uuid),
  public.app_api_admin_set_access_code(uuid, uuid, text, text),
  public.app_api_admin_grants(uuid, uuid),
  public.app_api_admin_grant(uuid, uuid, uuid),
  public.app_api_admin_revoke_grant(uuid, uuid),
  public.app_api_admin_usage(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_api_begin(text),
  public.app_api_note_error(text),
  public.app_api_properties(text, uuid, integer),
  public.app_api_property(text, uuid),
  public.app_api_busy(text, uuid, date, date),
  public.app_api_lookup_access_code(text),
  public.app_api_grant_property(uuid, text, uuid),
  public.app_api_property_grants(uuid),
  public.app_api_revoke_property_grant(uuid) TO app_user;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_api_admin_clients(uuid),
  public.app_api_admin_client(uuid, uuid),
  public.app_api_admin_create_client(uuid, text),
  public.app_api_admin_set_client_status(uuid, uuid, boolean),
  public.app_api_admin_keys(uuid, uuid),
  public.app_api_admin_create_key(uuid, uuid, text, text, text),
  public.app_api_admin_revoke_key(uuid, uuid),
  public.app_api_admin_set_access_code(uuid, uuid, text, text),
  public.app_api_admin_grants(uuid, uuid),
  public.app_api_admin_grant(uuid, uuid, uuid),
  public.app_api_admin_revoke_grant(uuid, uuid),
  public.app_api_admin_usage(uuid, uuid) TO app_admin;
