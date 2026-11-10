-- 0044_wa_group_admin_security (Aşama 2: merkezi WhatsApp grup yönetimi — yalnız Super Admin)
--
-- Grup keşfinden işletme + villa eşleştirmesine, aktif/pasif, villa değişikliği, bağlantı kaldırma
-- ve "yok say / arşivle" işlemlerine kadar BÜTÜN grup yönetimi yalnız platform yöneticisine
-- (app_admin rolü, admin.<alan-adı>, zorunlu 2FA) aittir:
--
--   1. Super Admin fonksiyonları (SECURITY DEFINER, sahip app_migrator, YALNIZ app_admin çağırır).
--      Her biri çağıran yöneticinin admin_users'ta aktif olduğunu denetler (değilse 42501), işletme
--      ve villa kimliklerini veritabanında doğrular ve hem platform denetim kaydına (admin_audit_log)
--      hem işletmenin denetim kaydına (audit_log, aktör yok) yazar. app_admin tablolara doğrudan
--      yetki ALMAZ.
--        app_wa_admin_groups, app_wa_admin_workspaces, app_wa_admin_properties,
--        app_wa_admin_connections, app_wa_admin_link_group, app_wa_admin_set_property,
--        app_wa_admin_set_active, app_wa_admin_unlink_group, app_wa_admin_archive_group
--   2. İşletme panelinin (app_user) eşleştirme yetkileri KALDIRILIR: grup sahiplenme, bekleyen
--      gruplar, bağlantı kesme, eski kodlu bağlama fonksiyonları; wa_groups.status/property_id
--      güncelleme; yönetici eşleştirme yetkisi ve bağlama kodu ekleme. İşletme kendi bağlı/pasif
--      gruplarını yalnız OKUR (mevcut RLS).
--   3. Mevcut eşleştirmeler ve veriler değişmez.
--
-- Kurallar: bir grup aynı anda tek işletmeye bağlıdır; villa yalnız o işletmenin AKTİF villası
-- olabilir; aynı JID başka bir bağlantıdan da keşfedildiyse ikinci kayıt bağlanamaz (mükerrer);
-- pasif (suspended) grubun yeni mesajları kaydedilmez, otomatik işlem yapılmaz; bağlantı
-- kaldırılınca grubun mesaj içerikleri silinir (öneri alıntıları '(silindi)'), bekleyen öneriler
-- sona erer, denetim kayıtları ve öneri/rezervasyon kayıtları korunur.
--
-- Geri alma: DROP FUNCTION app_wa_admin_*; işletme yetkileri gerekiyorsa 0031/0034'teki GRANT
--   ifadeleri yeniden çalıştırılır; DROP POLICY admin_users_wa_fn, admin_audit_log_wa_fn.

-- ---------------------------------------------------------------------------
-- 1. Fonksiyonların okuduğu/yazdığı admin tabloları (yalnız fonksiyon bayrağıyla)
-- ---------------------------------------------------------------------------
CREATE POLICY admin_users_wa_fn ON public.admin_users FOR SELECT TO app_migrator
  USING (pg_catalog.current_setting('app.wa_fn', true) = 'on');
--> statement-breakpoint
CREATE POLICY admin_audit_log_wa_fn ON public.admin_audit_log FOR INSERT TO app_migrator
  WITH CHECK (pg_catalog.current_setting('app.wa_fn', true) = 'on' AND action LIKE 'whatsapp.%');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Listeler (yalnız okuma)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_wa_admin_groups(p_admin uuid)
  RETURNS TABLE (id uuid, jid text, subject text, status text, participant_count integer,
                 bot_is_admin boolean, first_seen_at timestamptz, last_seen_at timestamptz,
                 last_message_at timestamptz, linked_at timestamptz, archived_at timestamptz,
                 workspace_id uuid, workspace_name text, property_id uuid, property_name text,
                 property_active boolean, connection_label text, same_jid_count integer)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_prev_cal text := pg_catalog.current_setting('app.wa_calendar', true);
BEGIN
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  PERFORM pg_catalog.set_config('app.wa_calendar', 'on', true);
  IF p_admin IS NULL OR NOT EXISTS (SELECT 1 FROM public.admin_users a
                                     WHERE a.id = p_admin AND a.status = 'active') THEN
    RAISE EXCEPTION 'wa_admin_forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT g.id, g.jid, g.subject, g.status, g.participant_count, g.bot_is_admin, g.first_seen_at,
           g.last_seen_at, g.last_message_at, g.linked_at, g.archived_at, g.workspace_id, w.name,
           g.property_id, p.name, (p.status = 'active'), c.label,
           (SELECT pg_catalog.count(*)::integer FROM public.wa_groups d WHERE d.jid = g.jid)
      FROM public.wa_groups g
      JOIN public.wa_connections c ON c.id = g.connection_id
      LEFT JOIN public.workspaces w ON w.id = g.workspace_id
      LEFT JOIN public.properties p ON p.id = g.property_id AND p.workspace_id = g.workspace_id
     ORDER BY g.first_seen_at DESC, g.id
     LIMIT 2000;
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.app_wa_admin_workspaces(p_admin uuid, p_query text)
  RETURNS TABLE (id uuid, name text, slug text, status text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_q text := nullif(pg_catalog.btrim(coalesce(p_query, '')), '');
BEGIN
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  IF p_admin IS NULL OR NOT EXISTS (SELECT 1 FROM public.admin_users a
                                     WHERE a.id = p_admin AND a.status = 'active') THEN
    RAISE EXCEPTION 'wa_admin_forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_q IS NOT NULL AND pg_catalog.length(v_q) > 100 THEN
    v_q := pg_catalog.left(v_q, 100);
  END IF;
  RETURN QUERY
    SELECT w.id, w.name, w.slug, w.status FROM public.workspaces w
     WHERE v_q IS NULL
        OR pg_catalog.strpos(pg_catalog.lower(w.name), pg_catalog.lower(v_q)) > 0
        OR pg_catalog.strpos(pg_catalog.lower(w.slug), pg_catalog.lower(v_q)) > 0
     ORDER BY (w.status = 'active') DESC, pg_catalog.lower(w.name), w.id
     LIMIT 50;
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.app_wa_admin_properties(p_admin uuid, p_workspace uuid)
  RETURNS TABLE (id uuid, name text, active boolean)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_prev_cal text := pg_catalog.current_setting('app.wa_calendar', true);
BEGIN
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  PERFORM pg_catalog.set_config('app.wa_calendar', 'on', true);
  IF p_admin IS NULL OR NOT EXISTS (SELECT 1 FROM public.admin_users a
                                     WHERE a.id = p_admin AND a.status = 'active') THEN
    RAISE EXCEPTION 'wa_admin_forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT p.id, p.name, (p.status = 'active') FROM public.properties p
     WHERE p.workspace_id = p_workspace
     ORDER BY (p.status = 'active') DESC, pg_catalog.lower(p.name), p.id
     LIMIT 500;
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.app_wa_admin_connections(p_admin uuid)
  RETURNS TABLE (id uuid, label text, status text, last_seen_at timestamptz,
                 last_connected_at timestamptz, last_error_code text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
BEGIN
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  IF p_admin IS NULL OR NOT EXISTS (SELECT 1 FROM public.admin_users a
                                     WHERE a.id = p_admin AND a.status = 'active') THEN
    RAISE EXCEPTION 'wa_admin_forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT c.id, c.label, c.status, c.last_seen_at, c.last_connected_at, c.last_error_code
      FROM public.wa_connections c ORDER BY c.last_seen_at DESC NULLS LAST, c.id LIMIT 20;
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Eşleştirme: grup → işletme + villa, aktif
-- ---------------------------------------------------------------------------
-- Dönüş: linked | not_found | not_available (zaten bağlı / ayrıldı) | archived | duplicate
--        (aynı JID başka kayıtta bağlı) | workspace_invalid | property_invalid
CREATE FUNCTION public.app_wa_admin_link_group(p_admin uuid, p_group uuid, p_workspace uuid,
                                               p_property uuid)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_prev_cal text := pg_catalog.current_setting('app.wa_calendar', true);
  g record;
  v_out text;
  v_ws_status text;
  v_prop_status text;
BEGIN
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  PERFORM pg_catalog.set_config('app.wa_calendar', 'on', true);
  IF p_admin IS NULL OR NOT EXISTS (SELECT 1 FROM public.admin_users a
                                     WHERE a.id = p_admin AND a.status = 'active') THEN
    RAISE EXCEPTION 'wa_admin_forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO g FROM public.wa_groups wg WHERE wg.id = p_group FOR UPDATE;
  IF NOT FOUND THEN
    v_out := 'not_found';
  ELSIF g.status <> 'discovered' OR g.workspace_id IS NOT NULL THEN
    v_out := 'not_available';
  ELSIF g.archived_at IS NOT NULL THEN
    v_out := 'archived';
  ELSE
    -- Aynı JID için eşzamanlı eşleştirmeler sıralanır (farklı bağlantı kayıtları).
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('wa_group_jid:' || g.jid));
    SELECT w.status INTO v_ws_status FROM public.workspaces w WHERE w.id = p_workspace;
    SELECT p.status INTO v_prop_status FROM public.properties p
     WHERE p.id = p_property AND p.workspace_id = p_workspace;
    IF EXISTS (SELECT 1 FROM public.wa_groups d
                WHERE d.jid = g.jid AND d.id <> g.id AND d.status IN ('linked', 'suspended')) THEN
      v_out := 'duplicate';
    ELSIF v_ws_status IS DISTINCT FROM 'active' THEN
      v_out := 'workspace_invalid';
    ELSIF v_prop_status IS DISTINCT FROM 'active' THEN
      v_out := 'property_invalid';
    ELSE
      UPDATE public.wa_groups
         SET status = 'linked', workspace_id = p_workspace, property_id = p_property,
             linked_at = pg_catalog.now(), linked_by = NULL, linked_by_admin = p_admin,
             link_fail_count = 0, link_fail_window_at = NULL
       WHERE id = g.id;
      INSERT INTO public.audit_log (id, workspace_id, actor_user_id, action, target_type,
                                    target_id, metadata)
      VALUES (pg_catalog.gen_random_uuid(), p_workspace, NULL, 'whatsapp.group_linked',
              'whatsapp_group', g.id,
              pg_catalog.jsonb_build_object('method', 'platform', 'property', p_property));
      INSERT INTO public.admin_audit_log (id, admin_id, action, target_type, target_id, metadata)
      VALUES (pg_catalog.gen_random_uuid(), p_admin, 'whatsapp.group_linked', 'wa_group', g.id,
              pg_catalog.jsonb_build_object('workspace', p_workspace, 'property', p_property));
      v_out := 'linked';
    END IF;
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  RETURN v_out;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Villa değişikliği (aynı işletme içinde, yalnız aktif villa)
-- ---------------------------------------------------------------------------
-- Dönüş: changed | unchanged | not_found | property_invalid
CREATE FUNCTION public.app_wa_admin_set_property(p_admin uuid, p_group uuid, p_property uuid)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_prev_cal text := pg_catalog.current_setting('app.wa_calendar', true);
  g record;
  v_out text;
  v_prop_status text;
BEGIN
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  PERFORM pg_catalog.set_config('app.wa_calendar', 'on', true);
  IF p_admin IS NULL OR NOT EXISTS (SELECT 1 FROM public.admin_users a
                                     WHERE a.id = p_admin AND a.status = 'active') THEN
    RAISE EXCEPTION 'wa_admin_forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO g FROM public.wa_groups wg WHERE wg.id = p_group FOR UPDATE;
  IF NOT FOUND OR g.status NOT IN ('linked', 'suspended') OR g.workspace_id IS NULL THEN
    v_out := 'not_found';
  ELSE
    SELECT p.status INTO v_prop_status FROM public.properties p
     WHERE p.id = p_property AND p.workspace_id = g.workspace_id;
    IF v_prop_status IS DISTINCT FROM 'active' THEN
      v_out := 'property_invalid';
    ELSIF g.property_id IS NOT DISTINCT FROM p_property THEN
      v_out := 'unchanged';
    ELSE
      UPDATE public.wa_groups SET property_id = p_property WHERE id = g.id;
      INSERT INTO public.audit_log (id, workspace_id, actor_user_id, action, target_type,
                                    target_id, metadata)
      VALUES (pg_catalog.gen_random_uuid(), g.workspace_id, NULL,
              'whatsapp.group_property_changed', 'whatsapp_group', g.id,
              pg_catalog.jsonb_build_object('property', p_property));
      INSERT INTO public.admin_audit_log (id, admin_id, action, target_type, target_id, metadata)
      VALUES (pg_catalog.gen_random_uuid(), p_admin, 'whatsapp.group_property_changed',
              'wa_group', g.id,
              pg_catalog.jsonb_build_object('workspace', g.workspace_id, 'from', g.property_id,
                                            'to', p_property));
      v_out := 'changed';
    END IF;
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  RETURN v_out;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Aktif ↔ pasif. Pasif grubun yeni mesajları kaydedilmez (app_wa_ingest_message yalnız
--    'linked'), worker yazım anında da denetler: otomatik işlem yapılmaz.
-- ---------------------------------------------------------------------------
-- Dönüş: changed | unchanged | not_found | not_available (gruptan çıkarılmış)
CREATE FUNCTION public.app_wa_admin_set_active(p_admin uuid, p_group uuid, p_active boolean)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  g record;
  v_out text;
  v_to text := CASE WHEN p_active THEN 'linked' ELSE 'suspended' END;
BEGIN
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  IF p_admin IS NULL OR p_active IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.admin_users a WHERE a.id = p_admin AND a.status = 'active') THEN
    RAISE EXCEPTION 'wa_admin_forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO g FROM public.wa_groups wg WHERE wg.id = p_group FOR UPDATE;
  IF NOT FOUND OR g.workspace_id IS NULL THEN
    v_out := 'not_found';
  ELSIF g.status = 'left' THEN
    v_out := 'not_available';
  ELSIF g.status = v_to THEN
    v_out := 'unchanged';
  ELSE
    UPDATE public.wa_groups SET status = v_to WHERE id = g.id;
    INSERT INTO public.audit_log (id, workspace_id, actor_user_id, action, target_type,
                                  target_id, metadata)
    VALUES (pg_catalog.gen_random_uuid(), g.workspace_id, NULL,
            CASE WHEN p_active THEN 'whatsapp.group_resumed' ELSE 'whatsapp.group_suspended' END,
            'whatsapp_group', g.id, '{}'::jsonb);
    INSERT INTO public.admin_audit_log (id, admin_id, action, target_type, target_id, metadata)
    VALUES (pg_catalog.gen_random_uuid(), p_admin,
            CASE WHEN p_active THEN 'whatsapp.group_resumed' ELSE 'whatsapp.group_suspended' END,
            'wa_group', g.id, pg_catalog.jsonb_build_object('workspace', g.workspace_id));
    v_out := 'changed';
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
-- 6. Bağlantıyı kaldırma: mesaj içerikleri silinir; kayıtlar korunur
-- ---------------------------------------------------------------------------
-- Bekleyen öneriler 'expired'; grubun TÜM önerilerinin alıntısı '(silindi)' (öneri satırı,
-- rezervasyon bağı ve denetim kayıtları kalır); mesajlar (ve tepki kuyruğu) silinir; grup
-- hiçbir işletmeye bağlı değildir. Dönüş: unlinked | not_found
CREATE FUNCTION public.app_wa_admin_unlink_group(p_admin uuid, p_group uuid)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_prev_cal text := pg_catalog.current_setting('app.wa_calendar', true);
  g record;
  v_out text;
BEGIN
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  PERFORM pg_catalog.set_config('app.wa_calendar', 'on', true);
  IF p_admin IS NULL OR NOT EXISTS (SELECT 1 FROM public.admin_users a
                                     WHERE a.id = p_admin AND a.status = 'active') THEN
    RAISE EXCEPTION 'wa_admin_forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO g FROM public.wa_groups wg WHERE wg.id = p_group FOR UPDATE;
  IF NOT FOUND OR g.workspace_id IS NULL THEN
    v_out := 'not_found';
  ELSE
    UPDATE public.wa_calendar_proposals SET status = 'expired'
     WHERE group_id = g.id AND workspace_id = g.workspace_id AND status = 'pending';
    UPDATE public.wa_calendar_proposals SET message_excerpt = '(silindi)'
     WHERE group_id = g.id AND message_excerpt <> '(silindi)';
    DELETE FROM public.wa_inbound_messages WHERE group_id = g.id;
    UPDATE public.wa_groups
       SET status = CASE WHEN status = 'left' THEN 'left' ELSE 'discovered' END,
           workspace_id = NULL, property_id = NULL, linked_at = NULL, linked_by = NULL,
           linked_by_admin = NULL, link_fail_count = 0, link_fail_window_at = NULL,
           last_message_at = NULL
     WHERE id = g.id;
    INSERT INTO public.audit_log (id, workspace_id, actor_user_id, action, target_type,
                                  target_id, metadata)
    VALUES (pg_catalog.gen_random_uuid(), g.workspace_id, NULL, 'whatsapp.group_unlinked',
            'whatsapp_group', g.id, '{}'::jsonb);
    INSERT INTO public.admin_audit_log (id, admin_id, action, target_type, target_id, metadata)
    VALUES (pg_catalog.gen_random_uuid(), p_admin, 'whatsapp.group_unlinked', 'wa_group', g.id,
            pg_catalog.jsonb_build_object('workspace', g.workspace_id, 'property', g.property_id));
    v_out := 'unlinked';
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  RETURN v_out;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.wa_calendar', coalesce(v_prev_cal, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. Yok say / arşivle (yalnız hiçbir işletmeye bağlı olmayan grup)
-- ---------------------------------------------------------------------------
-- Dönüş: changed | unchanged | not_found | not_available
CREATE FUNCTION public.app_wa_admin_archive_group(p_admin uuid, p_group uuid, p_archive boolean)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  g record;
  v_out text;
BEGIN
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  IF p_admin IS NULL OR p_archive IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.admin_users a WHERE a.id = p_admin AND a.status = 'active') THEN
    RAISE EXCEPTION 'wa_admin_forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO g FROM public.wa_groups wg WHERE wg.id = p_group FOR UPDATE;
  IF NOT FOUND THEN
    v_out := 'not_found';
  ELSIF g.workspace_id IS NOT NULL THEN
    v_out := 'not_available';
  ELSIF (g.archived_at IS NOT NULL) = p_archive THEN
    v_out := 'unchanged';
  ELSE
    UPDATE public.wa_groups
       SET archived_at = CASE WHEN p_archive THEN pg_catalog.now() END,
           archived_by_admin = CASE WHEN p_archive THEN p_admin END
     WHERE id = g.id;
    INSERT INTO public.admin_audit_log (id, admin_id, action, target_type, target_id, metadata)
    VALUES (pg_catalog.gen_random_uuid(), p_admin,
            CASE WHEN p_archive THEN 'whatsapp.group_archived' ELSE 'whatsapp.group_unarchived' END,
            'wa_group', g.id, '{}'::jsonb);
    v_out := 'changed';
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
-- 8. Yetkiler
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.app_wa_admin_groups(uuid),
  public.app_wa_admin_workspaces(uuid, text),
  public.app_wa_admin_properties(uuid, uuid),
  public.app_wa_admin_connections(uuid),
  public.app_wa_admin_link_group(uuid, uuid, uuid, uuid),
  public.app_wa_admin_set_property(uuid, uuid, uuid),
  public.app_wa_admin_set_active(uuid, uuid, boolean),
  public.app_wa_admin_unlink_group(uuid, uuid),
  public.app_wa_admin_archive_group(uuid, uuid, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_wa_admin_groups(uuid),
  public.app_wa_admin_workspaces(uuid, text),
  public.app_wa_admin_properties(uuid, uuid),
  public.app_wa_admin_connections(uuid),
  public.app_wa_admin_link_group(uuid, uuid, uuid, uuid),
  public.app_wa_admin_set_property(uuid, uuid, uuid),
  public.app_wa_admin_set_active(uuid, uuid, boolean),
  public.app_wa_admin_unlink_group(uuid, uuid),
  public.app_wa_admin_archive_group(uuid, uuid, boolean) TO app_admin;
--> statement-breakpoint

-- İşletme paneli (app_user) artık grup eşleştiremez, villasını değiştiremez, askıya alamaz veya
-- bağlantı kesemez; eski kodlu bağlama ve yönetici eşleştirme yetkisi de kapanır.
REVOKE EXECUTE ON FUNCTION public.app_wa_claim_group(uuid, uuid),
  public.app_wa_pending_groups(),
  public.app_wa_unlink_group(uuid),
  public.app_wa_redeem_link_code(uuid, text, text, text) FROM app_user;
--> statement-breakpoint
REVOKE UPDATE ON TABLE public.wa_groups FROM app_user;
--> statement-breakpoint
REVOKE UPDATE (status, property_id) ON TABLE public.wa_groups FROM app_user;
--> statement-breakpoint
REVOKE INSERT, DELETE ON TABLE public.wa_link_managers FROM app_user;
--> statement-breakpoint
REVOKE INSERT (workspace_id, user_id, granted_by) ON TABLE public.wa_link_managers FROM app_user;
--> statement-breakpoint
REVOKE INSERT ON TABLE public.wa_link_codes FROM app_user;
--> statement-breakpoint
REVOKE INSERT (id, workspace_id, created_by, code_salt, code_hash, phone_hash, expires_at)
  ON TABLE public.wa_link_codes FROM app_user;
