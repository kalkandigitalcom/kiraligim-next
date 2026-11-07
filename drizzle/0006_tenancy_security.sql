-- 0006_tenancy_security
-- workspaces, workspace_members, audit_log (0005) için: bağlam fonksiyonları, RLS (ENABLE + FORCE),
-- politikalar, tetikleyiciler ve yetkiler. 0005 ile aynı deploy'da, tek transaction'da uygulanır;
-- tablolar RLS'siz hâlde hiçbir an kaydedilmez.
--
-- Güven modeli: app.user_id ve app.workspace_id değerlerini uygulama, doğrulanmış oturumdan ve
-- withTenant'ın üyelik kontrolünden sonra transaction'a özel (set_config(..., true)) ayarlar.
-- RLS bu değerlere ek olarak ÜYELİĞİ de kontrol eder; yanlış bir workspace kimliği satır göstermez.
-- Veritabanı app.user_id'nin doğruluğunu kendisi kanıtlayamaz: RLS sorgu hatalarına karşı korur,
-- ele geçirilmiş uygulama koduna karşı değil.

-- ---------------------------------------------------------------------------
-- 1. Bağlam fonksiyonları
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_current_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$ SELECT nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE FUNCTION public.app_current_workspace_id() RETURNS uuid
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$ SELECT nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid $$;
--> statement-breakpoint
-- O anki kullanıcının o anki workspace'teki üyelik rolü, workspace DURUMUNDAN BAĞIMSIZ (yoksa NULL).
-- Parametre almaz; app_user doğrudan çağırsa bile yalnız kendi rolünü öğrenir. SECURITY DEFINER:
-- sahibi app_migrator; members_migrator_lookup politikası sayesinde workspace_members'ı RLS
-- özyinelemesi olmadan okur. Yalnız workspaces_select içinde (durum kontrolü orada) kullanılır;
-- diğer tüm politikalar durumu da denetleyen app_current_member_role()'ü kullanır.
CREATE FUNCTION public.app_current_membership_role() RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT m.role FROM public.workspace_members m
   WHERE m.workspace_id = public.app_current_workspace_id()
     AND m.user_id = public.app_current_user_id()
$$;
--> statement-breakpoint
-- O anki workspace'in henüz HİÇ üyesi yok mu? İlk owner istisnası yalnız bu durumda geçerlidir;
-- böylece kurucu, workspace'ten çıkarıldıktan sonra kendini yeniden owner yapamaz. Parametre
-- almaz (yalnız bağlamdaki workspace). SECURITY DEFINER: diğer üyeleri RLS'den bağımsız sayar.
CREATE FUNCTION public.app_current_workspace_unclaimed() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT public.app_current_workspace_id() IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.workspace_members m
                      WHERE m.workspace_id = public.app_current_workspace_id())
$$;
--> statement-breakpoint
-- O anki kullanıcının rolü; YALNIZ workspace aktifse (askıdaysa NULL). SECURITY INVOKER: durumu
-- app_user olarak, workspaces_select politikası üzerinden okur (o politika aktif olmayan
-- workspace'i zaten göstermez). Özyineleme yok: workspaces_select bu fonksiyonu değil
-- app_current_membership_role()'ü çağırır.
CREATE FUNCTION public.app_current_member_role() RETURNS text
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT public.app_current_membership_role()
   WHERE EXISTS (SELECT 1 FROM public.workspaces w
                  WHERE w.id = public.app_current_workspace_id() AND w.status = 'active')
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_current_user_id(), public.app_current_workspace_id(),
  public.app_current_membership_role(), public.app_current_workspace_unclaimed(),
  public.app_current_member_role() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_current_user_id(), public.app_current_workspace_id(),
  public.app_current_membership_role(), public.app_current_workspace_unclaimed(),
  public.app_current_member_role() TO app_user;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Tetikleyiciler
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$ BEGIN NEW.updated_at := pg_catalog.now(); RETURN NEW; END $$;
--> statement-breakpoint
CREATE TRIGGER workspaces_set_updated_at BEFORE UPDATE ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.app_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER workspace_members_set_updated_at BEFORE UPDATE ON public.workspace_members
  FOR EACH ROW EXECUTE FUNCTION public.app_set_updated_at();
--> statement-breakpoint
-- Son owner koruması: bir workspace'in son owner'ı silinemez ve rolü düşürülemez.
-- SECURITY DEFINER: diğer owner'ları RLS görünürlüğünden bağımsız sayar. Eşzamanlı iki
-- değişikliğin ikisinin de "başka owner var" görmesini önlemek için workspace başına kilit alınır.
-- Kilit, ancak kontrol sorgusu kilitten SONRAKİ commit'leri görürse işe yarar: READ COMMITTED
-- (her sorgu yeni snapshot) ve SERIALIZABLE (SSI çakışmayı serialization hatasıyla durdurur)
-- güvenlidir. REPEATABLE READ (ve diğerleri) eski snapshot'ı okuyup sıfır owner bırakabileceği
-- için owner'ı etkileyen değişiklik bu seviyelerde reddedilir (fail-closed).
CREATE FUNCTION public.app_workspace_members_keep_owner() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.role = 'owner' AND (TG_OP = 'DELETE' OR NEW.role IS DISTINCT FROM 'owner') THEN
    IF pg_catalog.current_setting('transaction_isolation') NOT IN ('read committed', 'serializable') THEN
      RAISE EXCEPTION 'workspace_owner_change_isolation'
        USING ERRCODE = 'invalid_transaction_state',
              DETAIL = 'Owner değişikliği yalnız READ COMMITTED veya SERIALIZABLE transaction içinde yapılabilir.';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(OLD.workspace_id::text, 7001));
    IF NOT EXISTS (
      SELECT 1 FROM public.workspace_members m
       WHERE m.workspace_id = OLD.workspace_id AND m.role = 'owner' AND m.id <> OLD.id
    ) THEN
      RAISE EXCEPTION 'workspace_last_owner'
        USING ERRCODE = 'check_violation',
              DETAIL = 'Bir workspace en az bir owner üyeye sahip olmalıdır.';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER workspace_members_keep_owner BEFORE UPDATE OR DELETE ON public.workspace_members
  FOR EACH ROW EXECUTE FUNCTION public.app_workspace_members_keep_owner();
--> statement-breakpoint
-- Denetim kaydı değiştirilemez (tablo sahibi dahil). Tek istisna: kullanıcı silindiğinde
-- actor_user_id'nin NULL yapılması (ON DELETE SET NULL; KVKK takma adlandırma). İstisna yalnız
-- gerçek FK zincirinde geçerlidir: güncelleme bir tetikleyicinin içinden gelir (FK eylemi users
-- üzerindeki RI tetikleyicisinin çalıştırdığı UPDATE'tir; pg_trigger_depth() > 1), yalnız
-- actor_user_id değişir ve o kullanıcı artık users tablosunda yoktur. Doğrudan bir UPDATE ile
-- (tablo sahibi veya süper kullanıcı dahil) var olan bir kullanıcının izi silinemez.
CREATE FUNCTION public.app_audit_log_immutable() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND pg_catalog.pg_trigger_depth() > 1
     AND OLD.actor_user_id IS NOT NULL AND NEW.actor_user_id IS NULL
     AND (to_jsonb(NEW) - 'actor_user_id') = (to_jsonb(OLD) - 'actor_user_id')
     AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = OLD.actor_user_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_log_immutable'
    USING ERRCODE = 'insufficient_privilege', DETAIL = 'Denetim kaydı değiştirilemez veya silinemez.';
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION public.app_audit_log_immutable();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON public.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.app_audit_log_immutable();
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_set_updated_at(), public.app_workspace_members_keep_owner(),
  public.app_audit_log_immutable() FROM PUBLIC;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. RLS (ENABLE + FORCE)
-- ---------------------------------------------------------------------------
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.workspaces FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.workspace_members FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.audit_log FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Belgelenmiş tek istisna: SECURITY DEFINER fonksiyonlar (sahibi app_migrator) üyelikleri
-- okuyabilsin diye app_migrator'a YALNIZ workspace_members üzerinde YALNIZ SELECT açılır.
-- Diğer tüm tablolarda FORCE RLS tablo sahibini de kapsamaya devam eder.
CREATE POLICY members_migrator_lookup ON public.workspace_members
  FOR SELECT TO app_migrator USING (true);
--> statement-breakpoint

-- workspace_members: bağlam yokken yalnız kendi üyelikleri; bağlam varken yalnız o workspace'in
-- üyeleri ve yalnız kullanıcı oraya üyeyse.
CREATE POLICY members_select ON public.workspace_members FOR SELECT TO app_user USING (
  CASE WHEN public.app_current_workspace_id() IS NULL
       THEN user_id = public.app_current_user_id()
       ELSE workspace_id = public.app_current_workspace_id()
            AND public.app_current_member_role() IS NOT NULL
  END);
--> statement-breakpoint
-- owner her rolü ekler; manager yalnız staff ekler; ilk owner: workspace'i oluşturan kullanıcı,
-- kendisini, owner olarak, workspace'in henüz HİÇ üyesi yokken (yalnız oluşturma anı).
CREATE POLICY members_insert ON public.workspace_members FOR INSERT TO app_user WITH CHECK (
  workspace_id = public.app_current_workspace_id()
  AND (
    public.app_current_member_role() = 'owner'
    OR (public.app_current_member_role() = 'manager' AND role = 'staff')
    OR (role = 'owner'
        AND user_id = public.app_current_user_id()
        AND public.app_current_workspace_unclaimed()
        AND EXISTS (SELECT 1 FROM public.workspaces w
                     WHERE w.id = workspace_id AND w.created_by = public.app_current_user_id()))
  ));
--> statement-breakpoint
CREATE POLICY members_update ON public.workspace_members FOR UPDATE TO app_user
  USING (workspace_id = public.app_current_workspace_id() AND public.app_current_member_role() = 'owner')
  WITH CHECK (workspace_id = public.app_current_workspace_id());
--> statement-breakpoint
CREATE POLICY members_delete ON public.workspace_members FOR DELETE TO app_user
  USING (workspace_id = public.app_current_workspace_id() AND public.app_current_member_role() = 'owner');
--> statement-breakpoint

-- workspaces: bağlam yokken kendi üyelikleri (askıdakiler dahil; seçim listesi durumu gösterir);
-- bağlam varken yalnız AKTİF workspace ve yalnız üyeye — ya da henüz hiç üyesi olmayan
-- workspace'i oluşturan kullanıcıya (oluşturma anı).
CREATE POLICY workspaces_select ON public.workspaces FOR SELECT TO app_user USING (
  CASE WHEN public.app_current_workspace_id() IS NULL
       THEN id IN (SELECT m.workspace_id FROM public.workspace_members m
                    WHERE m.user_id = public.app_current_user_id())
       ELSE id = public.app_current_workspace_id()
            AND status = 'active'
            AND (public.app_current_membership_role() IS NOT NULL
                 OR (created_by = public.app_current_user_id()
                     AND public.app_current_workspace_unclaimed()))
  END);
--> statement-breakpoint
CREATE POLICY workspaces_insert ON public.workspaces FOR INSERT TO app_user WITH CHECK (
  id = public.app_current_workspace_id() AND created_by = public.app_current_user_id());
--> statement-breakpoint
CREATE POLICY workspaces_update ON public.workspaces FOR UPDATE TO app_user
  USING (id = public.app_current_workspace_id() AND public.app_current_member_role() = 'owner')
  WITH CHECK (id = public.app_current_workspace_id());
--> statement-breakpoint

-- audit_log: okuma owner/manager; yazma yalnız kendi adına ve üyesi olduğu workspace için
-- (workspace dışı olaylar yalnız bağlam yokken).
CREATE POLICY audit_log_select ON public.audit_log FOR SELECT TO app_user USING (
  workspace_id = public.app_current_workspace_id()
  AND public.app_current_member_role() IN ('owner', 'manager'));
--> statement-breakpoint
CREATE POLICY audit_log_insert ON public.audit_log FOR INSERT TO app_user WITH CHECK (
  actor_user_id = public.app_current_user_id()
  AND (
    (workspace_id = public.app_current_workspace_id() AND public.app_current_member_role() IS NOT NULL)
    OR (workspace_id IS NULL AND public.app_current_workspace_id() IS NULL)
  ));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Yetkiler (kolon düzeyinde; PUBLIC / app_admin / app_worker: hiçbiri)
-- ---------------------------------------------------------------------------
-- workspaces: durum (status) yalnız platform yönetimi tarafından değiştirilecek (Aşama 2.3).
GRANT SELECT ON TABLE public.workspaces TO app_user;
--> statement-breakpoint
GRANT INSERT (id, name, slug, created_by) ON TABLE public.workspaces TO app_user;
--> statement-breakpoint
GRANT UPDATE (name, slug) ON TABLE public.workspaces TO app_user;
--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE public.workspace_members TO app_user;
--> statement-breakpoint
GRANT INSERT (id, workspace_id, user_id, role) ON TABLE public.workspace_members TO app_user;
--> statement-breakpoint
GRANT UPDATE (role) ON TABLE public.workspace_members TO app_user;
--> statement-breakpoint
-- audit_log: yalnız okuma ve ekleme; zaman damgası (occurred_at) veritabanında belirlenir.
GRANT SELECT ON TABLE public.audit_log TO app_user;
--> statement-breakpoint
GRANT INSERT (id, workspace_id, actor_user_id, action, target_type, target_id, metadata)
  ON TABLE public.audit_log TO app_user;
