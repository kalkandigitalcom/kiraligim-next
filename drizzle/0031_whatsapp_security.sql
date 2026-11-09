-- 0031_whatsapp_security (WhatsApp Asistanı A1: grup kaydı ve mesaj kuyruğu, yalnız okuma)
-- 0030'da oluşturulan tabloların güvenliği ve ağ geçidinin dar yazma yolu. Mevcut tablolara
-- kolon, tetikleyici veya fonksiyon EKLENMEZ; rezervasyon, fiyat ve iCal nesnelerine hiçbir
-- referans yoktur. Mevcut tablolara yalnız iki dar politika eklenir (belgelenmiş istisna,
-- 0024/0029 ile aynı desen): workspaces_wa_read (yetki denetimi için okuma) ve
-- audit_log_wa_insert (yalnız whatsapp.* eylemleri).
--
-- Güvenlik modeli:
--   * Ağ geçidi app_user olarak bağlanır ama tablolara doğrudan erişemez (bağlamı yoktur; RLS
--     hiçbir satırı göstermez ve yazma yetkisi yoktur). Tek yolu SECURITY DEFINER fonksiyonlar:
--     app_wa_heartbeat, app_wa_sync_group, app_wa_redeem_link_code, app_wa_ingest_message,
--     app_wa_purge_messages. Fonksiyonlar app_migrator sahipliğindedir; tablolar FORCE RLS olduğu
--     için app_migrator'a yalnız fonksiyonun transaction içinde açtığı app.wa_fn ayarıyla geçerli
--     politikalar verilir.
--   * Panel (app_user, işletme bağlamında): grupları üyeler görür; mesajları owner ve manager
--     görür; kod üretme ve grup askıya alma owner ile owner'ın yetkilendirdiği manager'a açıktır
--     (app_wa_can_manage). Bağlantıyı kesme tek fonksiyondur (app_wa_unlink_group).
--   * Grup bağlama: 8 karakterlik kod (tuzlu SHA-256), 10 dk, tek kullanım; kod yalnız onu üreten
--     kişinin panelde verdiği WhatsApp numarasından yazılırsa kabul edilir. Grup başına saatte en
--     fazla 5 hatalı deneme. Bağlı grup kodla başka işletmeye taşınamaz.
--   * Mesajlar yalnız bağlı ve aktif gruplardan kaydedilir; (grup, mesaj kimliği) tekildir.
--
-- Geri alma (veri kaybı: WhatsApp grupları, kodlar ve mesajlar):
--   DROP FUNCTION app_wa_heartbeat(text, text, text), app_wa_sync_group(uuid, text, text, integer,
--     boolean, boolean, boolean), app_wa_redeem_link_code(uuid, text, text, text),
--     app_wa_ingest_message(uuid, text, text, text, text, text, text, timestamptz, text),
--     app_wa_purge_messages(integer), app_wa_unlink_group(uuid), app_wa_can_manage();
--   DROP POLICY workspaces_wa_read ON workspaces; DROP POLICY audit_log_wa_insert ON audit_log;
--   DROP TABLE wa_inbound_messages, wa_link_codes, wa_link_managers, wa_groups, wa_connections.

-- ---------------------------------------------------------------------------
-- 1. RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.wa_connections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.wa_connections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.wa_groups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.wa_groups FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.wa_link_managers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.wa_link_managers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.wa_link_codes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.wa_link_codes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.wa_inbound_messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.wa_inbound_messages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Yetki yardımcısı: owner ya da owner'ın yetkilendirdiği manager (SECURITY INVOKER)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_wa_can_manage() RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(
    CASE public.app_current_member_role()
      WHEN 'owner' THEN true
      WHEN 'manager' THEN EXISTS (
        SELECT 1 FROM public.wa_link_managers l
         WHERE l.workspace_id = public.app_current_workspace_id()
           AND l.user_id = public.app_current_user_id())
      ELSE false
    END, false)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_wa_can_manage() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_wa_can_manage() TO app_user;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. app_user politikaları (panel, işletme bağlamında)
-- ---------------------------------------------------------------------------
CREATE POLICY wa_connections_select ON public.wa_connections FOR SELECT TO app_user
  USING (public.app_current_member_role() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY wa_groups_select ON public.wa_groups FOR SELECT TO app_user
  USING (workspace_id = public.app_current_workspace_id()
         AND public.app_current_member_role() IS NOT NULL);
--> statement-breakpoint
-- Yalnız aktif ↔ askıda geçişi (kolon yetkisi yalnız status); bağlantıyı kesme fonksiyonla.
CREATE POLICY wa_groups_update ON public.wa_groups FOR UPDATE TO app_user
  USING (workspace_id = public.app_current_workspace_id()
         AND status IN ('linked', 'suspended') AND public.app_wa_can_manage())
  WITH CHECK (workspace_id = public.app_current_workspace_id()
              AND status IN ('linked', 'suspended'));
--> statement-breakpoint
CREATE POLICY wa_link_managers_select ON public.wa_link_managers FOR SELECT TO app_user
  USING (workspace_id = public.app_current_workspace_id()
         AND public.app_current_member_role() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY wa_link_managers_insert ON public.wa_link_managers FOR INSERT TO app_user
  WITH CHECK (workspace_id = public.app_current_workspace_id()
              AND public.app_current_member_role() = 'owner'
              AND granted_by = public.app_current_user_id()
              AND EXISTS (SELECT 1 FROM public.workspace_members m
                           WHERE m.workspace_id = wa_link_managers.workspace_id
                             AND m.user_id = wa_link_managers.user_id
                             AND m.role = 'manager'));
--> statement-breakpoint
CREATE POLICY wa_link_managers_delete ON public.wa_link_managers FOR DELETE TO app_user
  USING (workspace_id = public.app_current_workspace_id()
         AND public.app_current_member_role() = 'owner');
--> statement-breakpoint
-- Kodu yalnız üreten kişi görür (durum takibi); kod ve telefon özetleri kolon yetkisiyle gizli.
CREATE POLICY wa_link_codes_select ON public.wa_link_codes FOR SELECT TO app_user
  USING (workspace_id = public.app_current_workspace_id()
         AND created_by = public.app_current_user_id()
         AND public.app_current_member_role() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY wa_link_codes_insert ON public.wa_link_codes FOR INSERT TO app_user
  WITH CHECK (workspace_id = public.app_current_workspace_id()
              AND created_by = public.app_current_user_id()
              AND public.app_wa_can_manage());
--> statement-breakpoint
CREATE POLICY wa_inbound_messages_select ON public.wa_inbound_messages FOR SELECT TO app_user
  USING (workspace_id = public.app_current_workspace_id()
         AND public.app_current_member_role() IN ('owner', 'manager'));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. app_migrator: yalnız fonksiyonların açtığı app.wa_fn ayarıyla
-- ---------------------------------------------------------------------------
CREATE POLICY wa_connections_wa_fn ON public.wa_connections FOR ALL TO app_migrator
  USING (pg_catalog.current_setting('app.wa_fn', true) = 'on')
  WITH CHECK (pg_catalog.current_setting('app.wa_fn', true) = 'on');
--> statement-breakpoint
CREATE POLICY wa_groups_wa_fn ON public.wa_groups FOR ALL TO app_migrator
  USING (pg_catalog.current_setting('app.wa_fn', true) = 'on')
  WITH CHECK (pg_catalog.current_setting('app.wa_fn', true) = 'on');
--> statement-breakpoint
CREATE POLICY wa_link_managers_wa_fn ON public.wa_link_managers FOR SELECT TO app_migrator
  USING (pg_catalog.current_setting('app.wa_fn', true) = 'on');
--> statement-breakpoint
CREATE POLICY wa_link_codes_wa_fn ON public.wa_link_codes FOR ALL TO app_migrator
  USING (pg_catalog.current_setting('app.wa_fn', true) = 'on')
  WITH CHECK (pg_catalog.current_setting('app.wa_fn', true) = 'on');
--> statement-breakpoint
CREATE POLICY wa_inbound_messages_wa_fn ON public.wa_inbound_messages FOR ALL TO app_migrator
  USING (pg_catalog.current_setting('app.wa_fn', true) = 'on')
  WITH CHECK (pg_catalog.current_setting('app.wa_fn', true) = 'on');
--> statement-breakpoint
CREATE POLICY workspaces_wa_read ON public.workspaces FOR SELECT TO app_migrator
  USING (pg_catalog.current_setting('app.wa_fn', true) = 'on');
--> statement-breakpoint
CREATE POLICY audit_log_wa_insert ON public.audit_log FOR INSERT TO app_migrator
  WITH CHECK (pg_catalog.current_setting('app.wa_fn', true) = 'on'
              AND action LIKE 'whatsapp.%');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Yetkiler (kolon düzeyinde; PUBLIC / app_admin / app_worker: hiçbiri)
-- ---------------------------------------------------------------------------
GRANT SELECT (id, label, status, last_seen_at, last_connected_at, updated_at)
  ON TABLE public.wa_connections TO app_user;
--> statement-breakpoint
GRANT SELECT (id, connection_id, jid, subject, participant_count, bot_is_admin, admins_only,
  status, workspace_id, linked_at, linked_by, first_seen_at, last_seen_at, last_message_at,
  created_at, updated_at) ON TABLE public.wa_groups TO app_user;
--> statement-breakpoint
GRANT UPDATE (status) ON TABLE public.wa_groups TO app_user;
--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE public.wa_link_managers TO app_user;
--> statement-breakpoint
GRANT INSERT (workspace_id, user_id, granted_by) ON TABLE public.wa_link_managers TO app_user;
--> statement-breakpoint
GRANT SELECT (id, workspace_id, created_by, expires_at, used_at, used_group_id, created_at)
  ON TABLE public.wa_link_codes TO app_user;
--> statement-breakpoint
GRANT INSERT (id, workspace_id, created_by, code_salt, code_hash, phone_hash, expires_at)
  ON TABLE public.wa_link_codes TO app_user;
--> statement-breakpoint
GRANT SELECT (id, group_id, workspace_id, wa_message_id, sender_pn, sender_lid, body, sent_at,
  received_at, kind, status) ON TABLE public.wa_inbound_messages TO app_user;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. updated_at tetikleyicileri
-- ---------------------------------------------------------------------------
CREATE TRIGGER wa_connections_set_updated_at BEFORE UPDATE ON public.wa_connections
  FOR EACH ROW EXECUTE FUNCTION public.app_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER wa_groups_set_updated_at BEFORE UPDATE ON public.wa_groups
  FOR EACH ROW EXECUTE FUNCTION public.app_set_updated_at();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. Ağ geçidi: bağlantı durumu (etiketle kayıt; numara saklanmaz)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_wa_heartbeat(p_label text, p_status text, p_error text)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.wa_fn', true);
  v_id uuid;
BEGIN
  IF p_label IS NULL OR p_label !~ '^[a-z0-9_-]{1,40}$'
     OR p_status NOT IN ('connecting', 'open', 'closed', 'logged_out')
     OR (p_error IS NOT NULL AND p_error !~ '^[a-z0-9_]{1,40}$') THEN
    RAISE EXCEPTION 'wa_heartbeat_invalid' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  INSERT INTO public.wa_connections AS c (id, label, status, last_seen_at, last_connected_at,
                                          last_error_code)
  VALUES (pg_catalog.gen_random_uuid(), p_label, p_status, pg_catalog.now(),
          CASE WHEN p_status = 'open' THEN pg_catalog.now() END, p_error)
  ON CONFLICT (label) DO UPDATE
     SET status = EXCLUDED.status,
         last_seen_at = EXCLUDED.last_seen_at,
         last_connected_at = CASE WHEN EXCLUDED.status = 'open' THEN EXCLUDED.last_seen_at
                                  ELSE c.last_connected_at END,
         last_error_code = EXCLUDED.last_error_code
  RETURNING c.id INTO v_id;
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev, ''), true);
  RETURN v_id;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 8. Ağ geçidi: grup keşfi. Bağlı grubun işletmesi burada ASLA değişmez.
-- ---------------------------------------------------------------------------
-- Dönüş: grubun güncel durumu. p_present = false → Kiraligim gruptan çıkarıldı ("left").
-- Gruba yeniden eklenirse: daha önce bağlıysa "suspended" (owner yeniden etkinleştirir), değilse
-- "discovered".
CREATE FUNCTION public.app_wa_sync_group(
  p_connection uuid, p_jid text, p_subject text, p_participants integer,
  p_bot_is_admin boolean, p_admins_only boolean, p_present boolean)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.wa_fn', true);
  v_subject text := nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p_subject, '')), 200), '');
  v_status text;
BEGIN
  IF p_connection IS NULL OR p_jid IS NULL OR p_jid !~ '^[0-9]{6,40}(-[0-9]{6,20})?@g\.us$'
     OR p_present IS NULL THEN
    RAISE EXCEPTION 'wa_sync_invalid' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  INSERT INTO public.wa_groups AS g (id, connection_id, jid, subject, participant_count,
                                     bot_is_admin, admins_only, status)
  VALUES (pg_catalog.gen_random_uuid(), p_connection, p_jid, v_subject,
          greatest(coalesce(p_participants, 0), 0), coalesce(p_bot_is_admin, false),
          coalesce(p_admins_only, false), CASE WHEN p_present THEN 'discovered' ELSE 'left' END)
  ON CONFLICT (connection_id, jid) DO UPDATE
     SET subject = coalesce(EXCLUDED.subject, g.subject),
         participant_count = CASE WHEN p_present THEN EXCLUDED.participant_count
                                  ELSE g.participant_count END,
         bot_is_admin = CASE WHEN p_present THEN EXCLUDED.bot_is_admin ELSE false END,
         admins_only = CASE WHEN p_present THEN EXCLUDED.admins_only ELSE g.admins_only END,
         status = CASE
                    WHEN NOT p_present THEN 'left'
                    WHEN g.status = 'left' AND g.workspace_id IS NOT NULL THEN 'suspended'
                    WHEN g.status = 'left' THEN 'discovered'
                    ELSE g.status
                  END,
         last_seen_at = pg_catalog.now()
  RETURNING g.status INTO v_status;
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev, ''), true);
  RETURN v_status;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 9. Ağ geçidi: grup bağlama kodu
-- ---------------------------------------------------------------------------
-- Dönüş: linked | invalid | sender_unknown | sender_mismatch | not_permitted | already_linked |
--        linked_elsewhere | throttled | unknown_group. Yalnız "linked" için ağ geçidi ✅ bırakır.
-- Hatalı kod ve yanlış gönderen, grup başına saatlik hata sayacını artırır (5'te kilit).
CREATE FUNCTION public.app_wa_redeem_link_code(
  p_connection uuid, p_jid text, p_code text, p_sender_pn text)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.wa_fn', true);
  v_now timestamptz := pg_catalog.clock_timestamp();
  g record;
  c record;
  v_role text;
  v_out text;
BEGIN
  IF p_connection IS NULL OR p_jid IS NULL OR p_code IS NULL
     OR p_code !~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{8}$'
     OR (p_sender_pn IS NOT NULL AND p_sender_pn !~ '^[1-9][0-9]{6,19}$') THEN
    RAISE EXCEPTION 'wa_redeem_invalid' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);

  SELECT * INTO g FROM public.wa_groups
   WHERE connection_id = p_connection AND jid = p_jid
   FOR UPDATE;
  IF NOT FOUND OR g.status = 'left' THEN
    v_out := 'unknown_group';
  ELSIF g.link_fail_window_at IS NOT NULL AND g.link_fail_window_at > v_now - interval '1 hour'
        AND g.link_fail_count >= 5 THEN
    v_out := 'throttled';
  ELSE
    SELECT * INTO c FROM public.wa_link_codes lc
     WHERE lc.used_at IS NULL AND lc.expires_at > v_now
       AND lc.code_hash = pg_catalog.encode(pg_catalog.sha256(
             pg_catalog.convert_to(lc.code_salt || ':' || p_code, 'UTF8')), 'hex')
     ORDER BY lc.created_at DESC
     LIMIT 1
     FOR UPDATE;
    IF NOT FOUND THEN
      v_out := 'invalid';
    ELSIF p_sender_pn IS NULL THEN
      v_out := 'sender_unknown';  -- kod tüketilmez; gönderen numarası çözülemedi
    ELSIF c.phone_hash <> pg_catalog.encode(pg_catalog.sha256(
            pg_catalog.convert_to(c.code_salt || ':phone:' || p_sender_pn, 'UTF8')), 'hex') THEN
      v_out := 'sender_mismatch';
    ELSE
      -- Kodu üreten kişi hâlâ yetkili mi? (aktif işletme; owner ya da yetkili manager)
      SELECT m.role INTO v_role
        FROM public.workspace_members m
        JOIN public.workspaces w ON w.id = m.workspace_id AND w.status = 'active'
       WHERE m.workspace_id = c.workspace_id AND m.user_id = c.created_by;
      IF v_role IS NULL OR NOT (v_role = 'owner' OR (v_role = 'manager' AND EXISTS (
           SELECT 1 FROM public.wa_link_managers l
            WHERE l.workspace_id = c.workspace_id AND l.user_id = c.created_by))) THEN
        UPDATE public.wa_link_codes SET used_at = v_now WHERE id = c.id;
        v_out := 'not_permitted';
      ELSIF g.workspace_id IS NOT NULL THEN
        v_out := CASE WHEN g.workspace_id = c.workspace_id THEN 'already_linked'
                      ELSE 'linked_elsewhere' END;
      ELSE
        UPDATE public.wa_groups
           SET status = 'linked', workspace_id = c.workspace_id, linked_at = v_now,
               linked_by = c.created_by, link_fail_count = 0, link_fail_window_at = NULL
         WHERE id = g.id;
        UPDATE public.wa_link_codes SET used_at = v_now, used_group_id = g.id WHERE id = c.id;
        INSERT INTO public.audit_log (id, workspace_id, actor_user_id, action, target_type,
                                      target_id, metadata)
        VALUES (pg_catalog.gen_random_uuid(), c.workspace_id, c.created_by,
                'whatsapp.group_linked', 'whatsapp_group', g.id,
                pg_catalog.jsonb_build_object('method', 'link_code'));
        v_out := 'linked';
      END IF;
    END IF;

    IF v_out IN ('invalid', 'sender_mismatch') THEN
      UPDATE public.wa_groups
         SET link_fail_count = CASE
               WHEN link_fail_window_at IS NULL OR link_fail_window_at <= v_now - interval '1 hour'
               THEN 1 ELSE link_fail_count + 1 END,
             link_fail_window_at = CASE
               WHEN link_fail_window_at IS NULL OR link_fail_window_at <= v_now - interval '1 hour'
               THEN v_now ELSE link_fail_window_at END
       WHERE id = g.id;
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
-- 10. Ağ geçidi: mesaj kaydı (yalnız bağlı ve aktif grup; tekil)
-- ---------------------------------------------------------------------------
-- Dönüş: stored | duplicate | ignored. Kayıtta pg_notify('wa_inbound', <id>) (A3 worker için).
CREATE FUNCTION public.app_wa_ingest_message(
  p_connection uuid, p_jid text, p_message_id text, p_sender_jid text, p_sender_pn text,
  p_sender_lid text, p_body text, p_sent_at timestamptz, p_kind text)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.wa_fn', true);
  v_now timestamptz := pg_catalog.clock_timestamp();
  g record;
  v_id uuid;
  v_body text := pg_catalog.left(coalesce(p_body, ''), 4000);
  v_out text;
BEGIN
  IF p_connection IS NULL OR p_jid IS NULL
     OR p_message_id IS NULL OR pg_catalog.length(p_message_id) NOT BETWEEN 1 AND 128
     OR p_sender_jid IS NULL OR pg_catalog.length(p_sender_jid) NOT BETWEEN 3 AND 128
     OR (p_sender_pn IS NOT NULL AND p_sender_pn !~ '^[1-9][0-9]{6,19}$')
     OR (p_sender_lid IS NOT NULL AND pg_catalog.length(p_sender_lid) > 128)
     OR p_kind NOT IN ('live', 'backlog') OR p_sent_at IS NULL THEN
    RAISE EXCEPTION 'wa_ingest_invalid' USING ERRCODE = 'check_violation';
  END IF;
  IF pg_catalog.btrim(v_body) = '' THEN
    RETURN 'ignored';
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  SELECT g2.id, g2.workspace_id INTO g FROM public.wa_groups g2
   WHERE g2.connection_id = p_connection AND g2.jid = p_jid AND g2.status = 'linked';
  IF NOT FOUND THEN
    v_out := 'ignored';
  ELSE
    INSERT INTO public.wa_inbound_messages (id, connection_id, group_id, workspace_id,
      wa_message_id, sender_jid, sender_pn, sender_lid, body, sent_at, kind)
    VALUES (pg_catalog.gen_random_uuid(), p_connection, g.id, g.workspace_id, p_message_id,
            p_sender_jid, p_sender_pn, p_sender_lid, v_body,
            least(p_sent_at, v_now + interval '5 minutes'), p_kind)
    ON CONFLICT (group_id, wa_message_id) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      v_out := 'duplicate';
    ELSE
      UPDATE public.wa_groups SET last_message_at = v_now WHERE id = g.id;
      PERFORM pg_catalog.pg_notify('wa_inbound', v_id::text);
      v_out := 'stored';
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
-- 11. Saklama: süresi dolan mesajları ve eski kodları siler
-- ---------------------------------------------------------------------------
-- Dönüş: silinen mesaj sayısı. p_days 1–365 (uygulama sabiti: WA_RETENTION_DAYS = 90).
CREATE FUNCTION public.app_wa_purge_messages(p_days integer)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.wa_fn', true);
  v_count integer;
BEGIN
  IF p_days IS NULL OR p_days < 1 OR p_days > 365 THEN
    RAISE EXCEPTION 'wa_purge_invalid' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  DELETE FROM public.wa_inbound_messages
   WHERE received_at < pg_catalog.now() - pg_catalog.make_interval(days => p_days);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  DELETE FROM public.wa_link_codes
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
-- 12. Panel: grup bağlantısını kesme (owner / yetkili manager)
-- ---------------------------------------------------------------------------
-- Grubun mesajları hemen silinir; grup "bağlı değil" olur (hiçbir işletmeye görünmez).
-- Dönüş: unlinked | not_found | forbidden.
CREATE FUNCTION public.app_wa_unlink_group(p_group uuid)
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
      DELETE FROM public.wa_inbound_messages WHERE group_id = p_group;
      UPDATE public.wa_groups
         SET status = CASE WHEN status = 'left' THEN 'left' ELSE 'discovered' END,
             workspace_id = NULL, linked_at = NULL, linked_by = NULL,
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
-- 13. EXECUTE yetkileri (yalnız app_user)
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.app_wa_heartbeat(text, text, text),
  public.app_wa_sync_group(uuid, text, text, integer, boolean, boolean, boolean),
  public.app_wa_redeem_link_code(uuid, text, text, text),
  public.app_wa_ingest_message(uuid, text, text, text, text, text, text, timestamptz, text),
  public.app_wa_purge_messages(integer),
  public.app_wa_unlink_group(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_wa_heartbeat(text, text, text),
  public.app_wa_sync_group(uuid, text, text, integer, boolean, boolean, boolean),
  public.app_wa_redeem_link_code(uuid, text, text, text),
  public.app_wa_ingest_message(uuid, text, text, text, text, text, text, timestamptz, text),
  public.app_wa_purge_messages(integer),
  public.app_wa_unlink_group(uuid) TO app_user;
