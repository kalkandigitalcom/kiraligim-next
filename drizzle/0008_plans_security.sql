-- 0008_plans_security
-- plans ve workspace_subscriptions (0007) için: başlangıç paketi, otomatik deneme aboneliği,
-- mevcut işletmeler için backfill, RLS (ENABLE + FORCE) ve yetkiler. 0007 ile aynı deploy'da,
-- tek transaction'da uygulanır.
--
-- Kararlar (Aşama 2.4a):
--   * İlk paket "Başlangıç": 1 mülk, 14 gün ücretsiz deneme; yeni işletmelere otomatik atanır.
--   * Deneme bitince abonelik "geçerli" sayılmaz (app_subscription_is_current): mevcut mülkler
--     görüntülenir/düzenlenir, yeni mülk eklenemez (mülk limiti tetikleyicisi Aşama 2.4b'de).
--   * Paketler migration ile tanımlanır; uygulama (app_user) paketleri ve abonelikleri YAZAMAZ.

-- ---------------------------------------------------------------------------
-- 1. Yardımcı fonksiyonlar
-- ---------------------------------------------------------------------------
-- UUID v7 (RFC 9562): 48 bit milisaniye zaman damgası + rastgele bitler. PostgreSQL 17'de yerleşik
-- uuidv7() yok; uygulama kimlikleriyle aynı biçim için. Yalnız tetikleyici ve migration kullanır.
CREATE FUNCTION public.app_uuid_v7() RETURNS uuid
  LANGUAGE sql VOLATILE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.encode(
    pg_catalog.set_bit(pg_catalog.set_bit(
      -- overlay/substring SQL-standart söz dizimi şema önekiyle yazılamaz; search_path zaten
      -- pg_catalog ile başladığı için yerleşik fonksiyonlar çözülür.
      overlay(pg_catalog.uuid_send(pg_catalog.gen_random_uuid())
        PLACING substring(
          pg_catalog.int8send(pg_catalog.floor(EXTRACT(epoch FROM pg_catalog.clock_timestamp()) * 1000)::bigint)
          FROM 3)
        FROM 1 FOR 6),
      52, 1), 53, 1),
    'hex')::uuid
$$;
--> statement-breakpoint
-- Abonelik şu an geçerli mi? Tek kaynak: uygulama (src/server/billing) ve Aşama 2.4b'deki mülk
-- limiti tetikleyicisi aynı kuralı kullanır. "trialing" satırı deneme bitince "expired" olarak
-- güncellenmez; geçerlilik her sorguda zamana göre hesaplanır (zamanlanmış iş gerekmez).
CREATE FUNCTION public.app_subscription_is_current(
  p_status text, p_trial_ends_at timestamptz, p_current_period_end timestamptz
) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE p_status
    WHEN 'trialing' THEN p_trial_ends_at IS NOT NULL AND p_trial_ends_at > pg_catalog.now()
    WHEN 'active' THEN p_current_period_end IS NULL OR p_current_period_end > pg_catalog.now()
    ELSE false
  END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_uuid_v7(), public.app_subscription_is_current(text, timestamptz, timestamptz)
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_subscription_is_current(text, timestamptz, timestamptz) TO app_user;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Paket kataloğu (RLS yok: tenant verisi değildir; koruma dar GRANT ile)
-- ---------------------------------------------------------------------------
INSERT INTO public.plans (id, code, name, max_properties, trial_days, is_active, is_default)
VALUES ('01971a00-0000-7000-8000-000000000001', 'baslangic', 'Başlangıç', 1, 14, true, true);
--> statement-breakpoint
CREATE TRIGGER plans_set_updated_at BEFORE UPDATE ON public.plans
  FOR EACH ROW EXECUTE FUNCTION public.app_set_updated_at();
--> statement-breakpoint
GRANT SELECT ON TABLE public.plans TO app_user;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Abonelikler: RLS (ENABLE + FORCE)
-- ---------------------------------------------------------------------------
ALTER TABLE public.workspace_subscriptions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.workspace_subscriptions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER workspace_subscriptions_set_updated_at BEFORE UPDATE ON public.workspace_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.app_set_updated_at();
--> statement-breakpoint
-- Okuma: yalnız bağlamdaki AKTİF işletmenin üyeleri (app_current_member_role askıda NULL döner).
CREATE POLICY subscriptions_select ON public.workspace_subscriptions FOR SELECT TO app_user
  USING (workspace_id = public.app_current_workspace_id()
         AND public.app_current_member_role() IS NOT NULL);
--> statement-breakpoint
-- Belgelenmiş dar istisna: deneme aboneliğini açan SECURITY DEFINER tetikleyici (sahibi
-- app_migrator) ve bu migration'daki backfill, FORCE RLS altında satır ekleyebilsin diye
-- app_migrator'a YALNIZ INSERT ve YALNIZ "trialing" durumu için izin verilir. app_migrator
-- abonelikleri okuyamaz, güncelleyemez, silemez.
CREATE POLICY subscriptions_migrator_trial_insert ON public.workspace_subscriptions
  FOR INSERT TO app_migrator WITH CHECK (status = 'trialing');
--> statement-breakpoint
-- app_user yalnız okur; abonelik oluşturma/değiştirme uygulamaya açık değil.
GRANT SELECT ON TABLE public.workspace_subscriptions TO app_user;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Yeni işletmeye otomatik deneme aboneliği (aynı transaction)
-- ---------------------------------------------------------------------------
-- workspaces'a eklenen her satır için varsayılan paketle deneme aboneliği açar. Tetikleyici
-- workspace INSERT'i ile aynı transaction'da çalışır: abonelik açılamazsa (varsayılan paket yok,
-- kısıt ihlali...) işletme, owner üyeliği ve denetim kaydı da geri alınır.
-- SECURITY DEFINER: app_user abonelik tablosuna yazamaz; satır yalnız buradan oluşur.
CREATE FUNCTION public.app_workspace_start_trial() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_plan_id uuid;
  v_trial_days integer;
BEGIN
  SELECT p.id, p.trial_days INTO v_plan_id, v_trial_days
    FROM public.plans p
   WHERE p.is_default AND p.is_active;
  IF v_plan_id IS NULL THEN
    RAISE EXCEPTION 'default_plan_missing'
      USING ERRCODE = 'object_not_in_prerequisite_state',
            DETAIL = 'Yeni işletmeye atanacak aktif varsayılan paket yok.';
  END IF;
  INSERT INTO public.workspace_subscriptions (id, workspace_id, plan_id, status, trial_ends_at)
  VALUES (public.app_uuid_v7(), NEW.id, v_plan_id, 'trialing',
          pg_catalog.now() + pg_catalog.make_interval(days => v_trial_days));
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_workspace_start_trial() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER workspaces_start_trial AFTER INSERT ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.app_workspace_start_trial();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Mevcut işletmeler için backfill
-- ---------------------------------------------------------------------------
-- workspaces FORCE RLS altında ve app_migrator'ın orada politikası yok; tablo sahibi olarak
-- FORCE yalnız bu transaction içinde kaldırılır, backfill yapılır ve hemen geri konur.
-- Migration tek transaction olduğundan arada hiçbir oturum FORCE'suz tabloyu göremez; hata olursa
-- tamamı geri alınır. Mevcut işletmelere deneme süresi migration anından başlar (geriye dönük
-- kısaltılmaz). Askıdaki işletmeler de abonelik alır (durumları ayrıca korunur).
ALTER TABLE public.workspaces NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO public.workspace_subscriptions (id, workspace_id, plan_id, status, trial_ends_at)
SELECT public.app_uuid_v7(), w.id, p.id, 'trialing',
       pg_catalog.now() + pg_catalog.make_interval(days => p.trial_days)
  FROM public.workspaces w
 CROSS JOIN public.plans p
 WHERE p.is_default AND p.is_active
 ORDER BY w.created_at;
--> statement-breakpoint
ALTER TABLE public.workspaces FORCE ROW LEVEL SECURITY;
