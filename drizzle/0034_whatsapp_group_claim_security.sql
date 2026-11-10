-- 0034_whatsapp_group_claim_security (WhatsApp Asistanı A1.1: kodsuz grup eşleştirme)
--
-- Yeni akış: villa sahibi Kiraligim asistan numarasını kendi grubuna ekler; gruba hiçbir kod veya
-- komut yazmaz. Grubun KİME ait olduğu şöyle kanıtlanır:
--   1. Kullanıcı WhatsApp numarasını BİR KEZ doğrular: panelde üretilen kodu asistana ÖZEL mesajla
--      gönderir (wa.me bağlantısıyla tek dokunuş). Ağ geçidi gönderenin numarasını WhatsApp'tan alır
--      (app_wa_verify_phone). Numara düz metin saklanmaz: sha256('wa-phone:' || rakamlar).
--   2. Ağ geçidi gruba katıldığında asistanı EKLEYEN kişinin (author) ve grup kurucusunun (owner)
--      numara özetlerini kaydeder (app_wa_sync_group, 9 parametreli sürüm). Grup "discovered" kalır;
--      hiçbir işletmeye görünmez, mesajı kaydedilmez.
--   3. Panelde "Bekleyen gruplar" YALNIZ oturumdaki kullanıcının doğrulanmış numarasıyla eşleşen
--      grupları gösterir (app_wa_pending_groups). Eşleştirme (app_wa_claim_group) aynı denetimi
--      sunucuda tekrarlar; ayrıca kullanıcı bu işletmede owner veya yetkili manager olmalı ve villa
--      bu işletmenin olmalı (bileşik yabancı anahtar). Bağlı grup başka işletmeye geçemez.
--
-- Mevcut tablolara dokunulmaz (yalnız 0033'teki yeni kolonlar). Rezervasyon, fiyat ve iCal
-- nesnelerine referans yoktur. Eski kodlu bağlama (wa_link_codes, app_wa_redeem_link_code) ve eski
-- fonksiyon imzaları geriye uyumluluk için KORUNUR: canlıdaki eski ağ geçidi sürümü güncellenene
-- kadar çalışmaya devam eder.
--
-- Geri alma (veri kaybı: doğrulanmış numaralar ve doğrulama kodları):
--   DROP FUNCTION app_wa_heartbeat(text, text, text, text),
--     app_wa_sync_group(uuid, text, text, integer, boolean, boolean, boolean, text, text),
--     app_wa_verify_phone(text, text), app_wa_pending_groups(), app_wa_claim_group(uuid, uuid),
--     app_wa_phone_hash(text);
--   ve app_wa_unlink_group'u 0031'deki tanımına döndürün; DROP TABLE wa_phone_challenges,
--   wa_verified_phones; 0033'teki kolonlar ileri bir migration ile kaldırılır.

-- ---------------------------------------------------------------------------
-- 1. RLS (yeni tablolar)
-- ---------------------------------------------------------------------------
ALTER TABLE public.wa_verified_phones ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.wa_verified_phones FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.wa_phone_challenges ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.wa_phone_challenges FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Telefon özeti (tek yerde): sha256('wa-phone:' || rakamlar), hex. Yalnız fonksiyonlar kullanır.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_wa_phone_hash(p_pn text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('wa-phone:' || p_pn, 'UTF8')), 'hex')
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_wa_phone_hash(text) FROM PUBLIC;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. app_user politikaları ve kolon yetkileri
-- ---------------------------------------------------------------------------
-- Kullanıcı yalnız KENDİ doğrulanmış numarasının maskeli hâlini görür ve kaldırabilir.
CREATE POLICY wa_verified_phones_select ON public.wa_verified_phones FOR SELECT TO app_user
  USING (user_id = public.app_current_user_id());
--> statement-breakpoint
CREATE POLICY wa_verified_phones_delete ON public.wa_verified_phones FOR DELETE TO app_user
  USING (user_id = public.app_current_user_id());
--> statement-breakpoint
-- Doğrulama kodunu yalnız işletmede owner / yetkili manager olan kullanıcı kendisi için üretir.
CREATE POLICY wa_phone_challenges_select ON public.wa_phone_challenges FOR SELECT TO app_user
  USING (user_id = public.app_current_user_id());
--> statement-breakpoint
CREATE POLICY wa_phone_challenges_insert ON public.wa_phone_challenges FOR INSERT TO app_user
  WITH CHECK (user_id = public.app_current_user_id()
              AND workspace_id = public.app_current_workspace_id()
              AND public.app_wa_can_manage());
--> statement-breakpoint
GRANT SELECT (user_id, phone_masked, verified_at), DELETE ON TABLE public.wa_verified_phones TO app_user;
--> statement-breakpoint
GRANT SELECT (id, user_id, workspace_id, expires_at, used_at, created_at),
  INSERT (id, user_id, workspace_id, code_salt, code_hash, expires_at)
  ON TABLE public.wa_phone_challenges TO app_user;
--> statement-breakpoint
-- Yeni kolonlar: villa ve platform numarası panelde okunur; villa yalnız bağlı/askıdaki grupta
-- değiştirilebilir (wa_groups_update politikası + bileşik yabancı anahtar). Numara özetleri gizli.
GRANT SELECT (property_id) ON TABLE public.wa_groups TO app_user;
--> statement-breakpoint
GRANT UPDATE (property_id) ON TABLE public.wa_groups TO app_user;
--> statement-breakpoint
GRANT SELECT (account_pn) ON TABLE public.wa_connections TO app_user;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. app_migrator: yalnız fonksiyonların açtığı app.wa_fn ayarıyla
-- ---------------------------------------------------------------------------
CREATE POLICY wa_verified_phones_wa_fn ON public.wa_verified_phones FOR ALL TO app_migrator
  USING (pg_catalog.current_setting('app.wa_fn', true) = 'on')
  WITH CHECK (pg_catalog.current_setting('app.wa_fn', true) = 'on');
--> statement-breakpoint
CREATE POLICY wa_phone_challenges_wa_fn ON public.wa_phone_challenges FOR ALL TO app_migrator
  USING (pg_catalog.current_setting('app.wa_fn', true) = 'on')
  WITH CHECK (pg_catalog.current_setting('app.wa_fn', true) = 'on');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Ağ geçidi: kalp atışı + platform numarası (4 parametreli sürüm; 3 parametreli korunur)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.app_wa_heartbeat(p_label text, p_status text, p_error text, p_account_pn text)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.wa_fn', true);
  v_id uuid;
BEGIN
  IF p_account_pn IS NOT NULL AND p_account_pn !~ '^[1-9][0-9]{6,19}$' THEN
    RAISE EXCEPTION 'wa_heartbeat_invalid' USING ERRCODE = 'check_violation';
  END IF;
  v_id := public.app_wa_heartbeat(p_label, p_status, p_error);
  IF p_account_pn IS NOT NULL THEN
    PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
    UPDATE public.wa_connections SET account_pn = p_account_pn
     WHERE id = v_id AND account_pn IS DISTINCT FROM p_account_pn;
    PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev, ''), true);
  END IF;
  RETURN v_id;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. Ağ geçidi: grup keşfi + ekleyen/kurucu numara özetleri (9 parametreli sürüm)
-- ---------------------------------------------------------------------------
-- Durum kuralları 7 parametreli sürümle AYNIDIR (o çağrılır). Özetler yalnız verildiğinde yazılır
-- (boş değer eskiyi silmez). Bağlı grubun işletmesi burada ASLA değişmez.
CREATE FUNCTION public.app_wa_sync_group(
  p_connection uuid, p_jid text, p_subject text, p_participants integer,
  p_bot_is_admin boolean, p_admins_only boolean, p_present boolean,
  p_added_by_pn text, p_owner_pn text)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.wa_fn', true);
  v_status text;
BEGIN
  IF (p_added_by_pn IS NOT NULL AND p_added_by_pn !~ '^[1-9][0-9]{6,19}$')
     OR (p_owner_pn IS NOT NULL AND p_owner_pn !~ '^[1-9][0-9]{6,19}$') THEN
    RAISE EXCEPTION 'wa_sync_invalid' USING ERRCODE = 'check_violation';
  END IF;
  v_status := public.app_wa_sync_group(p_connection, p_jid, p_subject, p_participants,
                                       p_bot_is_admin, p_admins_only, p_present);
  IF p_added_by_pn IS NOT NULL OR p_owner_pn IS NOT NULL THEN
    PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
    UPDATE public.wa_groups
       SET added_by_hash = coalesce(public.app_wa_phone_hash(p_added_by_pn), added_by_hash),
           owner_hash = coalesce(public.app_wa_phone_hash(p_owner_pn), owner_hash)
     WHERE connection_id = p_connection AND jid = p_jid;
    PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev, ''), true);
  END IF;
  RETURN v_status;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. Ağ geçidi: numara doğrulama (asistana ÖZEL mesajla gelen kod)
-- ---------------------------------------------------------------------------
-- Dönüş: verified | invalid | sender_unknown. Kod tek kullanımlık; numara başka bir kullanıcıda
-- doğrulanmışsa yeni doğrulayana geçer (numarayı kontrol eden kişi kanıtlanmıştır).
CREATE FUNCTION public.app_wa_verify_phone(p_code text, p_sender_pn text)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.wa_fn', true);
  v_now timestamptz := pg_catalog.clock_timestamp();
  c record;
  v_hash text;
  v_out text;
BEGIN
  IF p_code IS NULL OR p_code !~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{8}$'
     OR (p_sender_pn IS NOT NULL AND p_sender_pn !~ '^[1-9][0-9]{6,19}$') THEN
    RAISE EXCEPTION 'wa_verify_invalid' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  SELECT * INTO c FROM public.wa_phone_challenges pc
   WHERE pc.used_at IS NULL AND pc.expires_at > v_now
     AND pc.code_hash = pg_catalog.encode(pg_catalog.sha256(
           pg_catalog.convert_to(pc.code_salt || ':' || p_code, 'UTF8')), 'hex')
   ORDER BY pc.created_at DESC
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN
    v_out := 'invalid';
  ELSIF p_sender_pn IS NULL THEN
    v_out := 'sender_unknown';  -- kod tüketilmez; gönderen numarası çözülemedi
  ELSE
    v_hash := public.app_wa_phone_hash(p_sender_pn);
    UPDATE public.wa_phone_challenges SET used_at = v_now WHERE id = c.id;
    DELETE FROM public.wa_verified_phones WHERE phone_hash = v_hash AND user_id <> c.user_id;
    INSERT INTO public.wa_verified_phones AS v (user_id, phone_hash, phone_masked, verified_at)
    VALUES (c.user_id, v_hash,
            '+' || pg_catalog.left(p_sender_pn, 2) || ' ' || pg_catalog.substr(p_sender_pn, 3, 3)
              || ' *** ** ' || pg_catalog.right(p_sender_pn, 2),
            v_now)
    ON CONFLICT (user_id) DO UPDATE
       SET phone_hash = EXCLUDED.phone_hash, phone_masked = EXCLUDED.phone_masked,
           verified_at = EXCLUDED.verified_at;
    INSERT INTO public.audit_log (id, workspace_id, actor_user_id, action, target_type,
                                  target_id, metadata)
    VALUES (pg_catalog.gen_random_uuid(), c.workspace_id, c.user_id, 'whatsapp.phone_verified',
            'user', c.user_id, '{}'::jsonb);
    v_out := 'verified';
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
-- 8. Panel: bekleyen gruplar (yalnız oturumdaki kullanıcının doğrulanmış numarasıyla eşleşenler)
-- ---------------------------------------------------------------------------
-- Kullanıcı bu işletmede owner veya yetkili manager değilse boş döner. Numara özetleri döndürülmez.
CREATE FUNCTION public.app_wa_pending_groups()
  RETURNS TABLE (id uuid, subject text, participant_count integer, first_seen_at timestamptz,
                 match text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.wa_fn', true);
  v_user uuid := public.app_current_user_id();
  v_hash text;
BEGIN
  IF v_user IS NULL OR public.app_current_workspace_id() IS NULL THEN
    RETURN;
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  IF public.app_wa_can_manage() THEN
    SELECT vp.phone_hash INTO v_hash FROM public.wa_verified_phones vp WHERE vp.user_id = v_user;
    IF v_hash IS NOT NULL THEN
      RETURN QUERY
        SELECT g.id, g.subject, g.participant_count, g.first_seen_at,
               CASE WHEN g.added_by_hash = v_hash THEN 'added_by' ELSE 'owner' END
          FROM public.wa_groups g
         WHERE g.status = 'discovered' AND g.workspace_id IS NULL
           AND (g.added_by_hash = v_hash OR g.owner_hash = v_hash)
         ORDER BY g.first_seen_at DESC, g.id
         LIMIT 100;
    END IF;
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.wa_fn', coalesce(v_prev, ''), true);
  RAISE;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 9. Panel: grubu bir villayla eşleştir
-- ---------------------------------------------------------------------------
-- Dönüş: linked | forbidden | not_verified | not_found | property_not_found.
-- "not_found": grup yok, bu kullanıcının numarasıyla eşleşmiyor ya da zaten bir işletmeye bağlı
-- (başka işletmenin grubunun varlığı sızdırılmaz). Villa bu işletmenin olmalı (bileşik FK).
CREATE FUNCTION public.app_wa_claim_group(p_group uuid, p_property uuid)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.wa_fn', true);
  v_ws uuid := public.app_current_workspace_id();
  v_user uuid := public.app_current_user_id();
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_hash text;
  g record;
  v_out text;
BEGIN
  IF v_ws IS NULL OR v_user IS NULL OR p_group IS NULL OR p_property IS NULL THEN
    RETURN 'forbidden';
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  IF NOT public.app_wa_can_manage() THEN
    v_out := 'forbidden';
  ELSE
    SELECT vp.phone_hash INTO v_hash FROM public.wa_verified_phones vp WHERE vp.user_id = v_user;
    IF v_hash IS NULL THEN
      v_out := 'not_verified';
    ELSE
      SELECT * INTO g FROM public.wa_groups wg WHERE wg.id = p_group FOR UPDATE;
      IF NOT FOUND OR g.status <> 'discovered' OR g.workspace_id IS NOT NULL
         OR NOT (g.added_by_hash IS NOT DISTINCT FROM v_hash OR g.owner_hash IS NOT DISTINCT FROM v_hash) THEN
        v_out := 'not_found';
      ELSE
        BEGIN
          UPDATE public.wa_groups
             SET status = 'linked', workspace_id = v_ws, property_id = p_property,
                 linked_at = v_now, linked_by = v_user,
                 link_fail_count = 0, link_fail_window_at = NULL
           WHERE id = g.id;
          INSERT INTO public.audit_log (id, workspace_id, actor_user_id, action, target_type,
                                        target_id, metadata)
          VALUES (pg_catalog.gen_random_uuid(), v_ws, v_user, 'whatsapp.group_linked',
                  'whatsapp_group', g.id,
                  pg_catalog.jsonb_build_object('method', 'claim', 'property', p_property));
          v_out := 'linked';
        EXCEPTION WHEN foreign_key_violation THEN
          v_out := 'property_not_found';
        END;
      END IF;
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
-- 10. Panel: bağlantıyı kesme — villa bağı da temizlenir (0031'deki tanım + property_id)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_wa_unlink_group(p_group uuid)
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
             workspace_id = NULL, property_id = NULL, linked_at = NULL, linked_by = NULL,
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
-- 11. Saklama: süresi dolan doğrulama kodları da silinir (0032 tanımı + wa_phone_challenges)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_wa_purge_messages(p_days integer)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_prev text := pg_catalog.current_setting('app.wa_fn', true);
  v_count integer;
BEGIN
  -- Alt sınır: uygulama sabiti WA_RETENTION_DAYS = 90. Üst sınır 365.
  IF p_days IS NULL OR p_days < 90 OR p_days > 365 THEN
    RAISE EXCEPTION 'wa_purge_invalid' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.set_config('app.wa_fn', 'on', true);
  DELETE FROM public.wa_inbound_messages
   WHERE received_at < pg_catalog.now() - pg_catalog.make_interval(days => p_days);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  DELETE FROM public.wa_link_codes
   WHERE coalesce(used_at, expires_at) < pg_catalog.now() - interval '7 days';
  DELETE FROM public.wa_phone_challenges
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
-- 12. EXECUTE yetkileri
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.app_wa_heartbeat(text, text, text, text),
  public.app_wa_sync_group(uuid, text, text, integer, boolean, boolean, boolean, text, text),
  public.app_wa_verify_phone(text, text),
  public.app_wa_pending_groups(),
  public.app_wa_claim_group(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
-- Ağ geçidi fonksiyonları app_user'a da açık (Mac'te geliştirme; 0031 ile aynı model).
GRANT EXECUTE ON FUNCTION public.app_wa_heartbeat(text, text, text, text),
  public.app_wa_sync_group(uuid, text, text, integer, boolean, boolean, boolean, text, text),
  public.app_wa_verify_phone(text, text),
  public.app_wa_pending_groups(),
  public.app_wa_claim_group(uuid, uuid) TO app_user;
--> statement-breakpoint
-- Ayrı ağ geçidi rolü varsa (production: scripts/wa-gateway-role.sql) yeni ağ geçidi fonksiyonları
-- ona da verilir; panel fonksiyonları (pending/claim) VERİLMEZ. Rol yoksa (test, yeni kurulum) atlanır.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_wa_gateway') THEN
    GRANT EXECUTE ON FUNCTION public.app_wa_heartbeat(text, text, text, text),
      public.app_wa_sync_group(uuid, text, text, integer, boolean, boolean, boolean, text, text),
      public.app_wa_verify_phone(text, text)
      TO app_wa_gateway;
  END IF;
END
$$;
