-- 0056_api_calendar_connections_security (API 2. aşama, 2. adım: takvim bağlantıları)
--
-- Tablo 0055'tedir: api_calendar_connections. Bu migration:
--
--   1. ENABLE + FORCE RLS; PUBLIC'ten bütün yetkiler geri alınır. Hiçbir uygulama rolü tabloya
--      doğrudan erişemez; tek yol aşağıdaki fonksiyonlardır ('app.api_fn' bayrağı, 0052 deseni).
--   2. API istek fonksiyonları (app_user; anahtar ÖZETİYLE çağrılır, hesap ondan bulunur):
--        app_api_connect          — bağlantı isteği + doğrulama (etkin izin, etkin villa/işletme,
--                                   iki tekillik kuralı). Uygunsa doğrudan active; aynı istek
--                                   tekrar gelirse mevcut bağlantı döner (idempotent).
--        app_api_connections      — acentenin bağlantıları (sayfalı)
--        app_api_connection       — tek bağlantı (yalnız kendi bağlantısı)
--        app_api_disconnect       — acente kendi bağlantısını keser (idempotent)
--      Görünen durum: active | paused | disconnected | revoked. "paused" SAKLANMAZ: saklanan
--      durum active iken villa, işletme veya izin etkin değilse paused döner.
--   3. İşletme paneli (app_user, oturum bağlamı): app_api_property_connections — villanın etkin
--      bağlantıları (acente adı, durum, tarihler).
--   4. Super Admin (app_admin): app_api_admin_connections — hesabın bağlantıları (salt okunur).
--   5. İzin kaldırma: app_api_revoke_property_grant (ev sahibi) ve app_api_admin_revoke_grant
--      (Super Admin) AYNI imzayla yeniden tanımlanır; izinle birlikte o izinle kurulmuş etkin
--      bağlantılar aynı transaction'da "revoked" olur. 0052'deki davranış aynen korunur.
--   6. Denetim: api.calendar_connected, api.calendar_disconnected (yalnız kimlikler; acentenin
--      villa kimliği yazılmaz).
--
-- Yarış koşulları:
--   * Bağlantı ile izin kaldırma: app_api_connect izin satırını FOR SHARE ile kilitler. Kaldırma
--     önce gelirse bağlantı izni bulamaz; bağlantı önce gelirse kaldırma bekler ve yeni bağlantıyı
--     da sonlandırır. Etkin bağlantı + kaldırılmış izin hiçbir zaman kalmaz.
--   * Eşzamanlı aynı/çakışan istekler: kısmi tekil indeksler + ON CONFLICT DO NOTHING; çakışan
--     istek, kaydedilen satıra göre exists / already_connected / external_id_in_use döner.
--
-- api_calendar_dirty'ye (1. adım) dokunulmaz.
--
-- Geri alma: app_api_revoke_property_grant ve app_api_admin_revoke_grant'ı 0052 tanımıyla yeniden
--   oluşturun; DROP FUNCTION app_api_connect(text, uuid, text), app_api_connections(text, uuid,
--   integer, boolean), app_api_connection(text, uuid), app_api_disconnect(text, uuid),
--   app_api_property_connections(uuid), app_api_admin_connections(uuid, uuid),
--   app_api_connection_rows(uuid), app_api_end_grant_connections(uuid, text, uuid, uuid);
--   DROP POLICY api_calendar_connections_api_fn; DROP TABLE api_calendar_connections.

-- ---------------------------------------------------------------------------
-- 1. RLS ve yetkiler
-- ---------------------------------------------------------------------------
ALTER TABLE public.api_calendar_connections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.api_calendar_connections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE public.api_calendar_connections FROM PUBLIC;
--> statement-breakpoint
CREATE POLICY api_calendar_connections_api_fn ON public.api_calendar_connections
  FOR ALL TO app_migrator
  USING (pg_catalog.current_setting('app.api_fn', true) = 'on')
  WITH CHECK (pg_catalog.current_setting('app.api_fn', true) = 'on');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. İç yardımcılar (kimseye EXECUTE yok; yalnız aşağıdaki SECURITY DEFINER fonksiyonlar çağırır)
-- ---------------------------------------------------------------------------
-- Bir acentenin bağlantıları, görünen durumla. Etkin bağlantı; izin, villa veya işletme etkin
-- değilse "paused" görünür (saklanmaz).
CREATE FUNCTION public.app_api_connection_rows(p_client uuid)
  RETURNS TABLE (id uuid, property_id uuid, external_property_id text, status text,
                 created_at timestamptz, ended_at timestamptz, last_synced_at timestamptz)
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT c.id, c.property_id, c.external_property_id,
         CASE WHEN c.status <> 'active' THEN c.status
              WHEN g.status = 'active' AND p.status = 'active' AND w.status = 'active' THEN 'active'
              ELSE 'paused' END,
         c.created_at, c.ended_at, c.last_synced_at
    FROM public.api_calendar_connections c
    JOIN public.api_access_grants g ON g.id = c.grant_id
    JOIN public.properties p ON p.id = c.property_id AND p.workspace_id = c.workspace_id
    JOIN public.workspaces w ON w.id = c.workspace_id
   WHERE c.client_id = p_client
$$;
--> statement-breakpoint

-- İzinle kurulmuş etkin bağlantıları sonlandırır (izin kaldırma fonksiyonlarından, aynı
-- transaction'da). p_by: owner | admin; p_actor: kullanıcı (owner) ya da NULL.
CREATE FUNCTION public.app_api_end_grant_connections(p_grant uuid, p_by text, p_actor uuid,
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

-- ---------------------------------------------------------------------------
-- 3. API istek fonksiyonları
-- ---------------------------------------------------------------------------
-- Dönüş (tek satır): outcome = created | exists | already_connected | external_id_in_use |
-- not_found; created/exists için bağlantı alanları dolu. Anahtar geçersiz/hesap pasif → 28000;
-- acente villa kimliği biçim dışı → 22023.
CREATE FUNCTION public.app_api_connect(p_hash text, p_property uuid, p_external text)
  RETURNS TABLE (outcome text, id uuid, property_id uuid, external_property_id text, status text,
                 created_at timestamptz, ended_at timestamptz, last_synced_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev text := pg_catalog.current_setting('app.api_fn', true);
  v_client uuid;
  v_grant uuid;
  v_ws uuid;
  v_conn uuid;
  v_ext text;
  v_out text;
  v_try integer := 0;
BEGIN
  PERFORM pg_catalog.set_config('app.api_fn', 'on', true);
  SELECT r.client_id INTO v_client FROM public.app_api_resolve_key(p_hash) r
   WHERE r.client_status = 'active' LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'api_unauthorized' USING ERRCODE = 'invalid_authorization_specification';
  END IF;
  IF p_external IS NULL OR p_external !~ '^[!-~]([ -~]{0,98}[!-~])?$' THEN
    RAISE EXCEPTION 'api_invalid_external_id' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 1. adım (istek) → 2. adım (doğrulama): etkin izin + etkin villa + etkin işletme. İzin satırı
  -- kilitlenir: eşzamanlı izin kaldırma bu transaction bitene kadar bekler.
  SELECT g.id, g.workspace_id INTO v_grant, v_ws
    FROM public.api_access_grants g
    JOIN public.properties p ON p.id = g.property_id AND p.workspace_id = g.workspace_id
    JOIN public.workspaces w ON w.id = g.workspace_id
   WHERE g.client_id = v_client AND g.property_id = p_property AND g.status = 'active'
     AND p.status = 'active' AND w.status = 'active'
     FOR SHARE OF g;

  IF v_grant IS NULL THEN
    v_out := 'not_found';
  ELSE
    LOOP
      v_try := v_try + 1;
      SELECT c.id, c.external_property_id INTO v_conn, v_ext
        FROM public.api_calendar_connections c
       WHERE c.client_id = v_client AND c.property_id = p_property AND c.status = 'active';
      IF v_conn IS NOT NULL THEN
        v_out := CASE WHEN v_ext = p_external THEN 'exists' ELSE 'already_connected' END;
        EXIT;
      END IF;
      IF EXISTS (SELECT 1 FROM public.api_calendar_connections c
                  WHERE c.client_id = v_client AND c.external_property_id = p_external
                    AND c.status = 'active') THEN
        v_out := 'external_id_in_use';
        EXIT;
      END IF;
      INSERT INTO public.api_calendar_connections (id, client_id, workspace_id, property_id,
                                                   grant_id, external_property_id, status)
      VALUES (public.app_uuid_v7(), v_client, v_ws, p_property, v_grant, p_external, 'active')
      ON CONFLICT DO NOTHING
      RETURNING api_calendar_connections.id INTO v_conn;
      IF v_conn IS NOT NULL THEN
        INSERT INTO public.audit_log (id, workspace_id, actor_user_id, action, target_type, target_id, metadata)
        VALUES (public.app_uuid_v7(), v_ws, NULL, 'api.calendar_connected',
                'api_calendar_connection', v_conn,
                pg_catalog.jsonb_build_object('property', p_property, 'client', v_client));
        v_out := 'created';
        EXIT;
      END IF;
      -- Eşzamanlı bir istek araya girdi: kaydedilen satıra göre yeniden değerlendir.
      IF v_try >= 3 THEN
        RAISE EXCEPTION 'api_connect_conflict' USING ERRCODE = 'serialization_failure';
      END IF;
    END LOOP;
  END IF;

  IF v_out IN ('created', 'exists') THEN
    RETURN QUERY SELECT v_out, r.id, r.property_id, r.external_property_id, r.status,
                        r.created_at, r.ended_at, r.last_synced_at
                   FROM public.app_api_connection_rows(v_client) r WHERE r.id = v_conn;
  ELSE
    RETURN QUERY SELECT v_out, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
                        NULL::timestamptz, NULL::timestamptz, NULL::timestamptz;
  END IF;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- Acentenin bağlantıları, kimliğe göre sıralı. p_all = false: yalnız güncel (active/paused).
CREATE FUNCTION public.app_api_connections(p_hash text, p_after uuid, p_limit integer,
                                           p_all boolean)
  RETURNS TABLE (id uuid, property_id uuid, external_property_id text, status text,
                 created_at timestamptz, ended_at timestamptz, last_synced_at timestamptz)
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
    SELECT r.id, r.property_id, r.external_property_id, r.status, r.created_at, r.ended_at,
           r.last_synced_at
      FROM public.app_api_connection_rows(v_client) r
     WHERE (p_after IS NULL OR r.id > p_after)
       AND (coalesce(p_all, false) OR r.status IN ('active', 'paused'))
     ORDER BY r.id
     LIMIT LEAST(GREATEST(coalesce(p_limit, 100), 1), 500);
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- Tek bağlantı; başka acentenin bağlantısı ya da olmayan kimlik → satır yok.
CREATE FUNCTION public.app_api_connection(p_hash text, p_id uuid)
  RETURNS TABLE (id uuid, property_id uuid, external_property_id text, status text,
                 created_at timestamptz, ended_at timestamptz, last_synced_at timestamptz)
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
    SELECT r.id, r.property_id, r.external_property_id, r.status, r.created_at, r.ended_at,
           r.last_synced_at
      FROM public.app_api_connection_rows(v_client) r WHERE r.id = p_id;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- Acente kendi bağlantısını keser. Dönüş: (outcome, bağlantı) — disconnected (şimdi kesildi) |
-- ended (zaten bitmişti; mevcut hâli) | not_found. Acentenin kendi kayıtlarına dokunulmaz.
CREATE FUNCTION public.app_api_disconnect(p_hash text, p_id uuid)
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

-- ---------------------------------------------------------------------------
-- 4. İşletme paneli: villanın etkin bağlantıları (tüm üyeler görür)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_api_property_connections(p_property uuid)
  RETURNS TABLE (id uuid, grant_id uuid, client_name text, paused boolean,
                 created_at timestamptz, last_synced_at timestamptz)
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
    SELECT c.id, c.grant_id, k.name, (p.status <> 'active' OR k.status <> 'active'),
           c.created_at, c.last_synced_at
      FROM public.api_calendar_connections c
      JOIN public.api_clients k ON k.id = c.client_id
      JOIN public.properties p ON p.id = c.property_id AND p.workspace_id = c.workspace_id
     WHERE c.property_id = p_property AND c.workspace_id = public.app_current_workspace_id()
       AND c.status = 'active'
     ORDER BY c.created_at, c.id
     LIMIT 100;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Super Admin: hesabın bağlantıları (salt okunur)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_api_admin_connections(p_admin uuid, p_client uuid)
  RETURNS TABLE (id uuid, workspace_name text, property_id uuid, property_name text,
                 external_property_id text, status text, created_at timestamptz,
                 ended_at timestamptz, last_synced_at timestamptz)
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
    SELECT r.id, w.name, r.property_id, p.name, r.external_property_id, r.status, r.created_at,
           r.ended_at, r.last_synced_at
      FROM public.app_api_connection_rows(p_client) r
      JOIN public.properties p ON p.id = r.property_id
      JOIN public.workspaces w ON w.id = p.workspace_id
     ORDER BY (r.status IN ('active', 'paused')) DESC, r.created_at DESC, r.id
     LIMIT 300;
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.api_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. İzin kaldırma: aynı imza, 0052 davranışı + o izinle kurulmuş etkin bağlantılar revoked
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_api_revoke_property_grant(p_grant uuid)
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
    PERFORM public.app_api_end_grant_connections(p_grant, 'owner', v_user, NULL);
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

CREATE OR REPLACE FUNCTION public.app_api_admin_revoke_grant(p_admin uuid, p_grant uuid)
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
    PERFORM public.app_api_end_grant_connections(p_grant, 'admin', NULL, p_admin);
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
-- 7. EXECUTE yetkileri
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.app_api_connection_rows(uuid),
  public.app_api_end_grant_connections(uuid, text, uuid, uuid),
  public.app_api_connect(text, uuid, text),
  public.app_api_connections(text, uuid, integer, boolean),
  public.app_api_connection(text, uuid),
  public.app_api_disconnect(text, uuid),
  public.app_api_property_connections(uuid),
  public.app_api_admin_connections(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_api_connect(text, uuid, text),
  public.app_api_connections(text, uuid, integer, boolean),
  public.app_api_connection(text, uuid),
  public.app_api_disconnect(text, uuid),
  public.app_api_property_connections(uuid) TO app_user;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_api_admin_connections(uuid, uuid) TO app_admin;
