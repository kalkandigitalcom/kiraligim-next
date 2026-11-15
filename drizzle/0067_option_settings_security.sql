-- 0067_option_settings_security (Opsiyon Aşama 3a: otomasyon ayarlarının güvenliği)
--
-- Tablolar 0066'da. Bu migration YALNIZ Opsiyon Sistemi nesnelerini ekler veya değiştirir:
-- mevcut worker, ayrıştırıcı, otomatik kapat / aç / değiştir, tepki kuyruğu, rezervasyon, API,
-- iCal ve webhook fonksiyonlarına, tablolarına ve politikalarına DOKUNMAZ. Mevcut üç tabloya
-- (admin_users, admin_audit_log, audit_log) yalnız app.option_fn bayrağına bağlı, "option.%"
-- eylemleriyle sınırlı yeni politikalar eklenir (mevcut politikalar aynen kalır).
--
--   1. option_automation_global tek satır KAPALI tohumlanır. Satırı olmayan işletme ve grup
--      KAPALI sayılır: yeni gruplar ve işletmeler kapalı başlar.
--   2. ENABLE/FORCE RLS. app_user yalnız OKUR (global; işletme ve grup ayarları yalnız kendi
--      işletmesinin owner/manager'ı); yazma yetkisi yoktur.
--   3. app_option_automation_enabled(grup) / app_option_automation_since(grup): global, işletme
--      ve grup anahtarının ÜÇÜ de açıksa, grup bağlı ve villalı, işletme aktif ve grup ayarı
--      grubun SON bağlanmasından sonra aynı işletme için verilmişse açık (since = en son açılma
--      anı). Aksi her durumda kapalı / NULL (kill switch).
--   4. Super Admin fonksiyonları (SECURITY DEFINER, YALNIZ app_admin): app_option_admin_settings,
--      app_option_admin_set_global, app_option_admin_set_workspace, app_option_admin_set_group.
--      Çağıran yönetici admin_users'ta aktif olmalı (değilse 42501); her değişiklik
--      admin_audit_log'a ve ilgili işletmenin audit_log'una yazılır.
--   5. A2 opsiyon tetikleyicileri (yalnız opsiyon tabloları) yeni sütunlar için güncellenir:
--      kişi sayısı (adults / children) yabancı anahtar yolunda da korunur; geçmişe Super Admin
--      aktörü (actor_admin_id) yazılır; geçmiş korumasında actor_admin_id'nin SET NULL eylemine
--      izin verilir.
--
-- Geri alma: docs/rollback-0066-0069.sql.

-- ---------------------------------------------------------------------------
-- 1. Global anahtar: tek satır, KAPALI (RLS açılmadan önce, migration sahibiyle)
-- ---------------------------------------------------------------------------
INSERT INTO public.option_automation_global (id, enabled) VALUES (1, false)
  ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. RLS ve yetkiler
-- ---------------------------------------------------------------------------
ALTER TABLE public.option_automation_global ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.option_automation_global FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.workspace_option_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.workspace_option_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.wa_group_option_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.wa_group_option_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY option_automation_global_select ON public.option_automation_global
  FOR SELECT TO app_user USING (true);
--> statement-breakpoint
CREATE POLICY workspace_option_settings_select ON public.workspace_option_settings
  FOR SELECT TO app_user
  USING (workspace_id = public.app_current_workspace_id()
         AND public.app_current_member_role() IN ('owner', 'manager'));
--> statement-breakpoint
CREATE POLICY wa_group_option_settings_select ON public.wa_group_option_settings
  FOR SELECT TO app_user
  USING (workspace_id = public.app_current_workspace_id()
         AND public.app_current_member_role() IN ('owner', 'manager'));
--> statement-breakpoint
-- Fonksiyonlar (sahip app_migrator) yalnız app.option_fn bayrağıyla okur / yazar.
CREATE POLICY option_automation_global_fn ON public.option_automation_global
  FOR ALL TO app_migrator
  USING (pg_catalog.current_setting('app.option_fn', true) = 'on')
  WITH CHECK (pg_catalog.current_setting('app.option_fn', true) = 'on');
--> statement-breakpoint
CREATE POLICY workspace_option_settings_fn ON public.workspace_option_settings
  FOR ALL TO app_migrator
  USING (pg_catalog.current_setting('app.option_fn', true) = 'on')
  WITH CHECK (pg_catalog.current_setting('app.option_fn', true) = 'on');
--> statement-breakpoint
CREATE POLICY wa_group_option_settings_fn ON public.wa_group_option_settings
  FOR ALL TO app_migrator
  USING (pg_catalog.current_setting('app.option_fn', true) = 'on')
  WITH CHECK (pg_catalog.current_setting('app.option_fn', true) = 'on');
--> statement-breakpoint
-- Mevcut tablolara EK politikalar: yalnız opsiyon fonksiyonları, yalnız "option.%" eylemleri.
CREATE POLICY admin_users_option_fn ON public.admin_users FOR SELECT TO app_migrator
  USING (pg_catalog.current_setting('app.option_fn', true) = 'on');
--> statement-breakpoint
CREATE POLICY admin_audit_log_option_fn ON public.admin_audit_log FOR INSERT TO app_migrator
  WITH CHECK (pg_catalog.current_setting('app.option_fn', true) = 'on' AND action LIKE 'option.%');
--> statement-breakpoint
CREATE POLICY audit_log_option_fn ON public.audit_log FOR INSERT TO app_migrator
  WITH CHECK (pg_catalog.current_setting('app.option_fn', true) = 'on' AND action LIKE 'option.%');
--> statement-breakpoint
GRANT SELECT ON TABLE public.option_automation_global, public.workspace_option_settings,
  public.wa_group_option_settings TO app_user;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Etkin otomasyon (kill switch): üç anahtarın üçü de açık mı, ne zamandan beri?
-- ---------------------------------------------------------------------------
-- app_option_automation_since(grup): otomasyon KAPALIYSA NULL; açıksa en son açılma / grup
-- bağlanma anı (üç ayarın ve grubun linked_at'inin en büyüğü). Opsiyon görevi yalnız bu andan
-- SONRA gelen mesajları okur: anahtar açılmadan önce gelen mesajlardan geriye dönük opsiyon
-- oluşmaz.
CREATE FUNCTION public.app_option_automation_since(p_group uuid) RETURNS timestamptz
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_prev_opt text := pg_catalog.current_setting('app.option_fn', true);
  v_since timestamptz;
BEGIN
  IF p_group IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  SELECT GREATEST(o.updated_at, s.updated_at, gs.updated_at, g.linked_at)
    INTO v_since
    FROM public.wa_groups g
    JOIN public.workspaces w ON w.id = g.workspace_id
    JOIN public.option_automation_global o ON o.id = 1
    JOIN public.workspace_option_settings s ON s.workspace_id = g.workspace_id
    JOIN public.wa_group_option_settings gs ON gs.group_id = g.id
   WHERE g.id = p_group AND g.status = 'linked' AND g.property_id IS NOT NULL
     AND g.linked_at IS NOT NULL AND w.status = 'active'
     AND o.enabled AND s.automation_enabled AND gs.enabled
     AND gs.workspace_id = g.workspace_id AND gs.updated_at >= g.linked_at;
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RETURN v_since;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint
CREATE FUNCTION public.app_option_automation_enabled(p_group uuid) RETURNS boolean
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$ SELECT public.app_option_automation_since(p_group) IS NOT NULL $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_option_automation_since(uuid),
  public.app_option_automation_enabled(uuid) FROM PUBLIC;
--> statement-breakpoint
-- Yalnız option-maintenance (app_user). Super Admin etkin durumu app_option_admin_settings'ten okur.
GRANT EXECUTE ON FUNCTION public.app_option_automation_since(uuid),
  public.app_option_automation_enabled(uuid) TO app_user;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Super Admin: ayarları listeleme ve değiştirme (YALNIZ app_admin)
-- ---------------------------------------------------------------------------
-- İç yardımcı: çağıran aktif bir Super Admin mi? (bayraklar çağıranda açık olmalı)
CREATE FUNCTION public.app_option_admin_check(p_admin uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_admin IS NULL OR NOT EXISTS (SELECT 1 FROM public.admin_users a
                                     WHERE a.id = p_admin AND a.status = 'active') THEN
    RAISE EXCEPTION 'option_admin_forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_option_admin_check(uuid) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.app_option_admin_settings(p_admin uuid)
  RETURNS TABLE (scope text, target_id uuid, workspace_id uuid, enabled boolean, effective boolean,
                 default_minutes integer, choices integer[], updated_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_prev_opt text := pg_catalog.current_setting('app.option_fn', true);
BEGIN
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  PERFORM public.app_option_admin_check(p_admin);
  RETURN QUERY
    SELECT 'global'::text, NULL::uuid, NULL::uuid, o.enabled, o.enabled, NULL::integer,
           NULL::integer[], o.updated_at
      FROM public.option_automation_global o WHERE o.id = 1
    UNION ALL
    SELECT 'workspace'::text, s.workspace_id, s.workspace_id, s.automation_enabled,
           (s.automation_enabled AND (SELECT o.enabled FROM public.option_automation_global o WHERE o.id = 1)),
           s.default_duration_minutes, s.duration_choices, s.updated_at
      FROM public.workspace_option_settings s
    UNION ALL
    SELECT 'group'::text, gs.group_id, gs.workspace_id, gs.enabled,
           public.app_option_automation_enabled(gs.group_id), NULL::integer, NULL::integer[],
           gs.updated_at
      FROM public.wa_group_option_settings gs;
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev_fn, ''), true);
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- Global anahtar / kill switch. Dönüş: changed | unchanged
CREATE FUNCTION public.app_option_admin_set_global(p_admin uuid, p_enabled boolean) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_opt text := pg_catalog.current_setting('app.option_fn', true);
  v_old boolean;
  v_out text;
BEGIN
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  PERFORM public.app_option_admin_check(p_admin);
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'option_settings_invalid' USING ERRCODE = 'check_violation';
  END IF;
  SELECT o.enabled INTO v_old FROM public.option_automation_global o WHERE o.id = 1 FOR UPDATE;
  IF v_old IS NOT DISTINCT FROM p_enabled THEN
    v_out := 'unchanged';
  ELSE
    UPDATE public.option_automation_global
       SET enabled = p_enabled, updated_at = pg_catalog.now(), updated_by_admin = p_admin
     WHERE id = 1;
    INSERT INTO public.admin_audit_log (id, admin_id, action, target_type, target_id, metadata)
    VALUES (pg_catalog.gen_random_uuid(), p_admin, 'option.automation_global', 'option_settings',
            NULL, pg_catalog.jsonb_build_object('enabled', p_enabled));
    v_out := 'changed';
  END IF;
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RETURN v_out;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev_opt, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- İşletme anahtarı, varsayılan süre ve süre seçenekleri (dakika). Varsayılan verilmişse ve
-- seçenek listesi boş değilse varsayılan listede olmalı. Dönüş: changed | unchanged | not_found
CREATE FUNCTION public.app_option_admin_set_workspace(p_admin uuid, p_workspace uuid,
    p_enabled boolean, p_default_minutes integer, p_choices integer[]) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_prev_opt text := pg_catalog.current_setting('app.option_fn', true);
  v_choices integer[];
  s record;
  v_out text;
BEGIN
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  PERFORM public.app_option_admin_check(p_admin);
  -- Seçenekler sıralı ve tekil saklanır.
  v_choices := ARRAY(SELECT DISTINCT c FROM pg_catalog.unnest(coalesce(p_choices, '{}'::integer[])) AS c
                      ORDER BY c);
  IF p_enabled IS NULL OR pg_catalog.array_position(v_choices, NULL) IS NOT NULL
     OR (p_default_minutes IS NOT NULL AND pg_catalog.cardinality(v_choices) > 0
         AND NOT (p_default_minutes = ANY (v_choices))) THEN
    RAISE EXCEPTION 'option_settings_invalid' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = p_workspace) THEN
    v_out := 'not_found';
  ELSE
    SELECT * INTO s FROM public.workspace_option_settings x WHERE x.workspace_id = p_workspace
      FOR UPDATE;
    IF FOUND AND s.automation_enabled = p_enabled
       AND s.default_duration_minutes IS NOT DISTINCT FROM p_default_minutes
       AND s.duration_choices = v_choices THEN
      v_out := 'unchanged';
    ELSE
      BEGIN
        INSERT INTO public.workspace_option_settings AS x
          (workspace_id, automation_enabled, default_duration_minutes, duration_choices,
           updated_at, updated_by_admin)
        VALUES (p_workspace, p_enabled, p_default_minutes, v_choices, pg_catalog.now(), p_admin)
        ON CONFLICT (workspace_id) DO UPDATE
          SET automation_enabled = EXCLUDED.automation_enabled,
              default_duration_minutes = EXCLUDED.default_duration_minutes,
              duration_choices = EXCLUDED.duration_choices,
              updated_at = EXCLUDED.updated_at, updated_by_admin = EXCLUDED.updated_by_admin;
      EXCEPTION WHEN check_violation THEN
        RAISE EXCEPTION 'option_settings_invalid' USING ERRCODE = 'check_violation';
      END;
      INSERT INTO public.audit_log (id, workspace_id, actor_user_id, action, target_type,
                                    target_id, metadata)
      VALUES (pg_catalog.gen_random_uuid(), p_workspace, NULL, 'option.settings_changed',
              'workspace', p_workspace,
              pg_catalog.jsonb_build_object('enabled', p_enabled, 'default_minutes', p_default_minutes,
                                            'choices', pg_catalog.to_jsonb(v_choices)));
      INSERT INTO public.admin_audit_log (id, admin_id, action, target_type, target_id, metadata)
      VALUES (pg_catalog.gen_random_uuid(), p_admin, 'option.automation_workspace', 'workspace',
              p_workspace,
              pg_catalog.jsonb_build_object('enabled', p_enabled, 'default_minutes', p_default_minutes,
                                            'choices', pg_catalog.to_jsonb(v_choices)));
      v_out := 'changed';
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

-- Grup anahtarı. Yalnız bağlı ve villalı grup için açılabilir (kapatma her durumda serbest).
-- Grup satırına DOKUNULMAZ (yalnız FOR SHARE ile okunur). Dönüş: changed | unchanged | not_found |
-- not_available
CREATE FUNCTION public.app_option_admin_set_group(p_admin uuid, p_group uuid, p_enabled boolean)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev_fn text := pg_catalog.current_setting('app.wa_fn', true);
  v_prev_opt text := pg_catalog.current_setting('app.option_fn', true);
  g record;
  s record;
  v_out text;
BEGIN
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  PERFORM pg_catalog.set_config('app.option_fn', 'on', true);
  PERFORM public.app_option_admin_check(p_admin);
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'option_settings_invalid' USING ERRCODE = 'check_violation';
  END IF;
  SELECT wg.id, wg.workspace_id, wg.status, wg.property_id INTO g
    FROM public.wa_groups wg WHERE wg.id = p_group FOR SHARE;
  SELECT * INTO s FROM public.wa_group_option_settings x WHERE x.group_id = p_group FOR UPDATE;
  IF g.id IS NULL THEN
    v_out := 'not_found';
  ELSIF p_enabled AND (g.workspace_id IS NULL OR g.status <> 'linked' OR g.property_id IS NULL) THEN
    v_out := 'not_available';
  ELSIF s.group_id IS NOT NULL AND s.enabled = p_enabled
        AND s.workspace_id IS NOT DISTINCT FROM g.workspace_id
        AND (g.workspace_id IS NULL OR NOT p_enabled
             OR (SELECT wg.linked_at FROM public.wa_groups wg WHERE wg.id = p_group) <= s.updated_at) THEN
    v_out := 'unchanged';
  ELSIF g.workspace_id IS NULL THEN
    -- Bağlantısı kaldırılmış grup: yalnız kapatma; satır silinmez, kapatılır.
    UPDATE public.wa_group_option_settings
       SET enabled = false, updated_at = pg_catalog.now(), updated_by_admin = p_admin
     WHERE group_id = p_group;
    INSERT INTO public.admin_audit_log (id, admin_id, action, target_type, target_id, metadata)
    VALUES (pg_catalog.gen_random_uuid(), p_admin, 'option.automation_group', 'wa_group', p_group,
            pg_catalog.jsonb_build_object('enabled', false));
    v_out := CASE WHEN s.group_id IS NULL OR NOT s.enabled THEN 'unchanged' ELSE 'changed' END;
  ELSE
    INSERT INTO public.wa_group_option_settings AS x
      (group_id, workspace_id, enabled, updated_at, updated_by_admin)
    VALUES (p_group, g.workspace_id, p_enabled, pg_catalog.now(), p_admin)
    ON CONFLICT (group_id) DO UPDATE
      SET workspace_id = EXCLUDED.workspace_id, enabled = EXCLUDED.enabled,
          updated_at = EXCLUDED.updated_at, updated_by_admin = EXCLUDED.updated_by_admin;
    INSERT INTO public.audit_log (id, workspace_id, actor_user_id, action, target_type,
                                  target_id, metadata)
    VALUES (pg_catalog.gen_random_uuid(), g.workspace_id, NULL, 'option.settings_changed',
            'whatsapp_group', p_group, pg_catalog.jsonb_build_object('enabled', p_enabled));
    INSERT INTO public.admin_audit_log (id, admin_id, action, target_type, target_id, metadata)
    VALUES (pg_catalog.gen_random_uuid(), p_admin, 'option.automation_group', 'wa_group', p_group,
            pg_catalog.jsonb_build_object('enabled', p_enabled, 'workspace', g.workspace_id));
    v_out := 'changed';
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
REVOKE ALL ON FUNCTION public.app_option_admin_settings(uuid),
  public.app_option_admin_set_global(uuid, boolean),
  public.app_option_admin_set_workspace(uuid, uuid, boolean, integer, integer[]),
  public.app_option_admin_set_group(uuid, uuid, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_option_admin_settings(uuid),
  public.app_option_admin_set_global(uuid, boolean),
  public.app_option_admin_set_workspace(uuid, uuid, boolean, integer, integer[]),
  public.app_option_admin_set_group(uuid, uuid, boolean) TO app_admin;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. A2 opsiyon tetikleyicileri: yeni sütunlar (yalnız opsiyon tabloları)
-- ---------------------------------------------------------------------------
-- Kişi sayısı da yabancı anahtar (SET NULL) yolunda değişmemeli; aksi hâlde normal güncellemedir
-- (sürüm artar, son durumda reddedilir). Gövdenin geri kalanı 0065 ile aynı.
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
     OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL) THEN
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
-- Geçmiş: Super Admin aktörü, opsiyonu yazan fonksiyonun aynı transaction'da koyduğu
-- app.option_admin ayarından okunur. Opsiyonu yazan HER fonksiyon bu ayarı kendisi belirler
-- (Super Admin fonksiyonu: çağıran yönetici; diğerleri: boş); app_user opsiyon tablosuna yazamaz.
CREATE OR REPLACE FUNCTION public.app_reservation_options_history() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.option_fn', true);
  v_event text;
  v_admin uuid := NULLIF(pg_catalog.current_setting('app.option_admin', true), '')::uuid;
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
     actor_admin_id, message_id, converted_reservation_id, version, created_at)
  VALUES
    (pg_catalog.gen_random_uuid(), NEW.id, NEW.workspace_id, v_event,
     CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status, NEW.end_reason,
     CASE WHEN TG_OP = 'INSERT' THEN NEW.created_by
          ELSE coalesce(NEW.ended_by_user_id, NEW.updated_by) END,
     v_admin,
     CASE WHEN TG_OP = 'INSERT' THEN NEW.origin_message_id ELSE NEW.ended_by_message_id END,
     NEW.converted_reservation_id, NEW.version, pg_catalog.now());
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev, ''), true);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.option_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint
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
     AND (NEW.actor_user_id IS NOT DISTINCT FROM OLD.actor_user_id OR NEW.actor_user_id IS NULL)
     AND (NEW.actor_admin_id IS NOT DISTINCT FROM OLD.actor_admin_id OR NEW.actor_admin_id IS NULL)
     AND (NEW.message_id IS NOT DISTINCT FROM OLD.message_id OR NEW.message_id IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'option_history_immutable'
    USING ERRCODE = 'check_violation', DETAIL = 'Opsiyon geçmişi değiştirilemez.';
END
$$;
